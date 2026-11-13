import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CLAUDE_COMPONENT_DESCRIPTOR, claudeComponentFromLock, claudeComponentUrl, ensureClaudeComponent, resolveSdkClaudeExecutable, validateClaudeComponent, type ClaudeComponent } from "./claude-component"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function temp() { const root = await mkdtemp(path.join(os.tmpdir(), "stillon-claude-component-")); roots.push(root); return root }
const target = { platform: "darwin", architecture: "arm64" } as const

async function packageTarball(binary = "#!/bin/sh\necho fixture\n") {
  const bytes = await new Bun.Archive({ "package/claude": new Blob([binary]), "package/package.json": new Blob(["{}"]) }, { compress: "gzip" }).bytes()
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
  const component: ClaudeComponent = { schema: 1, package: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: "0.3.251", ...target, integrity }
  return { bytes, component }
}

function fetcherFor(bytes: Uint8Array, calls: string[] = []) {
  return (async (url: string | URL | Request) => { calls.push(String(url)); return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>])) }) as unknown as typeof fetch
}

test("reads the exact platform package and integrity from bun.lock", () => {
  const integrity = `sha512-${"A".repeat(86)}==`
  const lock = `    "@anthropic-ai/claude-agent-sdk-darwin-arm64": ["@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.251", "", { "os": "darwin", "cpu": "arm64" }, "${integrity}"],\n`
  expect(claudeComponentFromLock(lock, target)).toEqual({ schema: 1, package: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: "0.3.251", ...target, integrity })
  expect(() => claudeComponentFromLock(lock, { platform: "win32", architecture: "x64" })).toThrow("no entry")
  expect(() => validateClaudeComponent({ schema: 1, package: "@evil/pkg", version: "1.0.0", ...target, integrity }, target)).toThrow("Invalid")
})

test("uses the npm registry or a configured HTTPS mirror", () => {
  const component = { schema: 1, package: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: "0.3.251", ...target, integrity: `sha512-${"A".repeat(86)}==` } as const
  expect(claudeComponentUrl(component, {})).toBe("https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.251.tgz")
  expect(claudeComponentUrl(component, { npm_config_registry: "https://mirror.example.com/npm" }))
    .toBe("https://mirror.example.com/npm/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.251.tgz")
  expect(() => claudeComponentUrl(component, { STILLON_NPM_REGISTRY: "http://mirror.example.com/" })).toThrow("HTTPS")
})

test("downloads, verifies and caches the binary once; background checks never download", async () => {
  const root = await temp()
  const { bytes, component } = await packageTarball()
  const calls: string[] = []
  expect(await ensureClaudeComponent(component, { root, download: false, fetcher: fetcherFor(bytes, calls) })).toBeUndefined()
  const [first, second] = await Promise.all([
    ensureClaudeComponent(component, { root, environment: {}, fetcher: fetcherFor(bytes, calls) }),
    ensureClaudeComponent(component, { root, environment: {}, fetcher: fetcherFor(bytes, calls) }),
  ])
  expect(first).toBe(second!)
  expect(calls).toHaveLength(1)
  expect(await Bun.file(first!).text()).toContain("fixture")
  expect(await ensureClaudeComponent(component, { root, download: false })).toBe(first)
})

test("a tampered download is rejected before anything is installed", async () => {
  const root = await temp()
  const { component } = await packageTarball()
  const other = await packageTarball("#!/bin/sh\necho tampered\n")
  await expect(ensureClaudeComponent(component, { root, environment: {}, fetcher: fetcherFor(other.bytes) })).rejects.toThrow("integrity")
  expect(await ensureClaudeComponent(component, { root, download: false })).toBeUndefined()
  const failing = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch
  await expect(ensureClaudeComponent(component, { root, environment: {}, fetcher: failing })).rejects.toThrow("Install Claude Code or set CLAUDE_EXECUTABLE")
})

test("an installed Claude Code CLI wins, and source installs keep the SDK's own binary", async () => {
  const root = await temp()
  const runtime = path.join(root, "runtime")
  const { bytes, component: fixture } = await packageTarball()
  const host = { platform: process.platform, architecture: process.arch } as { platform: "darwin" | "win32" | "linux"; architecture: "x64" | "arm64" }
  const component: ClaudeComponent = { ...fixture, ...host, package: `@anthropic-ai/claude-agent-sdk-${host.platform}-${host.architecture}` }
  await mkdir(path.join(runtime, "runtime"), { recursive: true })
  await writeFile(path.join(runtime, "package.json"), "{}")
  await writeFile(path.join(runtime, CLAUDE_COMPONENT_DESCRIPTOR), JSON.stringify(component))
  const calls: string[] = []
  const base = { runtime, root: path.join(root, "cache"), fetcher: fetcherFor(bytes, calls) }
  expect(await resolveSdkClaudeExecutable({ ...base, environment: { CLAUDE_EXECUTABLE: "/example/claude", PATH: "" }, download: true })).toBe("/example/claude")
  expect(calls).toHaveLength(0)
  // Without a CLI, a package that omits the SDK binary leaves background checks to the SDK.
  expect(await resolveSdkClaudeExecutable({ ...base, environment: { PATH: "" }, download: false })).toBeUndefined()
  expect(calls).toHaveLength(0)
  // A source checkout with the SDK's optional platform package needs no download.
  const sdk = path.join(runtime, "node_modules", "@anthropic-ai", `claude-agent-sdk-${host.platform}-${host.architecture}`)
  await mkdir(sdk, { recursive: true })
  await writeFile(path.join(sdk, "package.json"), JSON.stringify({ name: component.package }))
  await writeFile(path.join(sdk, host.platform === "win32" ? "claude.exe" : "claude"), "binary")
  expect(await resolveSdkClaudeExecutable({ ...base, environment: { PATH: "" }, download: true })).toBeUndefined()
  expect(calls).toHaveLength(0)
})
