export type ServiceAction = "install" | "status" | "logs" | "uninstall"

export interface ServiceCommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface ServiceCommandResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export type ServiceCommandRunner = (
  command: string,
  args: string[],
  options?: ServiceCommandOptions,
) => Promise<ServiceCommandResult>

export interface ServiceLaunchSpec {
  executable: string
  args: string[]
  workingDirectory: string
  homeDirectory: string
  pathEnvironment: string
  /** An optional Bun dotenv file loaded before the StillOn CLI starts. */
  environmentFile?: string
  localAppDataDirectory?: string
}

export interface ServiceBackendContext {
  launch: ServiceLaunchSpec
  run: ServiceCommandRunner
  log: (message: string) => void
  warn: (message: string) => void
}

export interface ServiceBackend {
  install: (context: ServiceBackendContext) => Promise<void>
  status: (context: ServiceBackendContext) => Promise<void>
  logs: (context: ServiceBackendContext) => Promise<void>
  uninstall: (context: ServiceBackendContext) => Promise<void>
}

export function formatCommandFailure(command: string, result: ServiceCommandResult) {
  const detail = result.stderr.trim() || result.stdout.trim()
  const outcome = result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? "unknown"}`
  return new Error(detail ? `${command} failed (${outcome}): ${detail}` : `${command} failed with ${outcome}`)
}

export function assertCommandSucceeded(command: string, result: ServiceCommandResult) {
  if (result.code === 0 && result.signal === null) return
  throw formatCommandFailure(command, result)
}
