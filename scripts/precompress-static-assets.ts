import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib"

const DEFAULT_MINIMUM_BYTES = 1_024
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
  ".xml",
])

export interface PrecompressedStaticAsset {
  relativePath: string
  originalBytes: number
  brotliBytes?: number
  gzipBytes?: number
}

export interface PrecompressedStaticAssetsSummary {
  assets: PrecompressedStaticAsset[]
  originalBytes: number
  brotliBytes: number
  gzipBytes: number
}

export interface PrecompressStaticAssetsOptions {
  minimumBytes?: number
}

export function shouldPrecompressStaticAsset(filePath: string, size: number, minimumBytes = DEFAULT_MINIMUM_BYTES) {
  if (!Number.isSafeInteger(size) || size < minimumBytes) {
    return false
  }
  return COMPRESSIBLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

async function collectFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(rootDir, absolutePath))
    } else if (entry.isFile() && !entry.name.endsWith(".br") && !entry.name.endsWith(".gz")) {
      files.push(absolutePath)
    }
  }

  return files
}

export async function precompressStaticAssets(
  rootDir: string,
  options: PrecompressStaticAssetsOptions = {},
): Promise<PrecompressedStaticAssetsSummary> {
  const minimumBytes = options.minimumBytes ?? DEFAULT_MINIMUM_BYTES
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 0) {
    throw new Error("minimumBytes must be a non-negative safe integer")
  }

  const absoluteRoot = path.resolve(rootDir)
  const files = await collectFiles(absoluteRoot)
  const assets: PrecompressedStaticAsset[] = []

  for (const filePath of files.sort()) {
    const input = await readFile(filePath)
    if (!shouldPrecompressStaticAsset(filePath, input.byteLength, minimumBytes)) {
      continue
    }

    const result: PrecompressedStaticAsset = {
      relativePath: path.relative(absoluteRoot, filePath).split(path.sep).join("/"),
      originalBytes: input.byteLength,
    }
    const brotli = brotliCompressSync(input, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: input.byteLength,
      },
    })
    const gzip = gzipSync(input, { level: 9 })

    if (brotli.byteLength < input.byteLength) {
      await writeFile(`${filePath}.br`, brotli)
      result.brotliBytes = brotli.byteLength
    }
    if (gzip.byteLength < input.byteLength) {
      await writeFile(`${filePath}.gz`, gzip)
      result.gzipBytes = gzip.byteLength
    }
    assets.push(result)
  }

  return {
    assets,
    originalBytes: assets.reduce((total, asset) => total + asset.originalBytes, 0),
    brotliBytes: assets.reduce((total, asset) => total + (asset.brotliBytes ?? asset.originalBytes), 0),
    gzipBytes: assets.reduce((total, asset) => total + (asset.gzipBytes ?? asset.originalBytes), 0),
  }
}
