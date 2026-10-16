import { afterEach, expect, test } from "bun:test"
import { copyFile, link, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BUNDLE_FILE, artifactName, bundleFiles, bunRelativePath, sha256, verifyBundle, type RuntimeBundle } from "./bundle"
import { executeDesktopTransition, TRANSITION_FILE, type DesktopTransition, type TransitionNativeEffects } from "./transition"
import { appStatus, pauseManagedServer, waitUntil } from "../updater/control"
import { UpdateEngine, realUpdateEffects, enqueueUpdate } from "../updater/engine"
import { worker, withWorkerLease } from "../updater/entry"
import { atomicJson, exists, json, manifest } from "../updater/files"
import { updateTarget, type UpdateDeployment, type UpdateState } from "../updater/model"
import { preparePackage } from "./updates"
import { createManagedUpdateApi } from "../updater/api"

const desktopTest = process.platform === "darwin" || process.platform === "win32" ? test : test.skip
const entry = path.resolve(import.meta.dir, "../updater/entry.ts")
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function writeRuntime(root: string, version: string, packaged: boolean) {
  for (const name of ["bin", "src/server", "runtime", "dist/client/assets", "dist/export-viewer"]) await mkdir(path.join(root, name), { recursive: true })
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", version }))
  await writeFile(path.join(root, "src/server/cli.ts"), "export {}")
  await writeFile(path.join(root, "dist/client/index.html"), '<script src="/assets/fixture.js"></script>')
  await writeFile(path.join(root, "dist/client/assets/fixture.js"), version)
  await writeFile(path.join(root, "dist/export-viewer/index.html"), "fixture")
  await writeFile(path.join(root, "runtime/controller.js"), "import {controllerMain} from " + JSON.stringify(pathToFileURL(entry).href) + "; await controllerMain();")
  await writeFile(path.join(root, "bin/stillon"), `
import path from 'node:path';
const root=path.resolve(import.meta.dir,'..');
const {version}=await Bun.file(path.join(root,'package.json')).json();
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
const busy=path.join(process.env.HOME,'.stillon','busy-fixture');
const server=Bun.serve({hostname:'127.0.0.1',port,async fetch(req){
 const url=new URL(req.url);
 if(url.pathname==='/health')return Response.json({ok:true,version,port,updateProtocol:1,updateInstance:process.env.STILLON_UPDATE_INSTANCE});
 if(url.pathname.startsWith('/_stillon/update/')){
  if(req.headers.get('authorization')!=='Bearer '+process.env.STILLON_UPDATE_SECRET)return new Response(null,{status:403});
  if(url.pathname.endsWith('/check')&&await Bun.file(busy).exists())return new Response(null,{status:409});
  if(url.pathname.endsWith('/pause'))setTimeout(()=>server.stop(true),10);
  return new Response('ok');
 }
 const file=path.join(root,'dist/client',url.pathname==='/'?'index.html':url.pathname);
 return new Response(Bun.file(file));
}});
`)
  if (packaged) {
    await link(process.execPath, path.join(root, bunRelativePath(process.platform))).catch(() => copyFile(process.execPath, path.join(root, bunRelativePath(process.platform))))
    const bundle: RuntimeBundle = { schema: 1, version, buildId: "fixture-" + version, revision: "a".repeat(40),
      ...updateTarget(), bunVersion: Bun.version, minimumUpdaterProtocol: 1, files: await bundleFiles(root) }
    await atomicJson(path.join(root, BUNDLE_FILE), bundle)
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-migration-test-"))
  const oldRuntime = path.join(root, "source")
  const newRuntime = path.join(root, "releases/installer")
  await writeRuntime(oldRuntime, "1.0.0", false)
  await writeRuntime(newRuntime, "1.0.1", true)
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
  const port = reserve.port!; await reserve.stop(true)
  const home = path.join(root, "home")
  const dataRoot = path.join(home, ".stillon")
  await mkdir(dataRoot, { recursive: true })
  await writeFile(path.join(dataRoot, "history.json"), "original chat history")
  await writeFile(path.join(dataRoot, "settings.json"), "personal theme and settings")
  const environmentFile = path.join(root, "service.env")
  await writeFile(environmentFile, "MIGRATION_FIXTURE_VALUE=retained\n")
  const oldDeployment: UpdateDeployment = { schema: 1, ...updateTarget(), root, controller: entry, port, dataRoot,
    launch: { executable: process.execPath, workingDirectory: oldRuntime, homeDirectory: home, environmentFile,
      pathEnvironment: process.platform === "win32" ? process.env.PATH ?? "" : "/usr/bin:/bin", args: [path.join(oldRuntime, "bin/stillon"), "--port", String(port), "--strict-port", "--no-open"] } }
  const newDeployment: UpdateDeployment = { ...oldDeployment, controller: path.join(newRuntime, "runtime/controller.js"),
    launch: { ...oldDeployment.launch, executable: path.join(newRuntime, bunRelativePath(process.platform)), workingDirectory: newRuntime,
      args: oldDeployment.launch.args.map(arg => arg === path.join(oldRuntime, "bin/stillon") ? path.join(newRuntime, "bin/stillon") : arg) } }
  const t: DesktopTransition = { schema: 1, id: "fixture-migration", phase: "queued", oldRuntime, newRuntime, oldDeployment, newDeployment,
    app: { file: "fixture", bytes: "" }, updater: { file: "fixture", bytes: "" }, metadata: { "desktop.json": null, "desktop-receipt.json": null },
    sourceManifest: await manifest(oldRuntime, true), environmentHash: sha256(await Bun.file(environmentFile).bytes()), updatedAt: new Date().toISOString() }
  await atomicJson(path.join(root, "deployment.json"), oldDeployment)
  await atomicJson(path.join(root, "control.json"), { runtime: oldRuntime, paused: false })
  await atomicJson(path.join(root, TRANSITION_FILE), t)
  let controller: ReturnType<typeof Bun.spawn> | undefined
  const counts = { stop: 0, install: 0, restore: 0, updaterRestore: 0 }
  async function start(d: UpdateDeployment) {
    controller?.kill(); await controller?.exited
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(STILLON_|OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_)/.test(key)))
    controller = Bun.spawn([d.launch.executable, "--no-env-file", d.controller, "serve", root], {
      env: { ...env, HOME: home, USERPROFILE: home, PATH: d.launch.pathEnvironment },
      stdin: "ignore", stdout: Bun.file(path.join(root, "controller.log")), stderr: Bun.file(path.join(root, "controller-errors.log")),
    })
  }
  cleanups.push(async () => {
    await pauseManagedServer(oldDeployment).catch(() => {})
    controller?.kill(); await controller?.exited
    await rm(root, { recursive: true, force: true })
  })
  await start(oldDeployment)
  await waitUntil(async () => (await appStatus(oldDeployment))?.version === "1.0.0")
  const native: TransitionNativeEffects = { check: async () => {}, stopUpdater: async () => { counts.stop++ },
    install: async () => { counts.install++; await start(newDeployment) }, restore: async () => { counts.restore++; await start(oldDeployment) },
    restoreUpdater: async () => { counts.updaterRestore++ }, receipt: () => atomicJson(path.join(root, "desktop-receipt.json"), { fixture: "owned" }) }
  return { root, t, native, counts, dataRoot, environmentFile }
}

desktopTest("source -> installer -> prebuilt update preserves chats, settings, environment and package channel", async () => {
  const f = await fixture()
  await withWorkerLease(f.t.oldDeployment, () => executeDesktopTransition(f.t, f.native))
  expect((await json<DesktopTransition>(path.join(f.root, TRANSITION_FILE))).phase).toBe("succeeded")
  expect(await readFile(path.join(f.dataRoot, "history.json"), "utf8")).toBe("original chat history")
  expect(await readFile(path.join(f.dataRoot, "settings.json"), "utf8")).toBe("personal theme and settings")
  expect(await readFile(f.environmentFile, "utf8")).toBe("MIGRATION_FIXTURE_VALUE=retained\n")
  expect((await json<UpdateDeployment>(path.join(f.root, "deployment.json"))).launch.environmentFile).toBe(f.environmentFile)
  expect((await createManagedUpdateApi(f.t.newRuntime, f.root).read()).channel).toBe("package")
  expect(await exists(f.t.oldRuntime)).toBe(true)
  const third = path.join(f.root, "package-release")
  await writeRuntime(third, "1.0.2", true)
  const bundle = await verifyBundle(third)
  const files: Record<string, Uint8Array> = {}
  for (const name of [BUNDLE_FILE, ...Object.keys(bundle.files)]) files[name] = await Bun.file(path.join(third, name)).bytes()
  const archive = await new Bun.Archive(files, { compress: "gzip" }).bytes()
  const artifact = { ...updateTarget(), name: artifactName("1.0.2", bundle.platform, bundle.architecture), size: archive.byteLength, sha256: sha256(archive), buildId: bundle.buildId }
  const urls: string[] = []
  const effects = realUpdateEffects(f.t.newDeployment)
  effects.prepare = state => preparePackage(f.t.newDeployment, state, { probe: (d, r, t) => import("../updater/engine").then(m => m.probeRuntime(d, r, t)),
    download: async url => { urls.push(url); return url.endsWith(".json") ? new TextEncoder().encode(JSON.stringify({ schema: 1, tag: "v1.0.2", artifacts: [artifact] })) : archive } })
  await enqueueUpdate(f.t.newDeployment, "v1.0.2")
  await worker(f.t.newDeployment, { update: effects })
  expect((await json<UpdateState>(path.join(f.root, "state.json"))).phase).toBe("succeeded")
  expect((await appStatus(f.t.newDeployment))?.version).toBe("1.0.2")
  expect(urls).toHaveLength(2)
  expect(await readFile(path.join(f.dataRoot, "history.json"), "utf8")).toBe("original chat history")
  // Replaying a completed migration must never restore a stale data snapshot.
  await writeFile(path.join(f.dataRoot, "history.json"), "new message after success")
  await executeDesktopTransition(await json(path.join(f.root, TRANSITION_FILE)), f.native)
  expect(await readFile(path.join(f.dataRoot, "history.json"), "utf8")).toBe("new message after success")
}, 60_000)

desktopTest("failed installer activation restores source service, ownership and matched data; failed writes are quarantined", async () => {
  const f = await fixture()
  f.native.receipt = async () => {
    await writeFile(path.join(f.dataRoot, "history.json"), "failed migration write")
    await writeFile(path.join(f.dataRoot, "settings.json"), "failed theme migration")
    throw new Error("Intentional ownership commit failure")
  }
  await withWorkerLease(f.t.oldDeployment, () => executeDesktopTransition(f.t, f.native))
  expect((await json<DesktopTransition>(path.join(f.root, TRANSITION_FILE))).phase).toBe("rolled-back")
  expect((await json<UpdateDeployment>(path.join(f.root, "deployment.json"))).controller).toBe(f.t.oldDeployment.controller)
  expect(await exists(path.join(f.root, "desktop.json"))).toBe(false)
  expect(await exists(path.join(f.root, "desktop-receipt.json"))).toBe(false)
  expect(await readFile(path.join(f.dataRoot, "history.json"), "utf8")).toBe("original chat history")
  expect(await readFile(path.join(f.dataRoot, "settings.json"), "utf8")).toBe("personal theme and settings")
  expect(await readFile(path.join(path.dirname(f.dataRoot), ".stillon-after-failed-" + f.t.id, "history.json"), "utf8")).toBe("failed migration write")
  expect((await appStatus(f.t.oldDeployment))?.version).toBe("1.0.0")
  expect(f.counts.restore).toBe(1)
}, 45_000)

desktopTest("source edits stop migration before data or app services are switched", async () => {
  const f = await fixture()
  await writeFile(path.join(f.t.oldRuntime, "private-change.ts"), "keep this source change")
  await withWorkerLease(f.t.oldDeployment, () => executeDesktopTransition(f.t, f.native))
  expect((await json<DesktopTransition>(path.join(f.root, TRANSITION_FILE))).phase).toBe("failed")
  expect(f.counts.install).toBe(0)
  expect(f.counts.updaterRestore).toBe(1)
  expect((await appStatus(f.t.oldDeployment))?.version).toBe("1.0.0")
  expect(await readFile(path.join(f.dataRoot, "history.json"), "utf8")).toBe("original chat history")
}, 30_000)

desktopTest("killing a migration worker after candidate startup pauses work and independent recovery restores the source installation", async () => {
  const f = await fixture()
  const script = path.join(f.root, "interrupted.ts")
  await writeFile(script, `
import {executeDesktopTransition} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "transition.ts")).href)};
import {withWorkerLease} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "../updater/entry.ts")).href)};
import {json} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "../updater/files.ts")).href)};
const t=await json(${JSON.stringify(path.join(f.root, TRANSITION_FILE))});
const noop=async()=>{};
await withWorkerLease(t.oldDeployment,()=>executeDesktopTransition(t,{check:noop,stopUpdater:noop,install:noop,restore:noop,restoreUpdater:noop,
receipt:async()=>{await Bun.write(${JSON.stringify(path.join(f.dataRoot, "history.json"))},'interrupted candidate data');await Bun.write(${JSON.stringify(path.join(f.root, "kill-ready"))},'ready');await new Promise(()=>{});}}));
`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("STILLON_")))
  const first = Bun.spawn([process.execPath, script], { env, stdin: "ignore", stdout: "ignore", stderr: Bun.file(path.join(f.root, "migration-errors.log")) })
  cleanups.unshift(async () => { first.kill(); await first.exited })
  await waitUntil(() => exists(path.join(f.root, "kill-ready")), 30_000)
  first.kill(); await first.exited
  await waitUntil(async () => !await appStatus(f.t.oldDeployment))
  // Accelerate the documented stale-lock interval on this disposable fixture.
  await utimes(path.join(f.root, "worker.lock"), new Date(0), new Date(0))
  const pending = await json<DesktopTransition>(path.join(f.root, TRANSITION_FILE))
  await withWorkerLease(f.t.oldDeployment, () => executeDesktopTransition(pending, f.native))
  expect((await json<DesktopTransition>(path.join(f.root, TRANSITION_FILE))).phase).toBe("rolled-back")
  expect(await readFile(path.join(f.dataRoot, "history.json"), "utf8")).toBe("original chat history")
  expect((await appStatus(f.t.oldDeployment))?.version).toBe("1.0.0")
}, 60_000)


desktopTest("active work is rejected before the updater or application is stopped", async () => {
  const f = await fixture()
  await writeFile(path.join(f.dataRoot, "busy-fixture"), "active agent")
  await withWorkerLease(f.t.oldDeployment, () => executeDesktopTransition(f.t, f.native))
  expect((await json<DesktopTransition>(path.join(f.root, TRANSITION_FILE))).phase).toBe("failed")
  expect(f.counts.stop).toBe(0)
  expect(f.counts.install).toBe(0)
  expect(f.counts.restore).toBe(0)
  expect((await appStatus(f.t.oldDeployment))?.version).toBe("1.0.0")
}, 30_000)


desktopTest("a failed recovery journal write cannot publish success or unlock user work", async () => {
  const f = await fixture()
  const state: UpdateState = { id: "journal-failure", phase: "verifying", targetTag: "v1.0.1", prepareOnly: false,
    oldRuntime: f.t.oldRuntime, newRuntime: f.t.newRuntime, updatedAt: new Date().toISOString() }
  await atomicJson(path.join(f.root, "state.json"), state)
  await mkdir(path.join(f.root, "transactions"), { recursive: true })
  await writeFile(path.join(f.root, "transactions", state.id), "blocked journal directory")
  const noop = async () => {}
  const engine = new UpdateEngine(f.t.oldDeployment, { prepare: noop, pause: noop, resume: noop, verify: noop })
  engine.state = state
  await expect(engine.save("succeeded")).rejects.toThrow()
  expect(engine.state.phase).toBe("verifying")
  expect((await json<UpdateState>(path.join(f.root, "state.json"))).phase).toBe("verifying")
}, 30_000)
