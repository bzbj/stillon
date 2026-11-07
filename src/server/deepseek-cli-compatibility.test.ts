import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildDeepSeekAddon } from "../../scripts/build-provider-addon"
import { ProviderAddons } from "./provider-addons"
import type { HarnessEvent } from "./harness-types"

test.skipIf(!["darwin", "win32"].includes(process.platform))("bundled adapter uses discovered older, newer and prerelease CLIs; actual protocol failures remain errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-cli-versions-"))
  try {
    const script = path.join(root, "cli.cjs")
    await writeFile(script, `
if (process.argv.includes('--version')) { console.log(process.env.FIXTURE_VERSION); process.exit(0); }
const send = value => console.log(JSON.stringify({ jsonrpc: '2.0', ...value }));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const f = JSON.parse(line), sessionId = f.params?.sessionId;
  if (f.method === 'initialize') send({ id: f.id, result: { serverInfo: { name: process.env.FIXTURE_RUNTIME } } });
  if (f.method === 'session/resume') send({ id: f.id, result: {} });
  if (f.method === 'session/prompt') {
    send({ id: f.id, result: { messageId: 'message-1' } });
    send({ method: 'session.event', params: { sessionId, event: { type: 'agent/inbox/spliced', data: { inserted: [{ id: 'message-1' }] } } } });
    send({ method: 'session.event', params: { sessionId, event: { type: 'assistant/message', data: { message: { content: 'local CLI ' + process.env.FIXTURE_VERSION } } } } });
    send({ method: 'session.event', params: { sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } });
    send({ method: 'session.status', params: { sessionId, status: 'idle' } });
  }
  if (f.method === 'shutdown') { send({ id: f.id, result: {} }); process.exit(0); }
});
`)
    const executable = path.join(root, process.platform === "win32" ? "dsh.cmd" : "dsh")
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    await writeFile(executable, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0cli.cjs" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 })
    const environment = { ...process.env, DSH_EXECUTABLE: executable, FIXTURE_VERSION: "", FIXTURE_RUNTIME: "deepseek-harness-sdk-runtime" }
    const directory = path.join(root, "bundled")
    await mkdir(directory)
    await writeFile(path.join(directory, "deepseek.stillon-addon"), JSON.stringify(await buildDeepSeekAddon()))
    const manager = new ProviderAddons(root, () => environment)
    await manager.initialize(directory); await manager.change("deepseek", "enable")
    const run = async () => {
      const turn = await manager.startTurn("deepseek", { cwd: root, content: "hello", model: "deepseek-flash",
        permissionMode: "request", sessionToken: "existing-session", onToolRequest: async () => ({ discarded: true }) })
      const events: HarnessEvent[] = []
      for await (const event of turn.stream) events.push(event)
      return events.at(-1)?.entry
    }
    for (const version of ["0.1.0", "0.2.1-rc.5", "1.0.0", "9.0.0-preview.1"]) {
      environment.FIXTURE_VERSION = version
      expect(await manager.status("deepseek", true)).toMatchObject({ state: "ready", installed: true, version, executable })
      expect(await run()).toMatchObject({ kind: "result", isError: false, result: `local CLI ${version}` })
    }
    environment.FIXTURE_RUNTIME = "unrelated-runtime"
    expect(await run()).toMatchObject({ kind: "result", isError: true, result: "Unsupported DeepSeek SDK runtime (9.0.0-preview.1)." })
    environment.DSH_EXECUTABLE = path.join(root, "missing-dsh")
    expect(await manager.status("deepseek", true)).toMatchObject({ state: "error", installed: false })
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)
