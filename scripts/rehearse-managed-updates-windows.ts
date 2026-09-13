/** Explicit, local OS lifecycle rehearsal. Registers only two uniquely named temporary tasks. */
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { runServiceCommand } from "../src/server/service"
import { assertCommandSucceeded, type ServiceCommandRunner } from "../src/server/service/types"
import { getWindowsServicePaths, windowsServiceBackend } from "../src/server/service/windows"
import { appStatus, leaseAlive, waitUntil } from "../src/server/updater/control"
import { controllerMain, worker } from "../src/server/updater/entry"
import { realUpdateEffects } from "../src/server/updater/engine"
import { atomicJson, exists, json } from "../src/server/updater/files"
import { updateTarget, type UpdateDeployment, type UpdateRunnerStatus, type UpdateState } from "../src/server/updater/model"
import { installUpdateWorker, wakeUpdateWorker } from "../src/server/updater/native"
import { stopOrphanedApp, stopWindowsEncodedProcesses, stopWindowsServiceProcesses } from "../src/server/updater/processes"
import { hashServiceFile, windowsServiceCommand, windowsServiceHash, type ServiceRegistration } from "../src/server/updater/registration"
import { checkSetupReadiness, realSetupEffects, type SetupState } from "../src/server/updater/setup"
export { createManagedAppControl } from "../src/server/updater/app-control"

interface Scope { app: string; updater: string }
function scopedRunner(scope: Scope): ServiceCommandRunner {
  const pattern = /^StillOn\.Rehearsal\.[0-9a-f-]{36}\.(App|Updater)$/
  if (!pattern.test(scope.app) || !pattern.test(scope.updater)) throw new Error("Invalid isolated task names")
  return async (command, args, options) => {
    if (command.toLowerCase() === "schtasks.exe") {
      const index = args.indexOf("/TN")
      const mapped = args[index + 1] === "StillOn" ? scope.app : args[index + 1] === "StillOn Updater" ? scope.updater : args[index + 1]
      if (index < 0 || ![scope.app, scope.updater].includes(mapped)) throw new Error("Refusing a task outside the rehearsal scope")
      args = args.map((value, i) => i === index + 1 ? mapped : value)
    } else if (command.toLowerCase() !== "whoami.exe") throw new Error("Unexpected native service command")
    return runServiceCommand(command, args, options)
  }
}

async function fixtureRuntime(runtime: string, version: string, controller: string) {
  await mkdir(path.join(runtime, "bin"), { recursive: true })
  await mkdir(path.join(runtime, "dist/client/assets"), { recursive: true })
  await atomicJson(path.join(runtime, "package.json"), { type: "module", version })
  await writeFile(path.join(runtime, "dist/client/index.html"), '<html><script src="/assets/app.js"></script></html>')
  await writeFile(path.join(runtime, "dist/client/assets/app.js"), `console.log(${JSON.stringify(version)})`)
  await writeFile(path.join(runtime, "bin/stillon"), `
import path from 'node:path';
import {createManagedAppControl} from ${JSON.stringify(pathToFileURL(controller).href)};
const root=path.resolve(import.meta.dir,'..');const data=path.join(process.env.HOME,'.stillon');const version=${JSON.stringify(version)};
if(version==='1.0.1')await Bun.write(path.join(data,'history.json'),'migrated');
const control=createManagedAppControl({instance:process.env.STILLON_UPDATE_INSTANCE,secret:process.env.STILLON_UPDATE_SECRET,verifying:process.env.STILLON_UPDATE_VERIFYING==='1',busy:()=>false,shutdown:async()=>{await server.stop(true);process.emit('SIGTERM')}});
const server=Bun.serve({hostname:'127.0.0.1',port:Number(process.argv[process.argv.indexOf('--port')+1]),fetch(req){
const result=control.handle(req,'127.0.0.1');if(result)return result;const route=new URL(req.url).pathname;
if(route==='/health')return Response.json({ok:true,port:server.port,version,updateInstance:control.instance,updateProtocol:1,managedUpdateProtocol:1,runtimeProfile:'prod',busy:false});
return new Response(Bun.file(path.join(root,'dist/client',route==='/'?'index.html':route.slice(1))));}});
await new Promise(resolve=>process.once('SIGTERM',resolve));await server.stop(true);
`)
}

async function runFixtureWorker(root: string) {
  const deployment = await json<UpdateDeployment>(path.join(root, "deployment.json"))
  const run = scopedRunner(await json<Scope>(path.join(root, "scope.json")))
  const update = realUpdateEffects(deployment)
  update.prepare = async () => {} // Fixture releases are prepared before queueing; Git/build is rehearsed separately.
  const verify = update.verify
  update.verify = async (runtime) => {
    await verify(runtime)
    if (runtime !== deployment.launch.workingDirectory && !await exists(path.join(root, "update-killed.json"))) {
      await atomicJson(path.join(root, "update-ready.json"), { ready: true })
      await new Promise(() => {})
    }
  }
  await worker(deployment, { update, setup(setup) {
    const effects = realSetupEffects(deployment, setup.registration, run)
    const check = effects.verify
    effects.verify = async () => {
      await check()
      if (!await exists(path.join(root, "setup-killed.json"))) {
        await atomicJson(path.join(root, "setup-ready.json"), { ready: true })
        await new Promise(() => {})
      }
    }
    return effects
  } })
}

async function rehearse() {
  if (process.platform !== "win32") throw new Error("This native rehearsal requires a logged-in Windows session")
  const started = Date.now()
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-native-rehearsal-"))
  const id = randomUUID()
  const scope: Scope = { app: `StillOn.Rehearsal.${id}.App`, updater: `StillOn.Rehearsal.${id}.Updater` }
  const run = scopedRunner(scope)
  await atomicJson(path.join(root, "scope.json"), scope)
  console.log(`Rehearsal artifacts: ${root}`)
  const controller = path.join(root, "controller.js")
  const build = await Bun.build({ entrypoints: [import.meta.path], outdir: root, naming: "controller.js", target: "bun", packages: "bundle" })
  if (!build.success) throw new AggregateError(build.logs, "Rehearsal controller build failed")
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
  const port = reserve.port!; await reserve.stop(true)
  const runtime = path.join(root, "old")
  const home = path.join(root, "home")
  const deployment: UpdateDeployment = { schema: 1, ...updateTarget(), root, controller, port, dataRoot: path.join(home, ".stillon"),
    launch: { executable: process.execPath, workingDirectory: runtime, homeDirectory: home, localAppDataDirectory: path.join(root, "local"),
      pathEnvironment: process.env.PATH ?? "", args: [path.join(runtime, "bin", "stillon"), "--port", String(port), "--no-open", "--strict-port"] } }
  await fixtureRuntime(runtime, "1.0.0", controller)
  await mkdir(deployment.dataRoot, { recursive: true })
  await writeFile(path.join(deployment.dataRoot, "history.json"), "original")
  await atomicJson(path.join(root, "deployment.json"), deployment)
  await atomicJson(path.join(root, "control.json"), { runtime, paused: false })
  async function stopWorkerProcesses() {
    const taskFile = path.join(root, "updater-task.xml")
    if (!await exists(taskFile)) return
    const xml = Buffer.from(await Bun.file(taskFile).arrayBuffer()).toString("utf16le")
    const encoded = xml.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1]
    if (!encoded) throw new Error("The scoped worker task has no command identity")
    await stopWindowsEncodedProcesses(encoded)
  }
  try {
    await windowsServiceBackend.install({ launch: deployment.launch, run, log: () => {}, warn: console.warn })
    await waitUntil(async () => { try { await checkSetupReadiness(deployment); return true } catch { return false } })
    const serviceFile = getWindowsServicePaths(deployment.launch).taskXml
    const registration: ServiceRegistration = { schema: 1, platform: "win32", launch: deployment.launch, serviceFile,
      serviceHash: await hashServiceFile(serviceFile), nativeHash: await windowsServiceHash(run), windowsCommand: await windowsServiceCommand(serviceFile) }
    const queued = { phase: "queued", registration, updatedAt: new Date().toISOString() }
    await atomicJson(path.join(root, "setup.json"), queued)
    await installUpdateWorker(deployment, run)
    await wakeUpdateWorker(deployment, run)
    await waitUntil(() => exists(path.join(root, "setup-ready.json")), 120_000)
    await atomicJson(path.join(root, "setup-killed.json"), { killed: true })
    assertCommandSucceeded("Stop isolated setup worker", await run("schtasks.exe", ["/End", "/TN", scope.updater]))
    await stopWorkerProcesses()
    console.log("First-time setup worker terminated. Waiting for the scheduler to recover the original service...")
    await waitUntil(async () => (await json<SetupState>(path.join(root, "setup.json"))).phase === "restored", 150_000)
    await checkSetupReadiness(deployment)
    await waitUntil(async () => !await leaseAlive(root))
    console.log("Original service recovered automatically. Retrying first-time setup...")
    await atomicJson(path.join(root, "setup.json"), queued)
    await wakeUpdateWorker(deployment, run)
    await waitUntil(async () => (await json<SetupState>(path.join(root, "setup.json"))).phase === "enabled", 120_000)
    await waitUntil(async () => !await leaseAlive(root))
    const next = path.join(root, "new")
    await fixtureRuntime(next, "1.0.1", controller)
    const state: UpdateState = { id: randomUUID(), phase: "queued", oldRuntime: runtime, newRuntime: next,
      targetTag: "v1.0.1", prepareOnly: false, updatedAt: new Date().toISOString() }
    await atomicJson(path.join(root, "state.json"), state)
    await wakeUpdateWorker(deployment, run)
    await waitUntil(() => exists(path.join(root, "update-ready.json")), 120_000)
    await atomicJson(path.join(root, "update-killed.json"), { killed: true })
    assertCommandSucceeded("Stop isolated update worker", await run("schtasks.exe", ["/End", "/TN", scope.updater]))
    await stopWorkerProcesses()
    await waitUntil(async () => (await json<UpdateRunnerStatus>(path.join(root, "runner.json"))).stopped && !await appStatus(deployment))
    console.log("Update worker terminated; application paused. Waiting for automatic data/runtime rollback...")
    await waitUntil(async () => (await json<UpdateState>(path.join(root, "state.json"))).phase === "rolled-back", 150_000)
    if (await Bun.file(path.join(deployment.dataRoot, "history.json")).text() !== "original") throw new Error("Original data was not restored")
    const quarantine = path.join(home, `.stillon-after-failed-${state.id}`, "history.json")
    if (await Bun.file(quarantine).text() !== "migrated") throw new Error("Failed-version data was not retained")
    const report = { result: "passed", ...updateTarget(), elapsedSeconds: (Date.now() - started) / 1000,
      firstSetupInterruption: "automatic original-service recovery", setupRetry: "enabled", updateInterruption: "automatic runtime/data rollback",
      loginAndReboot: "not exercised" }
    await atomicJson(path.join(root, "report.json"), report)
    console.log(JSON.stringify(report))
  } finally {
    for (const task of [scope.updater, scope.app]) {
      await run("schtasks.exe", ["/End", "/TN", task])
      const removal = await run("schtasks.exe", ["/Delete", "/TN", task, "/F"])
      if (removal.code !== 0) console.warn(`Inspect rehearsal task cleanup: ${task}`)
    }
    await stopWorkerProcesses()
    await stopWindowsServiceProcesses(deployment.launch)
    await stopWindowsServiceProcesses({ ...deployment.launch, args: [controller, "serve", root], workingDirectory: root, environmentFile: undefined })
    const runnerFile = path.join(root, "runner.json")
    if (await exists(runnerFile)) await stopOrphanedApp(deployment, await json<UpdateRunnerStatus>(runnerFile))
    if (await appStatus(deployment)) throw new Error("The rehearsal application is still listening; inspect the retained artifacts")
  }
}

if (import.meta.main) {
  const [mode, root] = process.argv.slice(2)
  if (mode === "worker") await runFixtureWorker(root)
  else if (mode === "serve" || mode === "app") await controllerMain()
  else if (!mode) await rehearse()
  else throw new Error("Unknown rehearsal mode")
}
