import { assertAppearanceFixture, seedAppearanceFixture } from "./appearance-fixture"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { artifactName, bunRelativePath, unpackBundle, verifyBundle } from "../src/server/distribution/bundle"
import { localFetch } from "../src/server/updater/control"
import { probeRuntime } from "../src/server/updater/engine"
import { updateRoot, updateTarget, type UpdateDeployment } from "../src/server/updater/model"
import pkg from "../package.json"
import { rehearseNativeSourceMigration } from "./rehearse-native-source-migration"
import { rehearseDesktopUpdate } from "./rehearse-desktop-update"
import { desktopConnectConfig, parseConnectRuntimeConfig } from "../src/server/connect/config"

const target = updateTarget()
const expectedConnect = desktopConnectConfig(process.env)
const archive = path.resolve("dist/desktop/release", artifactName(pkg.version, target.platform, target.architecture))
const root = await mkdtemp(path.join(os.tmpdir(), "stillon-desktop-acceptance-"))
const runtime = path.join(root, "extracted", "runtime with spaces")
const profile = path.join(root, "profile")
const native = process.argv.includes("--native")
const report: Record<string, unknown> = { target, archive: path.basename(archive), checks: [] }
const checks = report.checks as string[]
const timings: Record<string, number> = {}
report.timingsMs = timings
let nativeStarted = false

async function run(command: string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(command, { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`${path.basename(command[0])} failed (${code}): ${stdout}\n${stderr}`)
  return stdout.trim()
}

const env: NodeJS.ProcessEnv = { ...process.env, HOME: profile, USERPROFILE: profile, LOCALAPPDATA: path.join(profile, "AppData", "Local") }
for (const key of Object.keys(env)) if (/^(OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_|STILLON_)/.test(key)) delete env[key]
// A clean PATH proves that the embedded Bun is used, not a developer install.
env.PATH = process.platform === "win32" ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0` : "/usr/bin:/bin:/usr/sbin:/sbin"

try {
  let started = performance.now()
  const bundle = await unpackBundle(await Bun.file(archive).bytes(), runtime, target)
  await verifyBundle(runtime, target)
  timings.unpackAndVerify = Math.round(performance.now() - started)
  checks.push("archive integrity; clean extraction outside repository; no source dependencies")
  const configFile = Bun.file(path.join(runtime, "runtime/connect.json"))
  const actualConnect = await configFile.exists() ? parseConnectRuntimeConfig(await configFile.json()) : null
  if (JSON.stringify(actualConnect) !== JSON.stringify(expectedConnect)) throw new Error("Packaged Connect configuration differs from the requested deployment")
  if (!await Bun.file(path.join(runtime, "runtime/frp", target.platform === "win32" ? "frpc.exe" : "frpc")).exists()) throw new Error("Packaged connector is missing")
  checks.push("sealed Connect default and approved migration list match build inputs; frpc present")
  const executable = path.join(runtime, bunRelativePath(target.platform))
  const actual = JSON.parse(await run([executable, "--no-env-file", "-e", "console.log(JSON.stringify({platform:process.platform,architecture:process.arch}))"], env))
  if (actual.platform !== target.platform || actual.architecture !== target.architecture) throw new Error("Bundled runtime architecture mismatch")
  if (await run([executable, "--no-env-file", path.join(runtime, "bin/stillon"), "--version"], env) !== bundle.version) throw new Error("Packaged CLI version mismatch")
  checks.push("bundled runtime executes at expected architecture; CLI works without Bun in PATH")
  const deployment: UpdateDeployment = { schema: 1, ...target, root: path.join(root, "managed"), controller: path.join(runtime, "runtime/controller.js"),
    dataRoot: path.join(profile, ".stillon"), port: 3210, launch: { executable, args: [path.join(runtime, "bin/stillon"), "--no-open", "--strict-port", "--port", "3210"],
      workingDirectory: runtime, homeDirectory: profile, localAppDataDirectory: env.LOCALAPPDATA, pathEnvironment: env.PATH } }
  await probeRuntime(deployment, runtime, path.join(root, "probe"))
  checks.push("packaged server isolated start, health/version/identity, HTML/assets, authenticated shutdown")
  started = performance.now()
  report.updateRehearsal = await rehearseDesktopUpdate(runtime, path.join(root, "update-rehearsal"), env)
  timings.failedUpdateRollbackAndRetry = Math.round(performance.now() - started)
  checks.push("real packaged update and rollback; prepared candidate reuse; personal skin preserved")
  if (native) {
    if (process.env.CI !== "true") throw new Error("Native acceptance is restricted to clean disposable CI runners")
    const custom = path.join(profile, ".stillon/customizations/skins/personal/custom.css")
    await mkdir(path.dirname(custom), { recursive: true }); await writeFile(custom, "/* personal skin: preserve */")
    await seedAppearanceFixture(path.join(profile, ".stillon"))
    nativeStarted = true
    started = performance.now()
    await run([executable, "--no-env-file", path.join(runtime, "bin/desktop"), "--no-open"], env)
    timings.firstNativeSetup = Math.round(performance.now() - started)
    const health = await (await localFetch("http://127.0.0.1:3210/health")).json() as { ok?: boolean; version?: string }
    if (!health.ok || health.version !== bundle.version) throw new Error("Native installed service is unhealthy")
    const connect = await (await localFetch("http://127.0.0.1:3210/api/connect-local/status")).json() as { configured?: boolean; origin?: string; state?: string }
    if (expectedConnect && (!connect.configured || connect.origin !== expectedConnect.origin || connect.state !== "unbound")) throw new Error("Fresh installed service cannot start managed email binding")
    if (!expectedConnect && connect.configured) throw new Error("Local-only package unexpectedly configured a managed service")
    checks.push(expectedConnect ? "fresh native user profile can start email binding with the packaged service default" : "explicit local-only package has no managed service default")
    checks.push("native per-user service and independent updater setup, no local build")
    // Launching again must open the existing deployment, preserving identity.
    started = performance.now()
    await run([executable, "--no-env-file", path.join(runtime, "bin/desktop"), "--no-open"], env)
    timings.repeatLaunch = Math.round(performance.now() - started)
    if (await readFile(custom, "utf8") !== "/* personal skin: preserve */") throw new Error("Personal skin changed during installation")
    await assertAppearanceFixture(path.join(profile, ".stillon"))
    started = performance.now()
    await run([executable, "--no-env-file", path.join(runtime, "bin/desktop"), "--uninstall"], env)
    timings.nativeUninstall = Math.round(performance.now() - started)
    nativeStarted = false
    if (await readFile(custom, "utf8") !== "/* personal skin: preserve */") throw new Error("Personal skin removed during uninstall")
    await assertAppearanceFixture(path.join(profile, ".stillon"))
    if (await Bun.file(path.join(updateRoot(target.platform, profile, env.LOCALAPPDATA), "deployment.json")).exists()) throw new Error("Uninstall left an active deployment")
    checks.push("repeat launch; native uninstall; user skin and appearance files retained")
    nativeStarted = true
    report.sourceMigration = await rehearseNativeSourceMigration(runtime, profile, env, run)
    checks.push("known managed source to package migration using the real native recovery task")
    await run([executable, "--no-env-file", path.join(runtime, "bin/desktop"), "--uninstall"], env)
    nativeStarted = false
    await assertAppearanceFixture(path.join(profile, ".stillon"))
  }
  report.status = "passed"
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.status = "failed"; report.error = error instanceof Error ? error.message : String(error)
  // Only disposable acceptance logs, never real user profiles or controller secrets.
  const diagnostics: Record<string, string> = {}
  for await (const name of new Bun.Glob("**/*.log").scan({ cwd: root, dot: true })) {
    diagnostics[name] = (await Bun.file(path.join(root, name)).text()).slice(-12_000)
  }
  if (process.platform === "win32" && nativeStarted) {
    for (const task of ["StillOn", "StillOn Updater"]) {
      try { diagnostics[`task ${task}`] = await run(["schtasks.exe", "/Query", "/TN", task, "/V", "/FO", "LIST"], process.env) } catch (error) { diagnostics[`task ${task}`] = String(error) }
    }
    try { diagnostics.processes = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('conhost.exe','powershell.exe','bun.exe') } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,KernelModeTime,UserModeTime | ConvertTo-Json -Depth 3"], process.env) } catch (error) { diagnostics.processes = String(error) }
    try { diagnostics.taskEvents = await run(["wevtutil.exe", "qe", "Microsoft-Windows-TaskScheduler/Operational", "/c:30", "/rd:true", "/f:text"], process.env) } catch (error) { diagnostics.taskEvents = String(error) }
  }
  report.diagnostics = diagnostics
  console.error(JSON.stringify(report, null, 2)); process.exitCode = 1
} finally {
  await mkdir("dist/desktop/reports", { recursive: true })
  await writeFile(`dist/desktop/reports/${target.platform}-${target.architecture}.json`, JSON.stringify(report, null, 2) + "\n")
  if (nativeStarted) {
    try { await run([path.join(runtime, bunRelativePath(target.platform)), "--no-env-file", path.join(runtime, "bin/desktop"), "--uninstall"], env); nativeStarted = false } catch { /* Preserve paths needed for recovery on the disposable runner. */ }
  }
  if (!nativeStarted) await rm(root, { recursive: true, force: true })
  else console.error(`Retained failed native acceptance for inspection: ${root}`)
}
