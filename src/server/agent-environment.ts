import process from "node:process"
import type {
  AgentNetworkEffectiveProxy,
  AgentNetworkProxySettings,
  AgentNetworkStatus,
} from "../shared/types"

const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const

function readEnvironmentValue(environment: NodeJS.ProcessEnv, variable: typeof PROXY_VARIABLES[number]) {
  return environment[variable]?.trim() || environment[variable.toLowerCase()]?.trim() || ""
}

function settingsValue(settings: AgentNetworkProxySettings, variable: typeof PROXY_VARIABLES[number]) {
  switch (variable) {
    case "HTTP_PROXY":
      return settings.httpProxy.trim()
    case "HTTPS_PROXY":
      return settings.httpsProxy.trim()
    case "ALL_PROXY":
      return settings.allProxy.trim()
    case "NO_PROXY":
      return settings.noProxy.trim()
  }
}

function mergeNoProxyValues(...values: string[]) {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const value of values) {
    for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
      const key = entry.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
    }
  }
  return entries.join(",")
}

export function redactProxyValue(value: string) {
  try {
    const url = new URL(value)
    if (!url.hostname) return "Configured (invalid URL)"
    url.username = ""
    url.password = ""
    url.pathname = "/"
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/$/u, "")
  } catch {
    return "Configured (value hidden)"
  }
}

export function mergeAgentNetworkEnvironment(
  environment: NodeJS.ProcessEnv,
  settings?: AgentNetworkProxySettings,
): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment }
  if (!settings || settings.mode === "system") return childEnvironment

  for (const variable of PROXY_VARIABLES) {
    const savedValue = settingsValue(settings, variable)
    const value = variable === "NO_PROXY"
      ? mergeNoProxyValues(readEnvironmentValue(environment, variable), savedValue)
      : savedValue
    if (!value) continue
    childEnvironment[variable] = value
    childEnvironment[variable.toLowerCase()] = value
  }

  return childEnvironment
}

export function getAgentNetworkStatus(
  settings: AgentNetworkProxySettings,
  environment: NodeJS.ProcessEnv = process.env,
): AgentNetworkStatus {
  const effectiveProxy: AgentNetworkEffectiveProxy[] = []
  let hasSettingsOverride = false

  for (const variable of PROXY_VARIABLES) {
    const override = settings.mode === "system" ? "" : settingsValue(settings, variable)
    const inherited = readEnvironmentValue(environment, variable)
    const value = variable === "NO_PROXY" && override
      ? mergeNoProxyValues(inherited, override)
      : override || inherited
    if (!value) continue
    const source = override ? "settings" : "inherited"
    hasSettingsOverride ||= source === "settings"
    effectiveProxy.push({
      variable,
      value: variable === "NO_PROXY" ? value : redactProxyValue(value),
      source,
    })
  }

  if (hasSettingsOverride) {
    return {
      mode: settings.mode,
      source: "settings",
      sourceLabel: settings.mode === "detected" ? "Saved detected system proxy" : "Settings manual override",
      effectiveProxy,
      restartRequired: false,
    }
  }
  if (effectiveProxy.length > 0) {
    return {
      mode: settings.mode,
      source: "inherited",
      sourceLabel: "Inherited service environment / --env-file",
      effectiveProxy,
      restartRequired: false,
    }
  }
  return {
    mode: settings.mode,
    source: "system",
    sourceLabel: "System network or VPN routing",
    effectiveProxy,
    restartRequired: false,
  }
}

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
  settings?: AgentNetworkProxySettings,
): NodeJS.ProcessEnv {
  return mergeAgentNetworkEnvironment(environment, settings)
}

/**
 * Claude Code refuses to start from another Claude Code process. StillOn is
 * not one, but a caller may have left CLAUDECODE in its shell environment, so
 * remove only that marker while preserving the rest of the explicit service
 * environment (including proxy settings).
 */
export function inheritClaudeAgentEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  settings?: AgentNetworkProxySettings,
): NodeJS.ProcessEnv {
  const childEnvironment = inheritAgentEnvironment(environment, settings)
  delete childEnvironment.CLAUDECODE
  return childEnvironment
}
