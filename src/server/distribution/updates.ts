import { mkdir } from "node:fs/promises"
import path from "node:path"
import { appCommand } from "../updater/control"
import { probeRuntime } from "../updater/engine"
import { atomicJson, exists, inside, json, manifest } from "../updater/files"
import { newerRelease, releaseTag, type UpdateDeployment, type UpdateRunnerStatus, type UpdateState } from "../updater/model"
import { MAX_ARCHIVE_BYTES, RELEASE_FILE, selectArtifact, sha256, unpackBundle, verifyBundle } from "./bundle"

const RELEASE_BASE = "https://github.com/bzbj/stillon/releases/download"

export async function download(url: string, limit: number, fetcher = fetch): Promise<Uint8Array> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(300_000), headers: { Accept: "application/octet-stream" } })
  if (!response.ok || !response.body) throw new Error(`Package download failed (HTTP ${response.status}). Retry when the release assets are available.`)
  const announced = Number(response.headers.get("content-length"))
  if (Number.isFinite(announced) && announced > limit) throw new Error("Package download is too large")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error("Package download is too large")
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return new Uint8Array(Buffer.concat(chunks, total))
}

export interface PreparedPackage {
  schema: 1
  targetTag: string
  oldRuntime: string
  oldBuildId: string
  launchDigest: string
  runtime: string
  buildId: string
}

export async function preparePackage(deployment: UpdateDeployment, state: UpdateState, effects = { download, probe: probeRuntime }) {
  const expected = { platform: deployment.platform, architecture: deployment.architecture }
  const previous = await verifyBundle(state.oldRuntime, expected)
  if (!newerRelease(state.targetTag, previous.version)) throw new Error("The requested release must be newer than the active version.")
  const launchDigest = sha256(JSON.stringify(deployment.launch) + (deployment.launch.environmentFile
    ? sha256(await Bun.file(deployment.launch.environmentFile).bytes()) : ""))
  const transaction = inside(path.join(deployment.root, "transactions"), state.id)
  await mkdir(transaction, { recursive: true, mode: 0o700 })
  const cacheFile = path.join(deployment.root, "prepared-package.json")
  let reused = false
  if (await exists(cacheFile)) {
    const saved = await json<PreparedPackage>(cacheFile)
    if (saved.schema === 1 && saved.targetTag === state.targetTag && saved.oldRuntime === state.oldRuntime
      && saved.oldBuildId === previous.buildId && saved.launchDigest === launchDigest) {
      const releases = path.join(deployment.root, "releases")
      inside(releases, path.relative(releases, saved.runtime))
      const candidate = await verifyBundle(saved.runtime, { ...expected, tag: state.targetTag })
      if (candidate.buildId !== saved.buildId) throw new Error("Prepared package identity changed")
      state.newRuntime = saved.runtime
      reused = true
    }
  }
  if (!reused) {
    const base = `${RELEASE_BASE}/${releaseTag(state.targetTag)}`
    const metadata = JSON.parse(new TextDecoder().decode(await effects.download(`${base}/${RELEASE_FILE}`, 1024 * 1024)))
    const artifact = selectArtifact(metadata, state.targetTag, expected)
    const bytes = await effects.download(`${base}/${artifact.name}`, Math.min(artifact.size, MAX_ARCHIVE_BYTES))
    if (bytes.byteLength !== artifact.size || sha256(bytes) !== artifact.sha256) throw new Error("Downloaded runtime checksum mismatch")
    const bundle = await unpackBundle(bytes, state.newRuntime, { ...expected, tag: state.targetTag })
    if (bundle.buildId !== artifact.buildId) throw new Error("Downloaded runtime build identity mismatch")
    await atomicJson(path.join(transaction, "package.json"), { artifact, reused: false })
  }
  await effects.probe(deployment, state.newRuntime, transaction)
  await verifyBundle(state.oldRuntime, expected)
  const candidate = await verifyBundle(state.newRuntime, { ...expected, tag: state.targetTag })
  const baselinesFile = path.join(deployment.root, "build-manifests.json")
  const baselines = await exists(baselinesFile) ? await json<Record<string, unknown>>(baselinesFile) : {}
  baselines[state.newRuntime] = await manifest(path.join(state.newRuntime, "dist"))
  await atomicJson(baselinesFile, baselines)
  await atomicJson(cacheFile, { schema: 1, targetTag: state.targetTag, oldRuntime: state.oldRuntime,
    oldBuildId: previous.buildId, launchDigest, runtime: state.newRuntime, buildId: candidate.buildId } satisfies PreparedPackage)
  if (!state.prepareOnly) {
    const runner = await json<UpdateRunnerStatus>(path.join(deployment.root, "runner.json"))
    await appCommand(deployment, runner.secret, "check")
  }
}
