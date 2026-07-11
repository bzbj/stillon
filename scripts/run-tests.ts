import process from "node:process"

const terminalIntegrationTest = "src/server/terminal-manager.test.ts"

async function findTestFiles() {
  const files = new Set<string>()
  for (const pattern of ["src/**/*.test.ts", "src/**/*.test.tsx"]) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: process.cwd() })) {
      if (file !== terminalIntegrationTest) files.add(file)
    }
  }
  return [...files].sort()
}

async function run(args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", ...args],
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}

const testFiles = await findTestFiles()
await run(["--timeout", "20000", ...testFiles])
await run([terminalIntegrationTest, "--timeout", "30000"])
