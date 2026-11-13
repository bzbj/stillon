import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { resolveClaudeCodeExecutable } from "./claude-executable"

/**
 * The Agent SDK's native Claude Code binary (~200 MB) is only needed when no
 * Claude Code installation is found. Desktop packages therefore omit it and
 * record the exact npm package and lockfile integrity instead; the binary is
 * downloaded once, verified and cached outside the immutable runtime.
 */
export const CLAUDE_COMPONENT_DESCRIPTOR = "runtime/claude-component.json"
export const MAX_CLAUDE_ARCHIVE_BYTES = 256 * 1024 * 1024
export const MAX_CLAUDE_BINARY_BYTES = 512 * 1024 * 1024
const PACKAGE_PREFIX = "@anthropic-ai/claude-agent-sdk-"

export interface ClaudeComponent {
  schema: 1
  package: string
  version: string
  platform: "darwin" | "win32" | "linux"
  architecture: "x64" | "arm64"
  /** npm Subresource Integrity of the package tarball, from bun.lock. */
  integrity: string
}

interface InstalledClaudeComponent { schema: 1; integrity: string; sha256: string; size: number }

export const claudeBinaryName = (platform: string) => platform === "win32" ? "claude.exe" : "claude"

export function validateClaudeComponent(value: unknown, target: { platform: string; architecture: string } = { platform: process.platform, architecture: process.arch }): ClaudeComponent {
  const c = value as ClaudeComponent
  if (!c || c.schema !== 1 || c.platform !== target.platform || c.architecture !== target.architecture
    || c.package !== `${PACKAGE_PREFIX}${c.platform}-${c.architecture}` || !/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(c.version)
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(c.integrity)) {
    throw new Error("Invalid Claude Code component descriptor.")
  }
  return c
}

/** Build-time: the exact platform package recorded in bun.lock. */
export function claudeComponentFromLock(lock: string, target: { platform: "darwin" | "win32" | "linux"; architecture: "x64" | "arm64" }): ClaudeComponent {
  const name = `${PACKAGE_PREFIX}${target.platform}-${target.architecture}`
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
  const match = lock.match(new RegExp(`"${escaped}": \\["${escaped}@(\\d+\\.\\d+\\.\\d+)",[^\\n]*"(sha512-[A-Za-z0-9+/]+==)"\\]`))
  if (!match) throw new Error(`bun.lock has no entry for ${name}`)
  return validateClaudeComponent({ schema: 1, package: name, version: match[1], ...target, integrity: match[2] }, target)
}

export function claudeComponentRoot(platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA) {
  if (platform === "win32") return path.win32.join(localAppData || path.win32.join(home, "AppData", "Local"), "StillOn", "Components", "claude-code")
  return path.posix.join(home, platform === "darwin" ? "Library/Application Support" : ".local/share", "StillOn", "Components", "claude-code")
}

function componentDirectory(component: ClaudeComponent, root: string) {
  const id = createHash("sha256").update(component.integrity).digest("hex").slice(0, 12)
  return path.join(root, `${component.version}-${component.platform}-${component.architecture}-${id}`)
}

/** npm registry tarball URL; a configured mirror is fine because the integrity is fixed. */
export function claudeComponentUrl(component: ClaudeComponent, environment: NodeJS.ProcessEnv = process.env) {
  const configured = environment.STILLON_NPM_REGISTRY || environment.npm_config_registry || environment.NPM_CONFIG_REGISTRY
  const registry = new URL(configured || "https://registry.npmjs.org/")
  if (registry.protocol !== "https:" || registry.username || registry.password) throw new Error("The npm registry for Claude Code must be an HTTPS URL without credentials.")
  const base = registry.href.endsWith("/") ? registry.href : `${registry.href}/`
  const file = `${component.package.split("/")[1]}-${component.version}.tgz`
  return new URL(`${component.package}/-/${file}`, base).href
}

async function readLimited(response: Response, limit: number) {
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  const announced = Number(response.headers.get("content-length"))
  if (Number.isFinite(announced) && announced > limit) throw new Error("download is too large")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error("download is too large")
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return new Uint8Array(Buffer.concat(chunks, total))
}

/** Extract only the package binary, as bytes; archive paths never reach disk. */
export async function readClaudeComponentArchive(bytes: Uint8Array, component: ClaudeComponent) {
  const digest = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
  if (digest !== component.integrity) throw new Error("Claude Code download failed its integrity check.")
  const files = await new Bun.Archive(gunzipSync(bytes, { maxOutputLength: MAX_CLAUDE_BINARY_BYTES + 16 * 1024 * 1024 })).files()
  const binary = files.get(`package/${claudeBinaryName(component.platform)}`)
  if (!binary || binary.size < 1 || binary.size > MAX_CLAUDE_BINARY_BYTES) throw new Error("The Claude Code package has no executable for this platform.")
  return new Uint8Array(await binary.arrayBuffer())
}

const inFlight = new Map<string, Promise<string>>()

/** Return the cached binary, downloading and verifying it once when allowed. */
export async function ensureClaudeComponent(component: ClaudeComponent, options: {
  root?: string
  environment?: NodeJS.ProcessEnv
  fetcher?: typeof fetch
  download?: boolean
} = {}): Promise<string | undefined> {
  const directory = componentDirectory(component, options.root ?? claudeComponentRoot())
  const executable = path.join(directory, claudeBinaryName(component.platform))
  const markerFile = path.join(directory, "component.json")
  try {
    const marker = JSON.parse(await Bun.file(markerFile).text()) as InstalledClaudeComponent
    if (marker.schema === 1 && marker.integrity === component.integrity && (await stat(executable)).size === marker.size) return executable
  } catch { /* not installed yet */ }
  if (options.download === false) return undefined
  const pending = inFlight.get(directory)
  if (pending) return pending
  const work = (async () => {
    const url = claudeComponentUrl(component, options.environment)
    let bytes: Uint8Array
    try {
      bytes = await readLimited(await (options.fetcher ?? fetch)(url, { signal: AbortSignal.timeout(600_000) }), MAX_CLAUDE_ARCHIVE_BYTES)
    } catch (error) {
      throw new Error(`Claude Code is not installed and its runtime could not be downloaded (${error instanceof Error ? error.message : String(error)}). Install Claude Code or set CLAUDE_EXECUTABLE, then retry.`)
    }
    const binary = await readClaudeComponentArchive(bytes, component)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(directory, `.claude-${randomUUID()}`)
    try {
      await writeFile(temporary, binary, { flag: "wx", mode: 0o755 })
      if (component.platform !== "win32") await chmod(temporary, 0o755)
      await rm(executable, { force: true })
      await rename(temporary, executable)
    } finally { await rm(temporary, { force: true }) }
    const marker: InstalledClaudeComponent = { schema: 1, integrity: component.integrity,
      sha256: createHash("sha256").update(binary).digest("hex"), size: binary.byteLength }
    await writeFile(markerFile, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 })
    return executable
  })()
  inFlight.set(directory, work)
  try { return await work } finally { inFlight.delete(directory) }
}

const runtimeRoot = path.resolve(import.meta.dir, "..", "..")

async function readDescriptor(root: string) {
  try {
    return validateClaudeComponent(JSON.parse(await Bun.file(path.join(root, CLAUDE_COMPONENT_DESCRIPTOR)).text()))
  } catch { return null }
}

function sdkBinaryInstalled(root: string, component: ClaudeComponent) {
  // Hoisted installs: check the file directly (module resolution caches misses).
  if (existsSync(path.join(root, "node_modules", ...component.package.split("/"), claudeBinaryName(component.platform)))) return true
  try {
    const require = createRequire(path.join(root, "package.json"))
    return Boolean(require.resolve(`${component.package}/${claudeBinaryName(component.platform)}`))
  } catch { return false }
}

/**
 * Executable for Agent SDK queries: CLAUDE_EXECUTABLE or a Claude Code CLI on
 * PATH first, then the SDK's own binary. Packages that omit the SDK binary
 * download it only when `download` is true (an actual Claude turn); background
 * checks use an existing copy and otherwise leave the SDK to report it missing.
 */
export async function resolveSdkClaudeExecutable(options: {
  environment?: NodeJS.ProcessEnv
  download?: boolean
  runtime?: string
  root?: string
  fetcher?: typeof fetch
} = {}): Promise<string | undefined> {
  const environment = options.environment ?? process.env
  const installed = resolveClaudeCodeExecutable({ environment })
  if (installed) return installed
  const root = options.runtime ?? runtimeRoot
  const component = await readDescriptor(root)
  if (!component || sdkBinaryInstalled(root, component)) return undefined
  return ensureClaudeComponent(component, { environment, download: options.download, root: options.root, fetcher: options.fetcher })
}
