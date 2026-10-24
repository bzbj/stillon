import path from "node:path"
import type { AgentProvider } from "../shared/types"
import type { CliUpdateOperation } from "../shared/provider-cli-updates"
import type { CliInstallation } from "./provider-cli-installation"
import { atomicJson, json } from "./updater/files"

export interface CliUpdateJournal {
  schema: 1
  provider: AgentProvider
  installation: CliInstallation
  configuredExecutable?: string
  phase: "installing" | "verifying" | "succeeded" | "failed"
  operation: CliUpdateOperation
  attempts: number
  installerPid?: number
  recoveryBlocked?: boolean
  updatedAt: string
}

export function cliInstallerAlive(pid: number) {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH" }
}

/** Local-only record. Never persist the environment or raw installer output. */
export class CliUpdateJournals {
  constructor(private directory?: string) {}
  async read(provider: AgentProvider): Promise<CliUpdateJournal | undefined> {
    if (!this.directory) return
    try {
      const record = await json<CliUpdateJournal>(path.join(this.directory, `${provider}.json`))
      if (record.schema !== 1 || record.provider !== provider || !record.installation?.executable
        || !record.installation.method || !record.operation?.id || !record.operation.startedAt
        || !Number.isFinite(Date.parse(record.operation.startedAt))
        || !["updating", "succeeded", "failed"].includes(record.operation.state)
        || !["npm", "native"].includes(record.installation.method.kind)
        || (record.installation.method.kind === "npm" ? !path.isAbsolute(record.installation.method.prefix) : !path.isAbsolute(record.installation.method.binDir))
        || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/u.test(record.operation.targetVersion)
        || !["installing", "verifying", "succeeded", "failed"].includes(record.phase)
        || !Number.isInteger(record.attempts) || record.attempts < 0 || record.attempts > 2
        || (record.installerPid !== undefined && (!Number.isInteger(record.installerPid) || record.installerPid <= 0))) {
        throw new Error("Invalid CLI update journal.")
      }
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The CLI update recovery record could not be read. Check the local data directory before updating.")
    }
  }
  async write(record: CliUpdateJournal) {
    record.updatedAt = new Date().toISOString()
    if (this.directory) await atomicJson(path.join(this.directory, `${record.provider}.json`), record)
  }
}
