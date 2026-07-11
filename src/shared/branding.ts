export const APP_NAME = "Husky"
export const CLI_COMMAND = "husky"
export const DATA_ROOT_NAME = ".kanna"
export const DEV_DATA_ROOT_NAME = ".kanna-dev"
export const PACKAGE_NAME = "@bzbj/husky"
export const LINJUNKAI_EDITION_SEQUENCE = [
  "Pup",
  "Husky",
  "Corgi",
  "Samoyed",
  "Shiba",
  "Labrador",
  "Golden",
  "Shepherd",
  "Collie",
  "Border",
] as const
export type LinjunkaiEdition = typeof LINJUNKAI_EDITION_SEQUENCE[number]
export const LINJUNKAI_EDITION: LinjunkaiEdition = "Husky"
export const LINJUNKAI_EDITION_DESCRIPTIONS: Record<LinjunkaiEdition, string> = {
  Pup: "A newborn puppy: small, fresh, and just starting out.",
  Husky: "A loud young sled dog: energetic, curious, and not fully disciplined yet.",
  Corgi: "A compact herder: small, quick, and surprisingly capable.",
  Samoyed: "A friendly working dog: warm, steady, and easy to trust.",
  Shiba: "An independent companion: opinionated, alert, and starting to feel self-directed.",
  Labrador: "A reliable helper: practical, loyal, and ready for everyday work.",
  Golden: "A thoughtful retriever: cooperative, gentle, and good at bringing things back.",
  Shepherd: "A disciplined working dog: protective, focused, and strong at execution.",
  Collie: "A graceful herder: perceptive, organized, and careful with complex tasks.",
  Border: "A Border Collie: intensely smart, responsive, and built for advanced work.",
}
export const RUNTIME_PROFILE_ENV_VAR = "HUSKY_RUNTIME_PROFILE"
const LEGACY_RUNTIME_PROFILE_ENV_VAR = "KANNA_RUNTIME_PROFILE"
// Read version from package.json — JSON import works in both Bun and Vite
import pkg from "../../package.json"
export const APP_VERSION = pkg.version
export const SDK_CLIENT_APP = `husky/${pkg.version}`
export const LOG_PREFIX = "[husky]"
export const DEFAULT_NEW_PROJECT_ROOT = `~/${APP_NAME}`

export type RuntimeProfile = "dev" | "prod"

type RuntimeEnv = Record<string, string | undefined> | undefined

function getRuntimeEnv(): RuntimeEnv {
  const candidate = globalThis as typeof globalThis & {
    process?: {
      env?: Record<string, string | undefined>
    }
  }
  return candidate.process?.env
}

export function getRuntimeProfile(env: RuntimeEnv = getRuntimeEnv()): RuntimeProfile {
  const runtimeProfile = env?.[RUNTIME_PROFILE_ENV_VAR] ?? env?.[LEGACY_RUNTIME_PROFILE_ENV_VAR]
  return runtimeProfile?.trim().toLowerCase() === "dev" ? "dev" : "prod"
}

export function getDataRootName(env: RuntimeEnv = getRuntimeEnv()) {
  return getRuntimeProfile(env) === "dev" ? DEV_DATA_ROOT_NAME : DATA_ROOT_NAME
}

export function getDataRootDir(homeDir: string, env: RuntimeEnv = getRuntimeEnv()) {
  return `${homeDir}/${getDataRootName(env)}`
}

export function getDataRootDirDisplay(env: RuntimeEnv = getRuntimeEnv()) {
  return `~/${getDataRootName(env)}`
}

export function getDataDir(homeDir: string, env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataRootDir(homeDir, env)}/data`
}

export function getDataDirDisplay(env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataRootDirDisplay(env)}/data`
}

export function getSettingsFilePath(homeDir: string, env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataDir(homeDir, env)}/settings.json`
}

export function getSettingsFilePathDisplay(env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataDirDisplay(env)}/settings.json`
}

export function getKeybindingsFilePath(homeDir: string, env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataRootDir(homeDir, env)}/keybindings.json`
}

export function getKeybindingsFilePathDisplay(env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataRootDirDisplay(env)}/keybindings.json`
}

export function getLlmProviderFilePath(homeDir: string, env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataRootDir(homeDir, env)}/llm-provider.json`
}

export function getLlmProviderFilePathDisplay(env: RuntimeEnv = getRuntimeEnv()) {
  return `${getDataRootDirDisplay(env)}/llm-provider.json`
}

export function getCliInvocation(arg?: string) {
  return arg ? `${CLI_COMMAND} ${arg}` : CLI_COMMAND
}

export function getLinjunkaiEditionTooltip(edition: LinjunkaiEdition = LINJUNKAI_EDITION) {
  return `Software Edition: ${edition}.\n${LINJUNKAI_EDITION_DESCRIPTIONS[edition]}`
}
