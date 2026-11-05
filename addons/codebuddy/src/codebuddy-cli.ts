import { execFile, spawn } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { findCliExecutable } from "../../../src/server/cli-environment"

const exec = promisify(execFile)
export const CODEBUDDY_CLI_VERSION = "2.180.0"

export function codeBuddyCommand(executable: string, args: string[], env: NodeJS.ProcessEnv, platform = process.platform) {
  if (platform === "win32" && /\.(cmd|bat|ps1)$/iu.test(executable)) {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
    const script = `& ${[executable, ...args].map(quote).join(" ")}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`
    return { command: path.win32.join(env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] }
  }
  return { command: executable, args }
}

export function codeBuddyCandidates(env: NodeJS.ProcessEnv, platform = process.platform) {
  const explicit = env.CODEBUDDY_EXECUTABLE
  if (explicit) return [explicit]
  const p = platform === "win32" ? path.win32 : path.posix
  const home = env.USERPROFILE ?? env.HOME ?? homedir()
  const names = platform === "win32" ? ["codebuddy.exe", "codebuddy.cmd", "codebuddy.ps1", "cbc.cmd"] : ["codebuddy", "cbc"]
  const roots = [p.join(home, ".local/bin"), p.join(home, ".codebuddy/bin"), p.join(home, ".bun/bin")]
  if (platform === "win32") roots.push(p.join(env.APPDATA ?? p.join(home, "AppData/Roaming"), "npm"))
  else roots.push("/usr/local/bin", "/opt/homebrew/bin")
  // Only public user launchers. WorkBuddy's private desktop runtime is unrelated.
  return [...["codebuddy", "cbc", "codebuddy-code"].map(name => findCliExecutable(name, env, platform)).filter((v): v is string => Boolean(v)),
    ...roots.flatMap(root => names.map(name => p.join(root, name)))]
}

export async function discoverCodeBuddy(env: NodeJS.ProcessEnv = process.env) {
  for (const candidate of codeBuddyCandidates(env)) if (findCliExecutable(candidate, env)) return candidate
  throw new Error(env.CODEBUDDY_EXECUTABLE
    ? "The selected CodeBuddy CLI is missing. Choose its public codebuddy launcher in Agent setup."
    : "CodeBuddy CLI was not found. Install the official CodeBuddy CLI, sign in there, then recheck or choose its launcher. WorkBuddy Desktop is a separate application.")
}

export function codeBuddyEnvironment(env: NodeJS.ProcessEnv) {
  return { ...env, CODEBUDDY_CODE_ENTRYPOINT: "sdk-ts", CODEBUDDY_CREDENTIALS_IN_MEMORY: "0", DISABLE_AUTOUPDATER: "1" }
}

export async function codeBuddyVersion(executable: string, env: NodeJS.ProcessEnv) {
  const launch = codeBuddyCommand(executable, ["--version"], env)
  const pending = exec(launch.command, launch.args, { env: codeBuddyEnvironment(env), windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024 })
  const output = await pending.catch(async error => {
    if (error.killed && pending.child.pid) await killCodeBuddyTree(pending.child.pid, false).catch(() => undefined)
    throw new Error("CodeBuddy CLI could not report its version. Check the selected public launcher and its runtime.")
  })
  const match = output.stdout.trim().match(/^(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\s+\(CodeBuddy(?: Code)?\))?$/iu)
  if (!match) throw new Error("The selected launcher did not identify a supported CodeBuddy CLI version.")
  return match[1]!
}

export async function checkCodeBuddy(env: NodeJS.ProcessEnv = process.env) {
  const executable = await discoverCodeBuddy(env), version = await codeBuddyVersion(executable, env)
  if (version !== CODEBUDDY_CLI_VERSION) throw new Error(`CodeBuddy CLI ${version} is not supported by this add-on. This preview targets ${CODEBUDDY_CLI_VERSION}; install a compatible add-on after updating your CLI.`)
  return { executable, version }
}

export function spawnCodeBuddy(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const launch = codeBuddyCommand(executable, args, env)
  return spawn(launch.command, launch.args, { cwd, env: codeBuddyEnvironment(env), windowsHide: true,
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] })
}

export async function killCodeBuddyTree(pid: number, processGroup = true) {
  if (process.platform === "win32") await exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 })
  else process.kill(processGroup ? -pid : pid, "SIGKILL")
}
