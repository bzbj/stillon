import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { CodexApiTransport } from "../shared/types"

type Config = Record<string, any>

function readConfig(file: string, optional = false): Config {
  try {
    return Bun.TOML.parse(readFileSync(file, "utf8")) as Config
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return {}
    // Do not include parser output: it can quote credentials from the config.
    throw new Error("Unable to read Codex configuration for HTTPS only. Check your Codex config or select Automatic.")
  }
}

function userConfig(environment: NodeJS.ProcessEnv): Config {
  const home = environment.CODEX_HOME || path.join(environment.HOME || environment.USERPROFILE || homedir(), ".codex")
  const base = readConfig(path.join(home, "config.toml"), true)
  if (!base.profile) return base
  if (typeof base.profile !== "string" || !/^[\w.-]+$/u.test(base.profile)) {
    throw new Error("Unable to resolve the Codex profile for HTTPS only. Select Automatic or check your Codex profile.")
  }
  const profileFile = path.join(home, `${base.profile}.config.toml`)
  let profile: Config
  try {
    // New CLI versions use a separate profile file. Keep compatibility with
    // older user configs that still define [profiles.<name>].
    readFileSync(profileFile)
    profile = readConfig(profileFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    profile = base.profiles?.[base.profile]
    if (!profile || typeof profile !== "object") {
      throw new Error("Unable to resolve the Codex profile for HTTPS only. Select Automatic or check your Codex profile.")
    }
  }
  return { ...base, ...profile, model_providers: { ...base.model_providers, ...profile.model_providers } }
}

/** CLI overrides for this StillOn child only. Never write Codex user files. */
export function codexApiTransportArgs(mode: CodexApiTransport, environment: NodeJS.ProcessEnv): string[] {
  if (mode !== "https") return []
  const config = userConfig(environment)
  const selected = config.model_provider ?? "openai"
  if (typeof selected !== "string" || !selected) throw new Error("Invalid Codex model provider. Select Automatic or check your Codex config.")
  // These built-in providers already use HTTP and do not support Responses WS.
  if (["ollama", "lmstudio", "amazon-bedrock", "amazon-bedrock-runtime"].includes(selected)) return []
  if (selected !== "openai") {
    if (!config.model_providers?.[selected]) throw new Error("Unable to resolve the Codex model provider for HTTPS only. Select Automatic or check your Codex config.")
    // Preserve every custom endpoint, authentication method and capability.
    return ["-c", `model_providers={ ${JSON.stringify(selected)} = { supports_websockets = false } }`]
  }

  // Current CLIs reserve the built-in OpenAI ID. Use a process-local alias;
  // leaving base_url unset preserves ChatGPT versus API-key endpoint selection.
  let alias = "stillon-openai-https"
  for (let suffix = 1; config.model_providers?.[alias]; suffix++) alias = `stillon-openai-https-${suffix}`
  const provider: Config = {
    name: "OpenAI",
    wire_api: "responses",
    requires_openai_auth: true,
    supports_websockets: false,
    supports_standalone_web_search: true,
    env_http_headers: { "OpenAI-Organization": "OPENAI_ORGANIZATION", "OpenAI-Project": "OPENAI_PROJECT" },
  }
  const baseUrl = config.openai_base_url || environment.OPENAI_BASE_URL
  if (typeof baseUrl === "string" && baseUrl.trim()) provider.base_url = baseUrl
  // Assign the table as a TOML inline table so all changes remain in argv.
  const toml = (value: any): string => typeof value === "object" && value !== null
    ? `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(", ")} }`
    : JSON.stringify(value)
  return ["-c", `model_provider=${JSON.stringify(alias)}`, "-c", `model_providers.${alias}=${toml(provider)}`]
}
