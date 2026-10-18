import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentProvider } from "../shared/types"
import type { CliRelease, CliUpdateOperation, ProviderCliUpdateStatus } from "../shared/provider-cli-updates"
import { discoverCodexModels } from "./codex-model-discovery"
import { inspectCliInstallation, newerCliVersion, npmUpdateCommand, runCli, stableCliVersion, type CliInstallation } from "./provider-cli-installation"

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
  getEnvironment: () => Promise<NodeJS.ProcessEnv>
  /** Must synchronously reserve the agent before awaiting process shutdown. */
  reserve: () => Promise<() => void>
  inspect?: (provider: AgentProvider, environment: NodeJS.ProcessEnv) => Promise<CliInstallation>
  release?: (provider: AgentProvider) => Promise<CliRelease>
  install?: (provider: AgentProvider, installation: CliInstallation, version: string, environment: NodeJS.ProcessEnv) => Promise<void>
  verify?: (provider: AgentProvider, installation: CliInstallation, environment: NodeJS.ProcessEnv) => Promise<void>
}

export async function installCli(provider: AgentProvider, installation: CliInstallation, version: string, env: NodeJS.ProcessEnv) {
  if (!stableCliVersion(version)) throw new Error("Invalid release version.")
  if (installation.method?.kind === "npm") {
    const { command, args } = await npmUpdateCommand(env, installation.method.prefix, provider, version)
    await runCli(command, args, env, 5 * 60_000)
  } else if (installation.method?.kind === "native" && provider === "claude") {
    await runCli(installation.executable!, ["install", version], { ...env, DISABLE_AUTOUPDATER: "1" }, 5 * 60_000)
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
      await runCli(command, args, { ...env, CODEX_INSTALL_DIR: installation.method.binDir, CODEX_NON_INTERACTIVE: "1", CODEX_INSTALL_DAEMON_ONLY: "0", CODEX_INSTALL_DEFER_SELECTION: "0" }, 5 * 60_000)
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

export class ProviderCliUpdates {
  private releases = new Map<AgentProvider, { value: CliRelease; expires: number }>()
  private plans = new Map<AgentProvider, { token: string; identity: string; current: string; target: string; expires: number }>()
  private operations = new Map<AgentProvider, CliUpdateOperation>()
  private running: Promise<void> | null = null
  private closed = false
  private inspect: NonNullable<ProviderCliUpdatesOptions["inspect"]>
  constructor(private options: ProviderCliUpdatesOptions) { this.inspect = options.inspect ?? inspectCliInstallation }
  get busy() { return this.running !== null }

  private async latest(provider: AgentProvider, force: boolean) {
    const cached = this.releases.get(provider)
    if (!force && cached && cached.expires > Date.now()) return cached.value
    const value = await (this.options.release ?? readCliRelease)(provider)
    this.releases.set(provider, { value, expires: Date.now() + 10 * 60_000 })
    return value
  }

  async status(provider: AgentProvider, refresh = false): Promise<ProviderCliUpdateStatus> {
    const installation = await this.inspect(provider, await this.options.getEnvironment())
    const status: ProviderCliUpdateStatus = { provider, executable: installation.executable, currentVersion: installation.version,
      installation: installation.label, automaticUpdates: installation.automaticUpdates, updateAvailable: false,
      reason: installation.reason, operation: this.operations.get(provider) }
    try { status.latest = await this.latest(provider, refresh) }
    catch { status.releaseError = "Could not check releases. Your installed CLI is unchanged; check again later." }
    if (status.latest && installation.version && newerCliVersion(status.latest.version, installation.version)) {
      status.updateAvailable = true
      if (installation.method && !this.busy && !this.closed) {
        let plan = this.plans.get(provider)
        if (!plan || plan.identity !== installation.identity || plan.target !== status.latest.version || plan.expires <= Date.now()) {
          plan = { token: randomUUID(), identity: installation.identity, current: installation.version, target: status.latest.version, expires: Date.now() + 10 * 60_000 }
          this.plans.set(provider, plan)
        }
        status.updateToken = plan.token
      }
    }
    return status
  }

  async start(provider: AgentProvider, token: string): Promise<CliUpdateOperation> {
    if (this.closed) throw new Error("StillOn is shutting down.")
    if (this.busy) throw new Error("Another CLI update is in progress.")
    const plan = this.plans.get(provider)
    if (!plan || plan.token !== token || plan.expires <= Date.now()) throw new Error("The update information expired. Check for updates again.")
    // Reserve globally before the first await (including across both providers).
    let complete!: () => void
    this.running = new Promise<void>(resolve => { complete = resolve })
    let release: (() => void) | undefined
    try {
      release = await this.options.reserve()
      const environment = await this.options.getEnvironment()
      const before = await this.inspect(provider, environment)
      if (!before.method || before.identity !== plan.identity || before.version !== plan.current) throw new Error("The selected CLI changed. Check for updates again.")
      const latest = await this.latest(provider, false)
      if (latest.version !== plan.target || !newerCliVersion(plan.target, before.version)) throw new Error("The available release changed. Check for updates again.")
      this.plans.delete(provider) // A repeated POST cannot repeat the installation.
      const operation: CliUpdateOperation = { id: randomUUID(), targetVersion: plan.target, state: "updating", message: `Updating to ${plan.target}… New agent work is paused until verification finishes.` }
      this.operations.set(provider, operation)
      const unlock = release
      void (async () => {
        let phase = "install"
        try {
          await (this.options.install ?? installCli)(provider, before, plan.target, environment)
          phase = "verify"
          const afterEnvironment = await this.options.getEnvironment()
          const after = await this.inspect(provider, afterEnvironment)
          if (after.executable !== before.executable || after.version !== plan.target) throw new Error("Selection or version changed.")
          await (this.options.verify ?? verifyCli)(provider, after, afterEnvironment)
          operation.state = "succeeded"
          operation.message = provider === "codex" ? `Updated to ${plan.target}. CLI, fresh App Server and model discovery verified.` : `Updated to ${plan.target}. CLI version verified; new sessions use this version.`
        } catch (error) {
          operation.state = "failed"
          // Never return installer output (which can contain credentials, proxy
          // addresses or user paths) to either the local or remote browser.
          const code = (error as { code?: unknown } | null)?.code
          const diagnostic = typeof code === "number" ? `Installer exit code ${code}. `
            : code === "EACCES" || code === "EPERM" ? "Permission denied. "
              : code === "ENOENT" ? "The original installer or a required executable was not found. " : ""
          operation.message = phase === "install" ? `Update failed. ${diagnostic}Check disk space, permissions and network access, then check again. No alternate CLI was selected.`
            : "The installer finished, but verification failed. Check the displayed CLI path/version and sign-in; for Codex, retry Discover Models. No alternate CLI was selected."
        } finally { unlock(); this.running = null; complete() }
      })()
      return { ...operation }
    } catch (error) {
      release?.(); this.running = null; complete(); throw error
    }
  }

  async close() { this.closed = true; await this.running }
}
