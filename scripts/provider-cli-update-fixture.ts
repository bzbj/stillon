import { chmod, copyFile, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { AgentProvider } from "../src/shared/types"
import { cliPackages, inspectCliInstallation, npmUpdateCommand } from "../src/server/provider-cli-installation"
import { installCli, verifyCli, type ProviderCliUpdatesOptions } from "../src/server/provider-cli-updates"

/** Synthetic npm prefix. Its installer only edits files under the fixture root. */
export async function createCliUpdateFixture(root: string, provider: AgentProvider = "codex") {
  const windows = process.platform === "win32", bin = windows ? root : path.join(root, "bin")
  const modules = path.join(root, windows ? "node_modules" : "lib/node_modules")
  const version = path.join(root, "version.txt"), failure = path.join(root, "fail.txt"), calls = path.join(root, "calls.txt")
  const serverVersion = path.join(root, "server-version.txt"), packageName = cliPackages[provider]
  const pkg = path.join(modules, packageName)
  const executable = path.join(bin, `${provider}${windows ? ".cmd" : ""}`)
  const interrupted = path.join(root, "interrupt-next-install"), retired = path.join(root, "retired")
  const launcherBackup = path.join(root, "launcher-backup.cmd")
  const fixtureDirectory = path.join(import.meta.dir, "test-fixtures/provider-cli")
  const configuration = JSON.stringify({ root, provider, packageName, executable, version, serverVersion, failure, calls,
    interrupted, retired, launcherBackup, cli: path.join(pkg, "cli.js"), manifest: path.join(pkg, "package.json") })
  await mkdir(pkg, { recursive: true }); await mkdir(bin, { recursive: true })
  await writeFile(version, "1.2.3")
  await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: packageName, bin: { [provider]: "cli.js" } }))
  // Only the trusted runtime shebang varies. Paths and other fixture values are
  // JSON data consumed by fixed scripts, never interpolated into JavaScript.
  const script = `#!${process.execPath.replaceAll("\\", "/")}\n` + await readFile(path.join(fixtureDirectory, "cli.cjs"), "utf8")
  await writeFile(path.join(pkg, "cli.js"), script, { mode: 0o700 }); await chmod(path.join(pkg, "cli.js"), 0o700)
  await writeFile(path.join(pkg, "fixture.json"), configuration)
  // npm's script is deliberately fake; no npm install or network package
  // request can escape this isolated prefix.
  const npmDirectory = path.join(windows ? bin : modules, windows ? "node_modules/npm/bin" : "npm/bin")
  await mkdir(npmDirectory, { recursive: true })
  await writeFile(path.join(npmDirectory, "../package.json"), JSON.stringify({ name: "npm", type: "commonjs" }))
  const npmScript = path.join(npmDirectory, "npm-cli.js")
  await copyFile(path.join(fixtureDirectory, "npm.cjs"), npmScript)
  await writeFile(path.join(npmDirectory, "fixture.json"), configuration)
  await chmod(npmScript, 0o700)
  if (windows) {
    await writeFile(executable, `@echo off\r\n"${process.execPath}" "%~dp0node_modules/${packageName}/cli.js" %*\r\n`)
    await copyFile(executable, launcherBackup)
    await writeFile(path.join(bin, "npm.cmd"), "@echo off\r\nexit /b 99\r\n")
  } else {
    await symlink(path.join(pkg, "cli.js"), executable)
    await symlink(npmScript, path.join(bin, "npm"))
  }
  const environment = { ...process.env, HOME: root, USERPROFILE: root, NPM_CONFIG_PREFIX: root, npm_config_prefix: root, CODEX_HOME: path.join(root, ".codex"), CODEX_EXECUTABLE: executable,
    CLAUDE_EXECUTABLE: executable,
    PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter) }
  const options: Pick<ProviderCliUpdatesOptions, "inspect" | "release" | "install" | "verify"> = {
    inspect: requested => requested === provider ? inspectCliInstallation(provider, environment) : Promise.resolve({ identity: "missing", label: "Not installed", automaticUpdates: "Managed outside StillOn.", reason: "Synthetic fixture has no installation for this provider." }),
    release: async provider => ({ version: "1.2.4", publishedAt: "2026-01-01T00:00:00.000Z", url: provider === "codex" ? "https://github.com/openai/codex/releases/tag/rust-v1.2.4" : "https://github.com/anthropics/claude-code/releases/tag/v1.2.4" }),
    install: async (provider, installation, target, _environment, lifecycle) => {
      if (installation.method?.kind !== "npm") throw new Error("The fixture only permits its synthetic npm installer.")
      const plan = await npmUpdateCommand(environment, installation.method.prefix, provider, target)
      if (await realpath(plan.args[0]!) !== await realpath(npmScript) || await realpath(installation.method.prefix) !== await realpath(root)) {
        throw new Error("Refusing to run an installer outside the synthetic prefix.")
      }
      await installCli(provider, installation, target, environment, lifecycle)
    },
    verify: (provider, installation) => verifyCli(provider, installation, environment),
  }
  return { options, environment, executable, version, serverVersion, failure, calls, npmScript, interrupted, retired, installed: () => readFile(version, "utf8") }
}
