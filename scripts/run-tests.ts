import process from "node:process"

const terminalIntegrationTest = "src/server/terminal-manager.test.ts"

async function findTestFiles() {
  const files = new Set<string>()
  for (const pattern of ["src/**/*.test.ts", "src/**/*.test.tsx"]) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: process.cwd() })) {
      if (file !== terminalIntegrationTest) files.add(`./${file}`)
    }
  }
  return [...files].sort()
}

async function run(args: string[]) {
  // Tests may be launched from an installed StillOn process. Its updater and
  // Connect credentials/configuration must never control the test instances.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("STILLON_UPDATE_") && !key.startsWith("STILLON_CONNECT_") && key !== "STILLON_RUNTIME_PROFILE"))
  const child = Bun.spawn({
    cmd: [process.execPath, "test", ...args],
    cwd: process.cwd(),
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}

const testFiles = await findTestFiles()
await run(["--timeout", "20000", ...testFiles])
await run([`./${terminalIntegrationTest}`, "--timeout", "30000"])
