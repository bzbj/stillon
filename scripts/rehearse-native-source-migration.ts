import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { assertAppearanceFixture } from "./appearance-fixture"
import { bunRelativePath, copyBundle, verifyBundle } from "../src/server/distribution/bundle"
import { resolveServiceBackend, runServiceCommand } from "../src/server/service"
import { captureServiceRegistration } from "../src/server/updater/registration"
import { appStatus, waitUntil } from "../src/server/updater/control"
import { atomicJson, json } from "../src/server/updater/files"
import { installUpdateWorker } from "../src/server/updater/native"
import { updateRoot, type UpdateDeployment } from "../src/server/updater/model"
import type { DesktopTransition } from "../src/server/distribution/transition"

/** Disposable native CI only: simulate a managed source deployment, then migrate
 * through the exact bundled CLI/native helper. Never run against a user profile. */
export async function rehearseNativeSourceMigration(runtime: string, profile: string, env: NodeJS.ProcessEnv,
  run: (command: string[], env: NodeJS.ProcessEnv) => Promise<string>) {
  if (process.env.CI !== "true") throw new Error("Native source migration acceptance requires a disposable CI runner")
  const bundle = await verifyBundle(runtime)
  const root = updateRoot(bundle.platform, profile, env.LOCALAPPDATA)
  const source = path.join(path.dirname(profile), "legacy managed source")
  await copyBundle(runtime, source, bundle)
  await unlink(path.join(source, "stillon-bundle.json"))
  const environmentFile = path.join(profile, "private-service.env")
  await writeFile(environmentFile, "MIGRATION_NATIVE_FIXTURE=preserved\n")
  const deployment: UpdateDeployment = { schema: 1, platform: bundle.platform, architecture: bundle.architecture,
    root, port: 3210, controller: path.join(source, "runtime/controller.js"), dataRoot: path.join(profile, ".stillon"),
    launch: { executable: path.join(source, bunRelativePath(bundle.platform)), workingDirectory: source,
      homeDirectory: profile, localAppDataDirectory: env.LOCALAPPDATA, pathEnvironment: env.PATH ?? "", environmentFile,
      args: [path.join(source, "bin/stillon"), "--no-open", "--strict-port", "--host", "127.0.0.1", "--port", "3210"] } }
  const history = path.join(deployment.dataRoot, "migration-history-fixture.json")
  await mkdir(deployment.dataRoot, { recursive: true })
  await writeFile(history, "native source history retained")
  await atomicJson(path.join(root, "deployment.json"), deployment)
  await atomicJson(path.join(root, "control.json"), { runtime: source, paused: false })
  const launch = { ...deployment.launch, args: [deployment.controller, "serve", root], workingDirectory: root, environmentFile: undefined }
  await resolveServiceBackend(bundle.platform).install({ launch, run: runServiceCommand, log: console.log, warn: console.warn })
  const registration = await captureServiceRegistration(bundle.platform, launch)
  await atomicJson(path.join(root, "setup.json"), { phase: "enabled", registration, updatedAt: new Date().toISOString() })
  await installUpdateWorker(deployment)
  await waitUntil(async () => (await appStatus(deployment))?.version === bundle.version)
  await run([path.join(runtime, bunRelativePath(bundle.platform)), "--no-env-file", path.join(runtime, "bin/desktop"), "--no-open", "--migrate"], env)
  const result = await json<DesktopTransition>(path.join(root, "desktop-transition.json"))
  if (result.phase !== "succeeded") throw new Error("Native source migration did not succeed: " + result.error)
  if (await readFile(history, "utf8") !== "native source history retained") throw new Error("Native source history changed during migration")
  if (await readFile(environmentFile, "utf8") !== "MIGRATION_NATIVE_FIXTURE=preserved\n") throw new Error("Source service environment changed")
  const next = await json<UpdateDeployment>(path.join(root, "deployment.json"))
  if (next.launch.environmentFile !== environmentFile || next.port !== 3210 || next.launch.pathEnvironment !== deployment.launch.pathEnvironment) throw new Error("Source service configuration was not retained")
  await verifyBundle(result.newRuntime, bundle)
  await assertAppearanceFixture(deployment.dataRoot)
  await run([path.join(runtime, bunRelativePath(bundle.platform)), "--no-env-file", path.join(runtime, "bin/desktop"), "--no-open"], env)
  return { status: "passed", checks: ["real native source service and updater migrated", "dedicated native recovery helper", "controller handover with bundled Bun", "same-version channel migration without Git/install/build", "history, appearance and environment preserved", "repeat launch uses package deployment"] }
}
