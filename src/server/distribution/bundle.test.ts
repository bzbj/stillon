import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BUNDLE_FILE, artifactName, bundleFiles, bunRelativePath, selectArtifact, sha256, unpackBundle, validateBundlePath, verifyBundle, type RuntimeBundle } from "./bundle"
import { preparePackage } from "./updates"
import { atomicJson, json } from "../updater/files"
import type { UpdateDeployment, UpdateState } from "../updater/model"
import { desktopPath } from "./desktop"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function temp() { const root = await mkdtemp(path.join(os.tmpdir(), "stillon-distribution-")); roots.push(root); return root }
const target = { platform: "darwin", architecture: "arm64" } as const

async function fixture(root: string, version = "1.0.0") {
  const contents: Record<string, string> = {
    "package.json": JSON.stringify({ version }), "bin/stillon": "// cli", "src/server/cli.ts": "// server",
    "dist/client/index.html": "<script src='/assets/app.js'></script>", "dist/export-viewer/index.html": "viewer",
    "runtime/controller.js": "// independent updater", [bunRelativePath(target.platform)]: "test-bun",
  }
  for (const [name, value] of Object.entries(contents)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), value)
  }
  await chmod(path.join(root, bunRelativePath(target.platform)), 0o755)
  const bundle: RuntimeBundle = { schema: 1, version, buildId: `${version}-fixture`, revision: "a".repeat(40),
    ...target, bunVersion: "1.3.14", minimumUpdaterProtocol: 1, files: await bundleFiles(root) }
  await atomicJson(path.join(root, BUNDLE_FILE), bundle)
  const files: Record<string, Blob> = {}
  for (const name of [...Object.keys(contents), BUNDLE_FILE]) files[name] = new Blob([await Bun.file(path.join(root, name)).bytes()])
  const bytes = await new Bun.Archive(files, { compress: "gzip" }).bytes()
  return { bundle, files, bytes }
}

describe("complete runtime bundles", () => {
  test("unpacks and verifies an executable runtime without invoking a build or package manager", async () => {
    const root = await temp()
    const f = await fixture(path.join(root, "source"))
    const dest = path.join(root, "installed")
    expect(await unpackBundle(f.bytes, dest, target)).toEqual(f.bundle)
    expect(await verifyBundle(dest, target)).toEqual(f.bundle)
    await expect(unpackBundle(f.bytes, dest, target)).rejects.toThrow("overwrite")
  })
  test("wrong architecture and version are rejected before creating a runtime", async () => {
    const root = await temp(); const f = await fixture(path.join(root, "source"))
    await expect(unpackBundle(f.bytes, path.join(root, "wrong"), { platform: "win32", architecture: "arm64" })).rejects.toThrow("mismatch")
    await expect(unpackBundle(f.bytes, path.join(root, "wrong"), { ...target, tag: "2.0.0" })).rejects.toThrow("mismatch")
    expect(await Bun.file(path.join(root, "wrong", BUNDLE_FILE)).exists()).toBe(false)
  })
  test("altered code and added private files stop automatic package upgrades", async () => {
    const root = await temp(); await fixture(root)
    await writeFile(path.join(root, "src/server/cli.ts"), "changed")
    await expect(verifyBundle(root)).rejects.toThrow("files changed")
    await fixture(root)
    await mkdir(path.join(root, ".stillon"))
    await writeFile(path.join(root, ".stillon", "private.json"), "history")
    await expect(verifyBundle(root)).rejects.toThrow("files changed")
  })
  test("archive data must match all manifest digests", async () => {
    const root = await temp(); const f = await fixture(path.join(root, "source"))
    f.files["src/server/cli.ts"] = new Blob(["tampered"])
    const bytes = await new Bun.Archive(f.files, { compress: "gzip" }).bytes()
    await expect(unpackBundle(bytes, path.join(root, "bad"), target)).rejects.toThrow("checksum")
  })
  test("runtime symlinks are rejected", async () => {
    if (process.platform === "win32") return // Windows CI independently validates symlink-free extracted packages.
    const root = await temp(); await fixture(root)
    await symlink("src/server/cli.ts", path.join(root, "link"))
    await expect(verifyBundle(root)).rejects.toThrow("links")
  })
  test("all target paths reject traversal, drive/ADS, reserved names and ambiguous separators", () => {
    for (const name of ["../file", "/file", "C:/file", "file:stream", "a\\b", "a/../b", "a//b", "CON.txt", "a./b", "a /b", "a/./b", "a\u0000b"]) {
      expect(() => validateBundlePath(name)).toThrow()
    }
    expect(validateBundlePath("node_modules/@scope/pkg/index.js")).toBe("node_modules/@scope/pkg/index.js")
  })
  test("release lookup requires one exact platform artifact from the requested tag", () => {
    const artifact = { ...target, name: artifactName("1.0.0", target.platform, target.architecture), sha256: "a".repeat(64), size: 10, buildId: "fixture" }
    expect(selectArtifact({ schema: 1, tag: "v1.0.0", artifacts: [artifact] }, "1.0.0", target)).toEqual(artifact)
    expect(() => selectArtifact({ schema: 1, tag: "v1.0.0", artifacts: [artifact, artifact] }, "1.0.0", target)).toThrow("unique")
    expect(() => selectArtifact({ schema: 1, tag: "v2.0.0", artifacts: [artifact] }, "1.0.0", target)).toThrow()
    expect(() => selectArtifact({ schema: 1, tag: "v1.0.0", artifacts: [{ ...artifact, name: "https://other.example/package" }] }, "1.0.0", target)).toThrow()
  })
})

test("prepared packages are reused, reprobed and invalidated by configuration changes", async () => {
  const root = await temp()
  const old = path.join(root, "old"); await fixture(old)
  const next = await fixture(path.join(root, "next"), "1.0.1")
  const artifact = { ...target, name: artifactName("1.0.1", target.platform, target.architecture), sha256: sha256(next.bytes), size: next.bytes.byteLength, buildId: next.bundle.buildId }
  const deployment: UpdateDeployment = { schema: 1, ...target, root, port: 3210, dataRoot: path.join(root, "home", ".stillon"), controller: "controller",
    launch: { executable: "bun", args: [], workingDirectory: old, homeDirectory: path.join(root, "home"), pathEnvironment: "test" } }
  const state: UpdateState = { id: "first", phase: "preparing", prepareOnly: true, targetTag: "v1.0.1", oldRuntime: old,
    newRuntime: path.join(root, "releases", "first", "v1.0.1"), updatedAt: new Date().toISOString() }
  let downloads = 0; let probes = 0
  const effects = {
    download: async (url: string) => { downloads++; return url.endsWith(".json")
      ? new TextEncoder().encode(JSON.stringify({ schema: 1, tag: "v1.0.1", artifacts: [artifact] })) : next.bytes },
    probe: async () => { probes++ },
  }
  await preparePackage(deployment, state, effects)
  const second = { ...state, id: "second", newRuntime: path.join(root, "releases", "second", "v1.0.1") }
  await preparePackage(deployment, second, effects)
  expect(downloads).toBe(2); expect(probes).toBe(2); expect(second.newRuntime).toBe(state.newRuntime)
  deployment.launch.pathEnvironment = "changed"
  const third = { ...state, id: "third", newRuntime: path.join(root, "releases", "third", "v1.0.1") }
  await preparePackage(deployment, third, effects)
  expect(downloads).toBe(4); expect(probes).toBe(3)
  expect((await json<{ runtime: string }>(path.join(root, "prepared-package.json"))).runtime).toBe(third.newRuntime)
})

test("desktop PATH includes provider CLI locations without shell evaluation", () => {
  expect(desktopPath("/Users/example", "darwin", "/usr/bin:/custom/bin")).toContain("/Users/example/.local/bin")
  expect(desktopPath("C:\\Users\\example", "win32", "C:\\Windows")).toContain("C:\\Users\\example\\AppData\\Roaming\\npm")
})
