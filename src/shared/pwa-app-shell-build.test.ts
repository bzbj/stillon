import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  APP_SHELL_MARKER_NAME,
  assertIndexAssetsPrecached,
  collectAppShellAssets,
  createAppShellBuildId,
  injectAppShellMarker,
  resolvePwaBuildPaths,
  type ViteManifest,
} from "../../scripts/pwa-app-shell-build"

function createManifest(): ViteManifest {
  return {
    "index.html": {
      file: "assets/index-AAAAAAAA.js",
      src: "index.html",
      isEntry: true,
      imports: ["_react"],
      dynamicImports: ["src/chat.tsx"],
      css: ["assets/index-BBBBBBBB.css"],
      assets: ["assets/body-CCCCCCCC.woff2"],
    },
    _react: {
      file: "assets/react-DDDDDDDD.js",
    },
    "src/chat.tsx": {
      file: "assets/chat-EEEEEEEE.js",
      css: ["assets/chat-FFFFFFFF.css"],
    },
  }
}

describe("PWA app-shell build manifest", () => {
  test("precaches only the entry's static closure and allowlists lazy hashed assets", () => {
    expect(collectAppShellAssets(createManifest())).toEqual({
      precacheUrls: [
        "/assets/body-CCCCCCCC.woff2",
        "/assets/index-AAAAAAAA.js",
        "/assets/index-BBBBBBBB.css",
        "/assets/react-DDDDDDDD.js",
      ],
      runtimeAssetUrls: [
        "/assets/body-CCCCCCCC.woff2",
        "/assets/chat-EEEEEEEE.js",
        "/assets/chat-FFFFFFFF.css",
        "/assets/index-AAAAAAAA.js",
        "/assets/index-BBBBBBBB.css",
        "/assets/react-DDDDDDDD.js",
      ],
    })
  })

  test("is stable across manifest insertion order", () => {
    const manifest = createManifest()
    const reversed = Object.fromEntries(Object.entries(manifest).reverse())
    expect(collectAppShellAssets(reversed)).toEqual(collectAppShellAssets(manifest))
  })

  test("rejects unversioned or missing manifest assets", () => {
    const unversioned = createManifest()
    unversioned._react.file = "assets/react.js"
    expect(() => collectAppShellAssets(unversioned)).toThrow("not a versioned Vite output")

    const missingImport = createManifest()
    missingImport["index.html"].imports = ["_missing"]
    expect(() => collectAppShellAssets(missingImport)).toThrow("missing static import")
  })

  test("derives a deterministic build id from the shell, worker, and exact allowlists", () => {
    const assets = collectAppShellAssets(createManifest())
    const input = {
      indexHtml: "<!doctype html><head></head>",
      workerTemplate: "worker-v1",
      ...assets,
    }
    const first = createAppShellBuildId(input)

    expect(first).toMatch(/^[a-f0-9]{20}$/)
    expect(createAppShellBuildId(input)).toBe(first)
    expect(createAppShellBuildId({ ...input, workerTemplate: "worker-v2" })).not.toBe(first)
    expect(createAppShellBuildId({
      ...input,
      runtimeAssetUrls: [...input.runtimeAssetUrls, "/assets/new-GGGGGGGG.js"],
    })).not.toBe(first)
  })

  test("injects exactly one verifiable shell marker", () => {
    const buildId = "0123456789abcdefabcd"
    const html = injectAppShellMarker("<!doctype html><html><head></head><body></body></html>", buildId)

    expect(html).toContain(`<meta name="${APP_SHELL_MARKER_NAME}" content="${buildId}" />`)
    expect(() => injectAppShellMarker(html, buildId)).toThrow("already contains")
  })

  test("requires every built index dependency to be in the eager cache", () => {
    const indexHtml = [
      '<script type="module" src="/assets/index-AAAAAAAA.js"></script>',
      '<link rel="stylesheet" href="/assets/index-BBBBBBBB.css">',
    ].join("")
    expect(() => assertIndexAssetsPrecached(indexHtml, [
      "/assets/index-AAAAAAAA.js",
      "/assets/index-BBBBBBBB.css",
    ])).not.toThrow()
    expect(() => assertIndexAssetsPrecached(indexHtml, [
      "/assets/index-AAAAAAAA.js",
    ])).toThrow("outside the precache set")
  })

  test("follows Vite's resolved output directory, including CLI overrides", () => {
    const root = path.resolve("repo")
    const outDir = path.resolve(root, "..", "custom-client")
    expect(resolvePwaBuildPaths({
      root,
      build: {
        manifest: "custom-manifest.json",
        outDir: path.join("..", "custom-client"),
      },
    } as never)).toEqual({
      manifestPath: path.join(outDir, "custom-manifest.json"),
      outDir,
      workerEntryPath: path.join(root, "src", "service-worker.ts"),
    })
  })
})
