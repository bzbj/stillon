import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentProvider } from "../shared/types"
import type { CliRelease, CliUpdateOperation, ProviderCliUpdateStatus } from "../shared/provider-cli-updates"
import { discoverCodexModels } from "./codex-model-discovery"
import { inspectCliInstallation, newerCliVersion, npmUpdateCommand, stableCliVersion, type CliInstallation } from "./provider-cli-installation"
import { runCliInstaller, type CliInstallerLifecycle } from "./provider-cli-installer"
import { CliUpdateJournals, cliInstallerAlive, type CliUpdateJournal } from "./provider-cli-journal"

const repositories = { codex: "openai/codex", claude: "anthropics/claude-code" } as const
export async function readCliRelease(provider: AgentProvider): Promise<CliRelease> {
  const response = await fetch(`https://api.github.com/repos/${repositories[provider]}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error("Release information is unavailable. Try checking again later.")
  const body = await response.text()
  if (body.length > 2 * 1024 * 1024) throw new Error("Invalid release information.")
  const data = JSON.parse(body)
  const version = String(data.tag_name).replace(provider === "codex" ? /^rust-v/u : /^v/u, "")
  if (data.draft || data.prerelease || !stableCliVersion(version) || !Number.isFinite(Date.parse(data.published_at))) throw new Error("Invalid release information.")
  return { version, publishedAt: new Date(data.published_at).toISOString(), url: `https://github.com/${repositories[provider]}/releases/tag/${provider === "codex" ? "rust-v" : "v"}${version}` }
}

export interface ProviderCliUpdatesOptions {
  journalDirectory?: string
  getEnvironment: () => Promise<NodeJS.ProcessEnv>
  /** Must synchronously reserve the agent before awaiting process shutdown. */
  reserve: () => Promise<() => void>
  inspect?: (provider: AgentProvider, environment: NodeJS.ProcessEnv) => Promise<CliInstallation>
  release?: (provider: AgentProvider) => Promise<CliRelease>
  install?: (provider: AgentProvider, installation: CliInstallation, version: string, environment: NodeJS.ProcessEnv, lifecycle?: CliInstallerLifecycle) => Promise<void>
  verify?: (provider: AgentProvider, installation: CliInstallation, environment: NodeJS.ProcessEnv) => Promise<void>
}

export async function installCli(provider: AgentProvider, installation: CliInstallation, version: string, env: NodeJS.ProcessEnv, lifecycle?: CliInstallerLifecycle) {
  if (!stableCliVersion(version)) throw new Error("Invalid release version.")
  if (installation.method?.kind === "npm") {
    const { command, args } = await npmUpdateCommand(env, installation.method.prefix, provider, version)
    await runCliInstaller(command, args, env, lifecycle)
  } else if (installation.method?.kind === "native" && provider === "claude") {
    await runCliInstaller(installation.executable!, ["install", version], { ...env, DISABLE_AUTOUPDATER: "1" }, lifecycle)
  } else if (installation.method?.kind === "native" && provider === "codex") {
    // Only the previously identified native installation is eligible. The
    // official installer receives an exact version and the existing bin dir.
    const windows = process.platform === "win32"
    const response = await fetch(`https://chatgpt.com/codex/install.${windows ? "ps1" : "sh"}`, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error("The official installer could not be downloaded.")
    const script = await response.text()
    if (script.length > 1024 * 1024) throw new Error("Invalid installer response.")
    const directory = await mkdtemp(path.join(tmpdir(), "stillon-cli-update-"))
    try {
      const file = path.join(directory, `install.${windows ? "ps1" : "sh"}`)
      await writeFile(file, script, { mode: 0o600 })
      const command = windows ? path.win32.join(env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe") : "/bin/sh"
      const args = windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, "-Release", version] : [file, "--release", version]
      await runCliInstaller(command, args, { ...env, CODEX_INSTALL_DIR: installation.method.binDir, CODEX_NON_INTERACTIVE: "1", CODEX_INSTALL_DAEMON_ONLY: "0", CODEX_INSTALL_DEFER_SELECTION: "0" }, lifecycle)
    } finally { await rm(directory, { recursive: true, force: true }) }
  } else throw new Error("Update this installation with its original installer.")
}

export async function verifyCli(provider: AgentProvider, installation: CliInstallation, environment: NodeJS.ProcessEnv) {
  if (provider !== "codex") return
  // This is a fresh metadata-only process using the exact selected executable;
  // it never starts an inference turn or changes the saved model selection.
  const catalog = await discoverCodexModels({ environment: { ...environment, CODEX_EXECUTABLE: installation.executable } })
  if (catalog.cliVersion !== installation.version) throw new Error("Codex App Server reported a different version. Check the installation before starting new work.")
}

interface CliUpdatePlan {
  token: string; identity: string; current?: string; target: string; expires: number
  kind: "update" | "repair"
  recoveryId?: string
}

const configuredExecutable = (provider: AgentProvider, environment: NodeJS.ProcessEnv) =>
  environment[provider === "codex" ? "CODEX_EXECUTABLE" : "CLAUDE_EXECUTABLE"]?.trim() || undefined

export class ProviderCliUpdates {
  private releases = new Map<AgentProvider, { value: CliRelease; expires: number }>()
  private plans = new Map<AgentProvider, CliUpdatePlan>()
  private records = new Map<AgentProvider, CliUpdateJournal>()
  private journals: CliUpdateJournals
  private ready?: Promise<void>
  private recoveryError?: string
  private running: Promise<void> | null = null
  private closed = false
  private inspect: NonNullable<ProviderCliUpdatesOptions["inspect"]>
  constructor(private options: ProviderCliUpdatesOptions) {
    this.inspect = options.inspect ?? inspectCliInstallation
    this.journals = new CliUpdateJournals(options.journalDirectory)
  }
  get busy() { return this.running !== null || [...this.records.values()].some(record => record.installerPid && cliInstallerAlive(record.installerPid)) }

  private unresolvedInstaller() {
    return [...this.records.values()].some(record => record.recoveryBlocked || (record.installerPid && cliInstallerAlive(record.installerPid)))
  }

  initialize() {
    return this.ready ??= (async () => {
      try {
        for (const provider of ["codex", "claude"] as const) {
          const record = await this.journals.read(provider)
          if (record) this.records.set(provider, record)
        }
      } catch { this.recoveryError = "The CLI update recovery record could not be read. Check the local data directory before updating." }
    })()
  }

  private async latest(provider: AgentProvider, force: boolean) {
    const cached = this.releases.get(provider)
    if (!force && cached && cached.expires > Date.now()) return cached.value
    const value = await (this.options.release ?? readCliRelease)(provider)
    this.releases.set(provider, { value, expires: Date.now() + 10 * 60_000 })
    return value
  }

  private sameSelection(record: CliUpdateJournal, current: CliInstallation, env: NodeJS.ProcessEnv) {
    if (record.configuredExecutable !== configuredExecutable(record.provider, env)) return false
    if (current.executable && current.executable !== record.installation.executable) return false
    const original = record.installation.method, selected = current.method
    if (selected && JSON.stringify(selected) !== JSON.stringify(original)) return false
    return !current.version || current.version === record.installation.version || current.version === record.operation.targetVersion
  }

  private plan(provider: AgentProvider, installation: CliInstallation, target: string, kind: CliUpdatePlan["kind"], recoveryId?: string) {
    let plan = this.plans.get(provider)
    if (!plan || plan.identity !== installation.identity || plan.current !== installation.version || plan.target !== target || plan.kind !== kind || plan.recoveryId !== recoveryId || plan.expires <= Date.now()) {
      plan = { token: randomUUID(), identity: installation.identity, current: installation.version, target, kind, recoveryId, expires: Date.now() + 10 * 60_000 }
      this.plans.set(provider, plan)
    }
    return plan.token
  }

  async status(provider: AgentProvider, refresh = false): Promise<ProviderCliUpdateStatus> {
    await this.initialize()
    const environment = await this.options.getEnvironment()
    const installation = await this.inspect(provider, environment)
    const record = this.records.get(provider)
    const status: ProviderCliUpdateStatus = { provider, executable: installation.executable, currentVersion: installation.version,
      installation: installation.label, automaticUpdates: installation.automaticUpdates, updateAvailable: false,
      reason: this.recoveryError ?? installation.reason, operation: record ? { ...record.operation } : undefined }
    try { status.latest = await this.latest(provider, refresh) }
    catch { status.releaseError = "Could not check releases. Check again later; the CLI recovery record is kept." }
    const installerPending = record?.installerPid && cliInstallerAlive(record.installerPid)
    const available = !this.busy && !this.closed && !this.recoveryError && !this.unresolvedInstaller()
    const recoverable = record?.phase === "failed" && !record.recoveryBlocked && record.installation.method?.kind === "npm"
      && !installerPending && this.sameSelection(record, installation, environment)
    if (record?.recoveryBlocked) status.reason = "An interrupted installer could still be running. Finish it, repair with the original installer, then restart StillOn to verify the repair."
    else if (installerPending && !this.busy) status.reason = "The previous CLI installer is still running. Wait for it to finish and check again."
    if (!installation.version && (recoverable || installation.damaged)) {
      const target = recoverable ? record.operation.targetVersion : status.latest?.version
      if (available && target && (recoverable || installation.method?.kind === "npm")) {
        status.repairVersion = target
        status.repairToken = this.plan(provider, installation, target, "repair", recoverable ? record.operation.id : undefined)
      }
    } else if (status.latest && installation.version && newerCliVersion(status.latest.version, installation.version)) {
      status.updateAvailable = true
      if (available && installation.method) status.updateToken = this.plan(provider, installation, status.latest.version, "update")
    }
    return status
  }

  private async perform(record: CliUpdateJournal, environment: NodeJS.ProcessEnv, install: boolean) {
    const { provider, installation: before, operation } = record
    let verifying = false
    try {
      while (true) {
        let installerError: unknown
        if (install) {
          verifying = false
          record.phase = "installing"; record.attempts++; record.installerPid = undefined
          operation.attempts = record.attempts
          operation.message = `${record.attempts > 1 ? "Repairing" : "Installing"} ${operation.targetVersion}… Large CLI packages may take several minutes. New agent work is paused.`
          await this.journals.write(record)
          try {
            await (this.options.install ?? installCli)(provider, before, operation.targetVersion, environment, {
              onSpawn: async pid => { record.installerPid = pid; await this.journals.write(record) },
            })
          } catch (error) { installerError = error }
        }
        record.installerPid = undefined
        record.phase = "verifying"
        operation.message = "Verifying the CLI version and fresh agent server…"
        await this.journals.write(record)
        const afterEnvironment = await this.options.getEnvironment()
        const after = await this.inspect(provider, afterEnvironment)
        if (after.executable === before.executable && after.version === operation.targetVersion && this.sameSelection(record, after, afterEnvironment)) {
          verifying = true
          await (this.options.verify ?? verifyCli)(provider, after, afterEnvironment)
          record.phase = "succeeded"; record.recoveryBlocked = undefined; operation.state = "succeeded"
          operation.message = provider === "codex" ? `Updated to ${operation.targetVersion}. CLI, fresh App Server and model discovery verified.` : `Updated to ${operation.targetVersion}. CLI version verified; new sessions use this version.`
          await this.journals.write(record)
          return
        }
        // Retry only a broken npm installation, once, at the original path and
        // exact consented version. A working older/different CLI is never replaced.
        if (!record.recoveryBlocked && before.method?.kind === "npm" && !after.version && record.attempts < 2 && this.sameSelection(record, after, afterEnvironment)) {
          environment = afterEnvironment; install = true; continue
        }
        throw installerError ?? new Error("Selection or version changed.")
      }
    } catch (error) {
      record.phase = "failed"; operation.state = "failed"
      // Do not persist or expose installer output, credentials or environment.
      const code = (error as { code?: unknown } | null)?.code
      const diagnostic = typeof code === "number" ? `Installer exit code ${code}. `
        : code === "EACCES" || code === "EPERM" ? "Permission denied. "
          : code === "ENOENT" ? "The original installer or a required executable was not found. " : ""
      operation.message = verifying
        ? "The installer finished, but verification failed. Check the displayed CLI path/version and sign-in; for Codex, retry Discover Models. No alternate CLI was selected."
        : `Update failed. ${diagnostic}Check disk space, permissions and network access. If the CLI is incomplete, choose Repair CLI or use its original installer. No alternate CLI was selected.`
      await this.journals.write(record)
    }
  }

  async start(provider: AgentProvider, token: string): Promise<CliUpdateOperation> {
    await this.initialize()
    if (this.closed) throw new Error("StillOn is shutting down.")
    if (this.busy) throw new Error("Another CLI update is in progress.")
    if (this.recoveryError) throw new Error(this.recoveryError)
    if (this.unresolvedInstaller()) throw new Error("The previous CLI installer must finish before another update can start.")
    const plan = this.plans.get(provider)
    if (!plan || plan.token !== token || plan.expires <= Date.now()) throw new Error("The update information expired. Check for updates again.")
    let complete!: () => void
    this.running = new Promise<void>(resolve => { complete = resolve })
    let release: (() => void) | undefined
    try {
      release = await this.options.reserve()
      const environment = await this.options.getEnvironment()
      const before = await this.inspect(provider, environment)
      if (before.identity !== plan.identity || before.version !== plan.current) throw new Error("The selected CLI changed. Check for updates again.")
      const previous = this.records.get(provider)
      const recovering = plan.kind === "repair" && plan.recoveryId && previous?.operation.id === plan.recoveryId
      if (previous?.recoveryBlocked || (previous?.installerPid && cliInstallerAlive(previous.installerPid))) throw new Error("The previous CLI installer must finish before another update can start.")
      const selected = recovering && previous && this.sameSelection(previous, before, environment) && !previous.recoveryBlocked ? previous.installation : before
      if (!selected.method || !selected.executable || (plan.recoveryId && selected === before)) throw new Error("The selected CLI changed. Check for updates again.")
      if (plan.kind === "update") {
        const latest = await this.latest(provider, false)
        if (latest.version !== plan.target || !before.version || !newerCliVersion(plan.target, before.version)) throw new Error("The available release changed. Check for updates again.")
      } else if (before.version || selected.method.kind !== "npm") throw new Error("Check the CLI installation again before repairing.")
      this.plans.delete(provider)
      const operation: CliUpdateOperation = { id: randomUUID(), targetVersion: plan.target, startedAt: new Date().toISOString(), attempts: 0,
        state: "updating", message: `${plan.kind === "repair" ? "Repairing" : "Updating to"} ${plan.target}… New agent work is paused until verification finishes.` }
      const record: CliUpdateJournal = { schema: 1, provider, installation: selected, configuredExecutable: configuredExecutable(provider, environment),
        phase: "installing", operation, attempts: 0, updatedAt: operation.startedAt! }
      // Refuse to mutate the CLI if its recovery record cannot be saved first.
      try { await this.journals.write(record) } catch { throw new Error("Could not save the CLI update recovery record. The installer was not started.") }
      this.records.set(provider, record)
      const unlock = release
      void this.perform(record, environment, true).catch(() => {
        operation.state = "failed"; operation.message = "Could not save the CLI update result. Check the installation and local data directory before retrying."
      }).finally(() => { unlock(); this.running = null; complete() })
      return { ...operation }
    } catch (error) { release?.(); this.running = null; complete(); throw error }
  }

  /** Resume only previously consented work, after loading records at startup. */
  async recoverInterrupted() {
    await this.initialize()
    if (this.recoveryError) return
    for (const record of this.records.values()) {
      if (this.closed || this.running || (!["installing", "verifying"].includes(record.phase) && !record.recoveryBlocked)) continue
      let complete!: () => void
      this.running = new Promise<void>(resolve => { complete = resolve })
      let release: (() => void) | undefined
      try {
        release = await this.options.reserve()
        const previousPid = record.installerPid
        record.recoveryBlocked ||= record.phase === "installing" && !previousPid
        record.operation.state = "updating"
        record.operation.message = "Checking an interrupted CLI update… New agent work is paused."
        // An installer can outlive StillOn. Never race it with a second npm.
        while (previousPid && cliInstallerAlive(previousPid)) {
          if (this.closed) return
          record.operation.message = "Waiting for the existing CLI installer to finish… New agent work is paused."
          await Bun.sleep(1_000)
        }
        if (this.closed) return
        record.installerPid = undefined
        const environment = await this.options.getEnvironment()
        await this.perform(record, environment, false)
      } catch {
        record.phase = "failed"; record.operation.state = "failed"
        record.operation.message = "The interrupted CLI update could not resume. Finish active work, check the installation and choose Repair CLI if available."
        await this.journals.write(record).catch(() => {})
      } finally { release?.(); this.running = null; complete() }
    }
  }

  async close() { this.closed = true; await this.running }
}
