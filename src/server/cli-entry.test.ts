import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { APP_VERSION } from "../shared/branding"

const repositoryRoot = path.resolve(import.meta.dir, "../..")
const cliPath = path.join(repositoryRoot, "bin", "stillon")
const heavyImportBlockerPath = path.join(
  repositoryRoot,
  "scripts",
  "test-fixtures",
  "cli-heavy-import-blocker.preload.ts",
)
let temporaryHome = ""
let occupiedPortServer: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  temporaryHome = await mkdtemp(path.join(tmpdir(), "stillon-cli-entry-"))
  occupiedPortServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("port guard"),
  })
})

afterAll(async () => {
  await occupiedPortServer.stop(true)
  await rm(temporaryHome, { recursive: true, force: true })
})

async function runBun(
  args: string[],
  environment: Record<string, string | undefined> = {},
) {
  const child = Bun.spawn({
    cmd: [process.execPath, ...args],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NO_COLOR: "1",
      HOME: temporaryHome,
      USERPROFILE: temporaryHome,
      ...environment,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  let forceKillTimeout: ReturnType<typeof setTimeout> | null = null
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
    forceKillTimeout = setTimeout(() => {
      child.kill(9)
    }, 250)
  }, 4_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timeout)
  if (forceKillTimeout) clearTimeout(forceKillTimeout)
  if (timedOut) {
    throw new Error("CLI subprocess did not exit within 4000ms")
  }
  return { exitCode, stdout, stderr }
}

function withHeavyImportBlocker(
  args: string[],
  environment: Record<string, string | undefined> = {},
) {
  return runBun([
    "--preload",
    heavyImportBlockerPath,
    ...args,
  ], environment)
}

describe("CLI entrypoint import boundaries", () => {
  test.each([
    {
      label: "help",
      args: [
        "--port",
        () => String(occupiedPortServer.port),
        "--strict-port",
        "--help",
      ],
      expectedOutput: "Usage:",
    },
    {
      label: "version",
      args: [
        "--port",
        () => String(occupiedPortServer.port),
        "--strict-port",
        "--version",
      ],
      expectedOutput: APP_VERSION,
    },
    {
      label: "service help",
      args: ["service", "--help"],
      expectedOutput: "Background service:",
    },
  ])("$label exits without importing server or service backends", async ({
    args,
    expectedOutput,
  }) => {
    const resolvedArgs = args.map((arg) => typeof arg === "function" ? arg() : arg)
    const result = await withHeavyImportBlocker([cliPath, ...resolvedArgs])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(expectedOutput)
    expect(result.stderr).toBe("")
    expect(await readdir(temporaryHome)).toEqual([])
  })

  test.each([
    {
      label: "server entry",
      moduleSpecifier: pathToFileURL(path.join(import.meta.dir, "server.ts")).href,
    },
    {
      label: "agent coordinator",
      moduleSpecifier: pathToFileURL(path.join(import.meta.dir, "agent.ts")).href,
    },
    {
      label: "provider discovery",
      moduleSpecifier: pathToFileURL(path.join(import.meta.dir, "discovery.ts")).href,
    },
    {
      label: "service entry",
      moduleSpecifier: pathToFileURL(path.join(import.meta.dir, "service", "index.ts")).href,
    },
    {
      label: "native service backend",
      moduleSpecifier: pathToFileURL(path.join(import.meta.dir, "service", "macos.ts")).href,
    },
    {
      label: "Claude Agent SDK",
      moduleSpecifier: "@anthropic-ai/claude-agent-sdk",
    },
    {
      label: "Anthropic SDK",
      moduleSpecifier: "@anthropic-ai/sdk",
    },
    {
      label: "OpenAI SDK",
      moduleSpecifier: "openai",
    },
  ])("the test blocker rejects a direct $label import", async ({ moduleSpecifier }) => {
    const result = await withHeavyImportBlocker([
      "--eval",
      `await import(${JSON.stringify(moduleSpecifier)})`,
    ])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("STILLON_TEST_BLOCKED_HEAVY_CLI_IMPORT")
  })

  test("a service command loads the service branch without loading the server", async () => {
    const result = await withHeavyImportBlocker(
      [cliPath, "service", "status"],
      { STILLON_TEST_CLI_SERVICE_STUB: "success" },
    )

    expect(result).toEqual({
      exitCode: 0,
      stdout: "STILLON_TEST_SERVICE_CALLED\n",
      stderr: "",
    })
  })

  test("a service command failure preserves the existing exit code", async () => {
    const result = await withHeavyImportBlocker(
      [cliPath, "service", "status"],
      { STILLON_TEST_CLI_SERVICE_STUB: "failure" },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("[stillon] STILLON_TEST_SERVICE_FAILURE")
    expect(result.stderr).not.toContain("STILLON_TEST_BLOCKED_HEAVY_CLI_IMPORT")
  })
})
