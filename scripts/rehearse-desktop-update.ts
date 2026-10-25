import { assertAppearanceFixture, seedAppearanceFixture } from "./appearance-fixture"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { brotliCompressSync, gzipSync } from "node:zlib"
import { BUNDLE_FILE, artifactName, bunRelativePath, sha256, verifyBundle, type RuntimeBundle } from "../src/server/distribution/bundle"
import { preparePackage } from "../src/server/distribution/updates"
import { appStatus, pauseManagedServer, waitUntil } from "../src/server/updater/control"
import { enqueueUpdate, realUpdateEffects } from "../src/server/updater/engine"
import { worker } from "../src/server/updater/entry"
import { atomicJson, json } from "../src/server/updater/files"
import type { UpdateDeployment, UpdateState } from "../src/server/updater/model"
import { prepareRuntimeTransport } from "../src/server/connect/transport"

/** Real packaged app/controller, synthetic next release, disposable user data. */
export async function rehearseDesktopUpdate(runtime: string, root: string, env: NodeJS.ProcessEnv) {
  const previous = await verifyBundle(runtime)
  const parts = previous.version.split(".").map(Number)
  parts[parts.length - 1]++
  const version = parts.join(".")
  const candidate: RuntimeBundle = { ...previous, version, buildId: `${previous.buildId}-rehearsal`, files: { ...previous.files } }
  const files: Record<string, Uint8Array> = Object.create(null)
  for (const name of Object.keys(previous.files)) files[name] = await Bun.file(path.join(runtime, name)).bytes()
  const pkg = JSON.parse(new TextDecoder().decode(files["package.json"]))
  pkg.version = version
  files["package.json"] = new TextEncoder().encode(JSON.stringify(pkg, null, 2) + "\n")
  files["dist/client/index.html"] = new TextEncoder().encode(new TextDecoder().decode(files["dist/client/index.html"]) + `\n<!-- update rehearsal ${version} -->\n`)
  const changed = ["package.json", "dist/client/index.html"]
  for (const [suffix, compress] of [[".gz", gzipSync], [".br", brotliCompressSync]] as const) {
    const name = `dist/client/index.html${suffix}`
    if (files[name]) { files[name] = compress(files["dist/client/index.html"]); changed.push(name) }
  }
  for (const name of changed) candidate.files[name] = { ...candidate.files[name], sha256: sha256(files[name]), size: files[name].byteLength }
  files[BUNDLE_FILE] = new TextEncoder().encode(JSON.stringify(candidate))
  const bytes = await new Bun.Archive(files, { compress: "gzip" }).bytes()
  const artifact = { platform: candidate.platform, architecture: candidate.architecture, name: artifactName(version, candidate.platform, candidate.architecture),
    buildId: candidate.buildId, sha256: sha256(bytes), size: bytes.byteLength }
  const metadata = new TextEncoder().encode(JSON.stringify({ schema: 1, tag: `v${version}`, artifacts: [artifact] }))
  let downloads = 0
  const downloader = async (url: string) => { downloads++; return url.endsWith(".json") ? metadata : bytes }
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
  const port = reservation.port!; await reservation.stop(true)
  const home = path.join(root, "home")
  const deployment: UpdateDeployment = { schema: 1, platform: previous.platform, architecture: previous.architecture,
    root, port, controller: path.join(runtime, "runtime/controller.js"), dataRoot: path.join(home, ".stillon"),
    launch: { executable: path.join(runtime, bunRelativePath(previous.platform)),
      args: [path.join(runtime, "bin/stillon"), "--no-open", "--strict-port", "--port", String(port)],
      workingDirectory: runtime, homeDirectory: home, pathEnvironment: env.PATH ?? "", localAppDataDirectory: path.join(home, "AppData/Local") } }
  const skin = path.join(deployment.dataRoot, "customizations/skins/personal/custom.css")
  await mkdir(path.dirname(skin), { recursive: true }); await writeFile(skin, "user-owned-skin")
  const personalAppearance = await seedAppearanceFixture(deployment.dataRoot)
  await atomicJson(path.join(root, "deployment.json"), deployment)
  await atomicJson(path.join(root, "control.json"), { runtime, paused: false })
  await prepareRuntimeTransport(runtime, { homeDirectory: home, localAppDataDirectory: deployment.launch.localAppDataDirectory })
  const controller = Bun.spawn([deployment.launch.executable, "--no-env-file", deployment.controller, "serve", root], {
    cwd: runtime, env: { ...env, HOME: home, USERPROFILE: home, LOCALAPPDATA: deployment.launch.localAppDataDirectory },
    stdin: "ignore", stdout: Bun.file(path.join(root, "controller.out.log")), stderr: Bun.file(path.join(root, "controller.err.log")),
  })
  try {
    await waitUntil(async () => (await appStatus(deployment))?.version === previous.version)
    const effects = realUpdateEffects(deployment)
    effects.prepare = (state) => preparePackage(deployment, state, { download: downloader, probe: realProbe })
    const verify = effects.verify
    let fail = true
    effects.verify = async (selected) => {
      await verify(selected)
      if (fail && selected !== runtime) {
        await writeFile(skin, "failed-version-migration")
        for (const file of [personalAppearance.settingsPath, personalAppearance.assetPath, personalAppearance.skinPath]) await writeFile(file, "failed-version-appearance")
        throw new Error("Intentional candidate health failure")
      }
    }
    await enqueueUpdate(deployment, `v${version}`)
    await worker(deployment, { update: effects })
    const rolledBack = await json<UpdateState>(path.join(root, "state.json"))
    if (rolledBack.phase !== "rolled-back" || await readFile(skin, "utf8") !== "user-owned-skin") throw new Error(`Packaged rollback did not restore the original skin (${rolledBack.phase}: ${rolledBack.error ?? "no transaction error"})`)
    const quarantine = path.join(home, `.stillon-after-failed-${rolledBack.id}`, "customizations/skins/personal/custom.css")
    if (await readFile(quarantine, "utf8") !== "failed-version-migration") throw new Error("Failed-version customizations were not quarantined")
    await assertAppearanceFixture(deployment.dataRoot)
    fail = false
    await enqueueUpdate(deployment, `v${version}`)
    await worker(deployment, { update: effects })
    const success = await json<UpdateState>(path.join(root, "state.json"))
    if (success.phase !== "succeeded" || (await appStatus(deployment))?.version !== version || await readFile(skin, "utf8") !== "user-owned-skin") throw new Error(`Packaged upgrade did not preserve the personal skin (${success.phase}: ${success.error ?? "no transaction error"})`)
    await assertAppearanceFixture(deployment.dataRoot)
    if (downloads !== 2) throw new Error("The prepared candidate was downloaded again instead of reused")
    return { status: "passed", oldVersion: previous.version, fixtureVersion: version, downloads,
      checks: ["real bundled controller and application", "download/unpack/probe/switch", "failed-version skin quarantined and rollback restored", "prepared package reused", "successful upgrade preserved personal skin", "appearance settings and portable background survived update/rollback"] }
  } finally {
    await pauseManagedServer(deployment).catch(() => {})
    controller.kill(); await controller.exited
  }
}

import { probeRuntime as realProbe } from "../src/server/updater/engine"
