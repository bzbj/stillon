import { createHash } from "node:crypto"
import { access, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Plugin, ResolvedConfig } from "vite"

export const APP_SHELL_MARKER_NAME = "stillon-app-shell"
export const SERVICE_WORKER_FILE_NAME = "service-worker.js"
export const SERVICE_WORKER_URL = `/${SERVICE_WORKER_FILE_NAME}`

export interface ViteManifestChunk {
  file: string
  src?: string
  isEntry?: boolean
  imports?: string[]
  dynamicImports?: string[]
  css?: string[]
  assets?: string[]
}

export type ViteManifest = Record<string, ViteManifestChunk>

export interface AppShellAssetManifest {
  precacheUrls: string[]
  runtimeAssetUrls: string[]
}

export interface AppShellAssetDigests {
  assetDigests: Record<string, string>
}

const HASHED_ASSET_PATTERN = /^assets\/(?:.+)-[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9]+)+$/
const PENDING_BUILD_ID = "pending-app-shell-build-id"

function toVersionedAssetUrl(assetPath: string) {
  if (
    assetPath.startsWith("/")
    || assetPath.includes("\\")
    || assetPath.includes("?")
    || assetPath.includes("#")
    || assetPath.split("/").includes("..")
    || !HASHED_ASSET_PATTERN.test(assetPath)
  ) {
    throw new Error(`App-shell asset is not a versioned Vite output: ${assetPath}`)
  }

  return `/${assetPath}`
}

function collectChunkFiles(chunk: ViteManifestChunk, target: Set<string>) {
  for (const assetPath of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
    target.add(toVersionedAssetUrl(assetPath))
  }
}

function findClientEntry(manifest: ViteManifest) {
  const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry)
  if (entries.length !== 1) {
    throw new Error(`Expected one Vite client entry, found ${entries.length}`)
  }
  return entries[0]
}

export function collectAppShellAssets(manifest: ViteManifest): AppShellAssetManifest {
  const [entryKey] = findClientEntry(manifest)
  const precacheUrls = new Set<string>()
  const visited = new Set<string>()

  function visitStaticImports(key: string) {
    if (visited.has(key)) return
    const chunk = manifest[key]
    if (!chunk) {
      throw new Error(`Vite manifest references a missing static import: ${key}`)
    }

    visited.add(key)
    collectChunkFiles(chunk, precacheUrls)
    for (const importedKey of chunk.imports ?? []) {
      visitStaticImports(importedKey)
    }
  }

  visitStaticImports(entryKey)

  const runtimeAssetUrls = new Set<string>()
  for (const chunk of Object.values(manifest)) {
    collectChunkFiles(chunk, runtimeAssetUrls)
  }

  return {
    precacheUrls: [...precacheUrls].sort(),
    runtimeAssetUrls: [...runtimeAssetUrls].sort(),
  }
}

export function createAppShellBuildId(input: {
  indexHtml: string
  workerTemplate: string
  precacheUrls: string[]
  runtimeAssetUrls: string[]
}) {
  const digest = createHash("sha256")
  digest.update(input.indexHtml)
  digest.update("\0")
  digest.update(input.workerTemplate)
  digest.update("\0")
  digest.update(JSON.stringify(input.precacheUrls))
  digest.update("\0")
  digest.update(JSON.stringify(input.runtimeAssetUrls))
  return digest.digest("hex").slice(0, 20)
}

export function injectAppShellMarker(indexHtml: string, buildId: string) {
  if (!/^[a-f0-9]{20}$/.test(buildId)) {
    throw new Error(`Invalid app-shell build id: ${buildId}`)
  }
  if (indexHtml.includes(`name="${APP_SHELL_MARKER_NAME}"`)) {
    throw new Error("Built index already contains an app-shell marker")
  }
  if (!indexHtml.includes("</head>")) {
    throw new Error("Built index is missing </head>")
  }

  const marker = `<meta name="${APP_SHELL_MARKER_NAME}" content="${buildId}" />`
  return indexHtml.replace("</head>", `  ${marker}\n  </head>`)
}

export function assertIndexAssetsPrecached(indexHtml: string, precacheUrls: readonly string[]) {
  const precacheSet = new Set(precacheUrls)
  const referencedAssets = [
    ...indexHtml.matchAll(/\b(?:src|href)=["'](\/assets\/[^"'?#]+)["']/g),
  ].map((match) => match[1])

  for (const assetUrl of referencedAssets) {
    if (!precacheSet.has(assetUrl)) {
      throw new Error(`Built index references an asset outside the precache set: ${assetUrl}`)
    }
  }
}

async function bundleServiceWorker(input: {
  entryPath: string
  buildId: string
  shellDigest: string
  precacheUrls: string[]
  runtimeAssetUrls: string[]
  assetDigests: Record<string, string>
}) {
  const result = await Bun.build({
    entrypoints: [input.entryPath],
    target: "browser",
    format: "iife",
    minify: true,
    define: {
      __STILLON_APP_SHELL_BUILD_ID__: JSON.stringify(input.buildId),
      __STILLON_APP_SHELL_DIGEST__: JSON.stringify(input.shellDigest),
      __STILLON_APP_SHELL_PRECACHE_URLS__: JSON.stringify(input.precacheUrls),
      __STILLON_APP_SHELL_RUNTIME_ASSET_URLS__: JSON.stringify(input.runtimeAssetUrls),
      __STILLON_APP_SHELL_ASSET_DIGESTS__: JSON.stringify(input.assetDigests),
    },
  })

  if (!result.success) {
    const details = result.logs.map((log) => log.message).join("\n")
    throw new Error(`Failed to bundle the app-shell service worker:\n${details}`)
  }

  const output = result.outputs.find((candidate) => candidate.kind === "entry-point")
  if (!output) {
    throw new Error("Service-worker build did not produce an entry point")
  }
  return output.text()
}

export async function buildPwaAppShell(options: {
  manifestPath: string
  outDir: string
  workerEntryPath: string
}) {
  const indexPath = path.join(options.outDir, "index.html")
  const workerOutputPath = path.join(options.outDir, SERVICE_WORKER_FILE_NAME)

  const [manifestText, indexHtml] = await Promise.all([
    readFile(options.manifestPath, "utf8"),
    readFile(indexPath, "utf8"),
  ])
  const manifest = JSON.parse(manifestText) as ViteManifest
  const assets = collectAppShellAssets(manifest)
  assertIndexAssetsPrecached(indexHtml, assets.precacheUrls)
  const assetDigestEntries = await Promise.all(assets.runtimeAssetUrls.map(async (assetUrl) => {
    const assetPath = path.join(options.outDir, assetUrl.slice(1))
    await access(assetPath)
    const bytes = await readFile(assetPath)
    return [assetUrl, createHash("sha256").update(bytes).digest("hex")] as const
  }))
  const assetDigests = Object.fromEntries(assetDigestEntries)
  const workerTemplate = await bundleServiceWorker({
    entryPath: options.workerEntryPath,
    buildId: PENDING_BUILD_ID,
    shellDigest: PENDING_BUILD_ID,
    assetDigests,
    ...assets,
  })
  const buildId = createAppShellBuildId({
    indexHtml,
    workerTemplate,
    ...assets,
  })
  const markedIndexHtml = injectAppShellMarker(indexHtml, buildId)
  const shellDigest = createHash("sha256").update(markedIndexHtml).digest("hex")
  const workerBundle = await bundleServiceWorker({
    entryPath: options.workerEntryPath,
    buildId,
    shellDigest,
    assetDigests,
    ...assets,
  })

  if (
    workerBundle.includes(PENDING_BUILD_ID)
    || !workerBundle.includes(buildId)
    || !markedIndexHtml.includes(`content="${buildId}"`)
  ) {
    throw new Error("Generated app-shell artifacts disagree on the build id")
  }

  await Promise.all([
    writeFile(indexPath, markedIndexHtml, "utf8"),
    writeFile(workerOutputPath, workerBundle, "utf8"),
  ])
  await rm(options.manifestPath, { force: true })
  if (path.basename(path.dirname(options.manifestPath)) === ".vite") {
    await rm(path.dirname(options.manifestPath), { recursive: true, force: true })
  }

  return {
    buildId,
    shellDigest,
    assetDigests,
    workerOutputPath,
    ...assets,
  }
}

export function resolvePwaBuildPaths(
  config: Pick<ResolvedConfig, "root" | "build">,
  options: {
    rootDir?: string
    outDir?: string
    workerEntryPath?: string
  } = {},
) {
  const rootDir = path.resolve(options.rootDir ?? config.root)
  const outDir = path.resolve(rootDir, options.outDir ?? config.build.outDir)
  const manifestSetting = config.build.manifest
  if (manifestSetting === false) {
    throw new Error("The StillOn app-shell build requires Vite build.manifest")
  }
  const manifestFile = typeof manifestSetting === "string"
    ? manifestSetting
    : ".vite/manifest.json"
  return {
    manifestPath: path.resolve(outDir, manifestFile),
    outDir,
    workerEntryPath: path.resolve(rootDir, options.workerEntryPath ?? "src/service-worker.ts"),
  }
}

export function pwaAppShellPlugin(options: {
  rootDir?: string
  outDir?: string
  workerEntryPath?: string
} = {}): Plugin {
  let resolvedConfig: ResolvedConfig | null = null

  return {
    name: "stillon-pwa-app-shell",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      resolvedConfig = config
    },
    async closeBundle() {
      if (!resolvedConfig) {
        throw new Error("Vite config was not resolved before the app-shell build")
      }
      const { manifestPath, outDir, workerEntryPath } = resolvePwaBuildPaths(resolvedConfig, options)
      await buildPwaAppShell({
        manifestPath,
        outDir,
        workerEntryPath,
      })
    },
  }
}
