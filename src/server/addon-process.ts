import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"
import type { AgentProvider } from "../shared/types"

export interface AddonTurnArgs {
  cwd: string; content: string; model: string; effort?: string; sessionToken: string | null;
  permissionMode: string; onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
}
type Frame = { id?: number; result?: any; error?: string; event?: HarnessEvent; question?: HarnessToolRequest; questionId?: number; done?: boolean }

export function addonEnvironment(environment: NodeJS.ProcessEnv) {
  const result = { ...environment }
  for (const key of Object.keys(result)) {
    if (/^(STILLON_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_)/iu.test(key) || /^(NODE_OPTIONS|BUN_OPTIONS)$/iu.test(key)) delete result[key]
  }
  return result
}

export class AddonProcess {
  private child: ReturnType<typeof spawn>
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private serial = 0
  private exited = false
  private exitPromise: Promise<void>
  private closing?: Promise<void>
  private failure?: Error
  onFrame: (frame: Frame) => void = () => {}
  onFailure: (error: Error) => void = () => {}

  constructor(file: string, environment: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, ["--no-env-file", file], { env: addonEnvironment(environment),
      cwd: environment.USERPROFILE ?? environment.HOME, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] })
    this.exitPromise = new Promise(resolve => this.child.once("close", () => {
      this.exited = true
      this.fail(new Error("The provider add-on stopped unexpectedly."))
      resolve()
    }))
    this.child.once("error", () => this.fail(new Error("Unable to launch the provider add-on.")))
    this.child.stdin!.on("error", () => this.fail(new Error("The provider add-on input closed.")))
    this.child.stderr!.resume()
    this.child.stdout!.setEncoding("utf8")
    let buffer = ""
    this.child.stdout!.on("data", (chunk: string) => {
      buffer += chunk
      if (buffer.length > 16 * 1024 * 1024) { this.fail(new Error("Add-on message exceeded the size limit.")); return }
      let index: number
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        try {
          const frame = JSON.parse(line) as Frame
          if (!frame || typeof frame !== "object") throw new Error()
          if (frame.id !== undefined) {
            const request = this.pending.get(frame.id)
            if (!request) continue
            clearTimeout(request.timer); this.pending.delete(frame.id)
            if (frame.error) request.reject(new Error(frame.error)); else request.resolve(frame.result)
          } else this.onFrame(frame)
        } catch { this.fail(new Error("The provider add-on returned an invalid message.")) }
      }
    })
  }

  private fail(error: Error) {
    if (this.failure) return
    this.failure = error
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear(); this.onFailure(error)
  }

  call(method: string, params?: unknown, timeout = 30_000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Add-on ${method} timed out.`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin!.write(JSON.stringify({ id, method, params }) + "\n")
    })
  }

  close() { return this.closing ??= this.dispose().catch(error => { this.closing = undefined; throw error }) }
  private async dispose() {
    if (this.exited) return
    await this.call("shutdown", undefined, 10_000).catch(() => undefined)
    this.child.stdin!.end()
    const wait = async (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([this.exitPromise, new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })]); clearTimeout(timer)
    }
    await wait(1500)
    if (!this.exited && this.child.pid) {
      try {
        if (process.platform === "win32") await promisify(execFile)("taskkill.exe", ["/PID", String(this.child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 })
        else process.kill(-this.child.pid, "SIGKILL")
      } catch (error) { if (!this.exited) throw error }
      await wait(3000)
    }
    if (!this.exited) throw new Error("Add-on process exit was not confirmed. Retry Stop.")
  }
}

export function addonTurn(provider: AgentProvider, client: AddonProcess, args: AddonTurnArgs, release: () => void): HarnessTurn {
  const frames: Frame[] = []
  let wake: (() => void) | undefined, failure: Error | undefined, cancelled = false, closed = false
  client.onFrame = frame => {
    if (frame.question) {
      void args.onToolRequest(frame.question).then(answer => client.call("answer", { id: frame.questionId, answer }),
        () => client.call("answer", { id: frame.questionId, answer: { discarded: true } })).catch(error => { failure = error; wake?.() })
    } else { frames.push(frame); wake?.() }
  }
  client.onFailure = error => { failure = error; wake?.() }
  const close = async () => { if (closed) return; await client.close(); closed = true; release(); wake?.() }
  return { provider, close, interrupt: async () => { cancelled = true; await close() }, stream: {
    async *[Symbol.asyncIterator]() {
      try {
        const { onToolRequest: _, ...input } = args
        if (cancelled) return
        await client.call("start", input)
        while (!cancelled) {
          if (!frames.length) {
            if (failure) throw failure
            await new Promise<void>(resolve => { wake = resolve }); wake = undefined
            continue
          }
          const frame = frames.shift()!
          if (frame.event) yield frame.event
          if (frame.done) return
        }
      } finally { await close() }
    },
  } }
}
