import process from "node:process"

/**
 * Return a copy of the service environment for a child agent process.
 *
 * A native StillOn service can load a dedicated Bun `--env-file` before this
 * process starts. Keeping this copy explicit makes proxy settings such as
 * HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, and NO_PROXY part of the agent-launch
 * contract instead of an accidental consequence of a particular spawner.
 */
export function inheritAgentEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...environment }
}

/**
 * Claude Code refuses to start from another Claude Code process. StillOn is
 * not one, but a caller may have left CLAUDECODE in its shell environment, so
 * remove only that marker while preserving the rest of the explicit service
 * environment (including proxy settings).
 */
export function inheritClaudeAgentEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnvironment = inheritAgentEnvironment(environment)
  delete childEnvironment.CLAUDECODE
  return childEnvironment
}
