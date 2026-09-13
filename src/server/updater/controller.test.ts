import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { appStatus, pauseManagedServer } from "./control"
import { atomicJson, exists, json } from "./files"
import { verifyRuntime } from "./engine"
import { updateTarget, type UpdateDeployment, type UpdateRunnerStatus, type UpdateState } from "./model"

const supported = process.platform === "win32" || process.platform === "darwin"
const entry = path.join(import.meta.dir, "entry.ts")

async function waitFor(test: () => Promise<boolean>, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await test()) return; await Bun.sleep(100) }
  throw new Error("Fixture timed out")
}

async function writeRuntime(directory: string, version: string) {
  await mkdir(path.join(directory, "bin"), { recursive: true })
  await mkdir(path.join(directory, "dist/client/assets"), { recursive: true })
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module", version }))
  await writeFile(path.join(directory, "dist/client/index.html"), '<html><script src="/assets/app.js"></script></html>')
  await writeFile(path.join(directory, "dist/client/assets/app.js"), `console.log(${JSON.stringify(version)})`)
  const appControl = pathToFileURL(path.join(import.meta.dir, "app-control.ts")).href
  await writeFile(path.join(directory, "bin/stillon"), `
import path from 'node:path';
import {createManagedAppControl} from ${JSON.stringify(appControl)};
const root=path.resolve(import.meta.dir,'..');
const data=path.join(process.env.HOME,'.stillon');
const version=${JSON.stringify(version)};
await Bun.write(path.join(data,'history.json'),version==='1.0.0' ? 'original' : 'migrated');
if(version!=='1.0.0') await Bun.write(path.join(data,'new-schema.json'),'new');
const control=createManagedAppControl({instance:process.env.STILLON_UPDATE_INSTANCE,secret:process.env.STILLON_UPDATE_SECRET,verifying:process.env.STILLON_UPDATE_VERIFYING==='1',busy:()=>false,shutdown:async()=>{await server.stop(true);process.emit('SIGTERM')}});
const server=Bun.serve({hostname:'127.0.0.1',port:Number(process.argv[process.argv.indexOf('--port')+1]),fetch(req){
const result=control.handle(req,'127.0.0.1');if(result)return result;
const route=new URL(req.url).pathname;
if(route==='/health')return Response.json({ok:true,port:server.port,version,updateInstance:control.instance,updateProtocol:1});
return new Response(Bun.file(path.join(root,'dist/client',route==='/'?'index.html':route.slice(1))));
}});
await new Promise(resolve=>process.once('SIGTERM',resolve));
await server.stop(true);
`)
}

test.skipIf(!supported)("independent controller survives a killed updater and a fresh worker restores the old data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-controller-"))
  let controller: ReturnType<typeof Bun.spawn> | undefined
  let firstWorker: ReturnType<typeof Bun.spawn> | undefined
  let recovery: ReturnType<typeof Bun.spawn> | undefined
  let deployment: UpdateDeployment | undefined
  try {
    const old = path.join(root, "old")
    const next = path.join(root, "new")
    await writeRuntime(old, "1.0.0")
    await writeRuntime(next, "1.0.1")
    const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
    const port = reserve.port!
    await reserve.stop(true)
    const home = path.join(root, "home")
    await mkdir(path.join(home, ".stillon"), { recursive: true })
    deployment = { schema: 1, ...updateTarget(), root, controller: entry, dataRoot: path.join(home, ".stillon"), port,
      launch: { executable: process.execPath, workingDirectory: old, homeDirectory: home, pathEnvironment: process.env.PATH ?? "",
        args: [path.join(old, "bin", "stillon"), "--port", String(port), "--no-open", "--strict-port"] } }
    await atomicJson(path.join(root, "deployment.json"), deployment)
    await atomicJson(path.join(root, "control.json"), { runtime: old, paused: false })
    controller = Bun.spawn([process.execPath, entry, "serve", root], { stdin: "ignore", stdout: Bun.file(path.join(root, "controller.log")), stderr: Bun.file(path.join(root, "controller-errors.log")) })
    await verifyRuntime(deployment, old)
    const state: UpdateState = { id: randomUUID(), phase: "queued", targetTag: "v1.0.1", prepareOnly: false,
      oldRuntime: old, newRuntime: next, updatedAt: new Date().toISOString() }
    await atomicJson(path.join(root, "state.json"), state)
    const workerScript = path.join(root, "crash-worker.ts")
    await writeFile(workerScript, `
import {UpdateEngine,realUpdateEffects} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "engine.ts")).href)};
import {atomicJson,json} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "files.ts")).href)};
const root=${JSON.stringify(root)};
const d=await json(root+'/deployment.json');
const token='fixture-only-lease';
const lease=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>r.headers.get('authorization')==='Bearer '+token?new Response(token):new Response(null,{status:403})});
await atomicJson(root+'/lease.json',{port:lease.port,token});
const effects=realUpdateEffects(d);effects.prepare=async()=>{};
const verify=effects.verify;effects.verify=async runtime=>{await verify(runtime);await Bun.write(root+'/kill-now','ready');await new Promise(()=>{})};
await new UpdateEngine(d,effects).execute();
`)
    firstWorker = Bun.spawn([process.execPath, workerScript], { stdin: "ignore", stdout: "ignore", stderr: Bun.file(path.join(root, "first-worker-errors.log")) })
    await waitFor(() => exists(path.join(root, "kill-now")), 30_000)
    expect(controller.exitCode).toBeNull()
    expect((await json<UpdateState>(path.join(root, "state.json"))).phase).toBe("verifying")
    expect(await Bun.file(path.join(home, ".stillon/history.json")).text()).toBe("migrated")
    firstWorker.kill()
    await firstWorker.exited
    await waitFor(async () => {
      const status = await json<UpdateRunnerStatus>(path.join(root, "runner.json"))
      return status.stopped && !await appStatus(deployment!)
    })
    expect(controller.exitCode).toBeNull()
    recovery = Bun.spawn([process.execPath, entry, "worker", root], { stdin: "ignore", stdout: "ignore", stderr: Bun.file(path.join(root, "recovery-errors.log")) })
    expect(await recovery.exited).toBe(0)
    expect((await json<UpdateState>(path.join(root, "state.json"))).phase).toBe("rolled-back")
    expect(await Bun.file(path.join(home, ".stillon/history.json")).text()).toBe("original")
    expect(await Bun.file(path.join(home, ".stillon/new-schema.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(home, `.stillon-after-failed-${state.id}/history.json`)).text()).toBe("migrated")
    await verifyRuntime(deployment, old)
  } catch (error) {
    for (const file of ["controller-errors.log", "first-worker-errors.log", "recovery-errors.log"]) {
      if (await exists(path.join(root, file))) console.error(await Bun.file(path.join(root, file)).text())
    }
    throw error
  } finally {
    firstWorker?.kill()
    recovery?.kill()
    if (deployment && controller?.exitCode === null) {
      await pauseManagedServer(deployment).catch(() => {})
    }
    controller?.kill()
    await Promise.all([controller?.exited, firstWorker?.exited, recovery?.exited])
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
