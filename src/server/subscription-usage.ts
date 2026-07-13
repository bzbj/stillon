import { query } from "@anthropic-ai/claude-agent-sdk"
import { spawn } from "node:child_process"
import os, { homedir } from "node:os"
import { createInterface } from "node:readline"
import type {
  SubscriptionUsageProviderSnapshot,
  SubscriptionUsageSnapshot,
  SubscriptionUsageWindow,
} from "../shared/types"
import { APP_NAME, APP_VERSION } from "../shared/branding"
import { inheritAgentEnvironment, inheritClaudeAgentEnvironment } from "./agent-environment"
import { getCodexCliCommand } from "./codex-cli-command"

const CODEX_APP_SERVER_TIMEOUT_MS = 20_000
const COMMAND_TIMEOUT_MS = 10_000
const FIVE_HOUR_MINUTES = 300
const WEEKLY_MINUTES = 10_080
const CODEX_APP_SERVER_SOURCE = "codex app-server account/rateLimits/read"
const CLAUDE_SDK_USAGE_SOURCE = "Claude Agent SDK /usage"

type CommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number }
) => Promise<{ stdout: string; stderr: string }>

type CodexAppServerReader = (
  options: { timeoutMs: number }
) => Promise<CodexAppServerSnapshot>

type ClaudeSdkUsageReader = (
  options: { timeoutMs: number }
) => Promise<ClaudeSdkUsageSnapshot>

export interface ReadSubscriptionUsageOptions {
  now?: number
  runCommand?: CommandRunner
  readCodexAppServer?: CodexAppServerReader
  readClaudeSdkUsage?: ClaudeSdkUsageReader
  codexAppServerTimeoutMs?: number
}

export function getClaudeCliCommand(platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? "claude.cmd" : "claude"
}

interface CodexAppServerSnapshot {
  account: unknown
  rateLimits: unknown
}

interface ClaudeSdkUsageLimit {
  utilization: number | null
  resetsAt: string | null
}

interface ClaudeSdkUsageSnapshot {
  subscriptionType: string | null
  accountEmail: string | null
  rateLimitsAvailable: boolean
  fiveHour: ClaudeSdkUsageLimit | null
  weekly: ClaudeSdkUsageLimit | null
  modelScoped: Array<{
    displayName: string
    utilization: number | null
    resetsAt: string | null
  }>
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
}

export async function readSubscriptionUsageSnapshot(
  options: ReadSubscriptionUsageOptions = {}
): Promise<SubscriptionUsageSnapshot> {
  const now = options.now ?? Date.now()
  const [codex, claude] = await Promise.all([
    readCodexUsageProvider(options, now),
    readClaudeUsageProvider(options, now),
  ])

  return {
    generatedAt: now,
    providers: [codex, claude],
  }
}

async function readCodexUsageProvider(
  options: ReadSubscriptionUsageOptions,
  now: number
): Promise<SubscriptionUsageProviderSnapshot> {
  const readCodexAppServer = options.readCodexAppServer ?? readCodexAppServerSnapshot

  try {
    const snapshot = await readCodexAppServer({
      timeoutMs: options.codexAppServerTimeoutMs ?? CODEX_APP_SERVER_TIMEOUT_MS,
    })
    return parseCodexAppServerSnapshot(snapshot.account, snapshot.rateLimits, now)
  } catch (error) {
    return buildProviderSnapshot({
      provider: "codex",
      label: "Codex",
      status: isCommandUnavailable(error) ? "unavailable" : "error",
      source: CODEX_APP_SERVER_SOURCE,
      updatedAt: null,
      error: errorToMessage(error, "Unable to read Codex app-server usage."),
      windows: defaultUsageWindows(),
    })
  }
}

async function readClaudeUsageProvider(
  options: ReadSubscriptionUsageOptions,
  now: number
): Promise<SubscriptionUsageProviderSnapshot> {
  const readClaudeSdkUsage = options.readClaudeSdkUsage ?? readClaudeSdkUsageSnapshot

  try {
    return parseClaudeSdkUsageSnapshot(await readClaudeSdkUsage({ timeoutMs: COMMAND_TIMEOUT_MS }), now)
  } catch {
    return readClaudeUsageProviderFromCli(options, now)
  }
}

async function readClaudeUsageProviderFromCli(
  options: ReadSubscriptionUsageOptions,
  now: number
): Promise<SubscriptionUsageProviderSnapshot> {
  const runCommand = options.runCommand ?? runCliCommand
  const claudeCommand = getClaudeCliCommand()
  let planType: string | null = null
  let accountEmail: string | null = null

  try {
    const auth = await runCommand(claudeCommand, ["auth", "status"], { timeoutMs: COMMAND_TIMEOUT_MS })
    const authSnapshot = parseClaudeAuthStatus(auth.stdout)
    planType = authSnapshot.planType
    accountEmail = authSnapshot.accountEmail
  } catch {
    planType = null
    accountEmail = null
  }

  try {
    const usage = await runCommand(claudeCommand, ["-p", "/usage", "--output-format", "json", "--model", "sonnet"], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    })
    const resultText = parseClaudeUsageCommandResult(usage.stdout)
    const windows = parseClaudeUsageResult(resultText, now)
    const hasUsage = windows.some((window) => window.usedPercent !== null)

    return buildProviderSnapshot({
      provider: "claude",
      label: "Claude Code",
      status: hasUsage ? "available" : "unavailable",
      source: "claude /usage",
      updatedAt: now,
      error: hasUsage ? null : "Claude Code did not return subscription usage details.",
      planType,
      accountEmail,
      windows,
    })
  } catch (error) {
    return buildProviderSnapshot({
      provider: "claude",
      label: "Claude Code",
      status: isCommandUnavailable(error) ? "unavailable" : "error",
      source: "claude /usage",
      updatedAt: null,
      error: errorToMessage(error, "Unable to read Claude Code usage."),
      planType,
      accountEmail,
      windows: defaultUsageWindows(),
    })
  }
}

async function readClaudeSdkUsageSnapshot(
  options: { timeoutMs: number }
): Promise<ClaudeSdkUsageSnapshot> {
  const prompt = createIdleClaudePromptStream()
  const q = query({
    prompt,
    options: {
      cwd: homedir(),
      tools: [],
      systemPrompt: "",
      persistSession: false,
      settingSources: ["user"],
      pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE?.replace(/^~(?=\/|$)/, homedir()) || undefined,
      env: inheritClaudeAgentEnvironment(),
    },
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    prompt.close()
    q.close()
  }, options.timeoutMs)

  try {
    const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
    const account = await q.accountInfo().catch(() => null)
    const limits = usage.rate_limits

    return {
      subscriptionType: usage.subscription_type ?? accountSubscriptionType(account),
      accountEmail: findEmailValue(account),
      rateLimitsAvailable: usage.rate_limits_available,
      fiveHour: toClaudeSdkUsageLimit(limits?.five_hour),
      weekly: toClaudeSdkUsageLimit(limits?.seven_day),
      modelScoped: (limits?.model_scoped ?? []).map((limit) => ({
        displayName: limit.display_name,
        utilization: limit.utilization,
        resetsAt: limit.resets_at,
      })),
    }
  } catch (error) {
    if (timedOut) {
      throw new Error(`Claude Agent SDK usage request timed out after ${options.timeoutMs}ms.`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    prompt.close()
    q.close()
  }
}

function createIdleClaudePromptStream() {
  let resolve: (() => void) | null = null
  let closed = false

  return {
    close() {
      closed = true
      resolve?.()
      resolve = null
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<never> {
      if (closed) return
      await new Promise<void>((nextResolve) => {
        resolve = nextResolve
        if (closed) nextResolve()
      })
    },
  }
}

function toClaudeSdkUsageLimit(limit: {
  utilization: number | null
  resets_at: string | null
} | null | undefined): ClaudeSdkUsageLimit | null {
  if (!limit) return null
  return {
    utilization: limit.utilization,
    resetsAt: limit.resets_at,
  }
}

function accountSubscriptionType(account: unknown): string | null {
  return isRecord(account)
    ? asOptionalString(firstDefined(account, ["subscriptionType", "subscription_type", "planType", "plan_type"]))
    : null
}

function parseClaudeSdkUsageSnapshot(
  snapshot: ClaudeSdkUsageSnapshot,
  now = Date.now()
): SubscriptionUsageProviderSnapshot {
  const windows = claudeWindowsFromSdkSnapshot(snapshot)
  const hasUsage = windows.some((window) => window.usedPercent !== null)

  return buildProviderSnapshot({
    provider: "claude",
    label: "Claude Code",
    status: hasUsage ? "available" : "unavailable",
    source: CLAUDE_SDK_USAGE_SOURCE,
    updatedAt: now,
    error: hasUsage
      ? null
      : snapshot.rateLimitsAvailable
        ? "Claude Code did not return subscription usage details."
        : "Claude Code plan rate limits are unavailable for the current authentication method.",
    planType: snapshot.subscriptionType,
    accountEmail: snapshot.accountEmail,
    windows,
  })
}

function claudeWindowsFromSdkSnapshot(snapshot: ClaudeSdkUsageSnapshot): SubscriptionUsageWindow[] {
  const windows = [
    claudeSdkWindow("five_hour", "5-hour window", FIVE_HOUR_MINUTES, snapshot.fiveHour),
    claudeSdkWindow("weekly", "Weekly window", WEEKLY_MINUTES, snapshot.weekly),
  ]
  const fableLimit = snapshot.modelScoped.find((limit) => /\bfable\b/i.test(limit.displayName))

  if (fableLimit) {
    windows.push(claudeSdkWindow("fable_weekly", "Fable 5 limit", WEEKLY_MINUTES, fableLimit))
  }

  return windows
}

function claudeSdkWindow(
  id: SubscriptionUsageWindow["id"],
  label: string,
  windowMinutes: number,
  limit: ClaudeSdkUsageLimit | null
): SubscriptionUsageWindow {
  const resetsAt = parseClaudeSdkResetAt(limit?.resetsAt)
  return {
    id,
    label,
    usedPercent: limit?.utilization ?? null,
    windowMinutes,
    resetsAt,
    resetsAtText: limit?.resetsAt ?? null,
  }
}

function parseClaudeSdkResetAt(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function buildProviderSnapshot(
  snapshot: SubscriptionUsageProviderSnapshot
): SubscriptionUsageProviderSnapshot {
  return snapshot
}

function defaultUsageWindows(): SubscriptionUsageWindow[] {
  return [
    {
      id: "five_hour",
      label: "5-hour window",
      usedPercent: null,
      windowMinutes: FIVE_HOUR_MINUTES,
      resetsAt: null,
      resetsAtText: null,
    },
    {
      id: "weekly",
      label: "Weekly window",
      usedPercent: null,
      windowMinutes: WEEKLY_MINUTES,
      resetsAt: null,
      resetsAtText: null,
    },
  ]
}

export function parseCodexAppServerSnapshot(
  accountResult: unknown,
  rateLimitsResult: unknown,
  now = Date.now()
): SubscriptionUsageProviderSnapshot {
  const codexBucket = selectCodexRateLimitBucket(rateLimitsResult)
  const accountEmail = findEmailValue(accountResult)
  const accountRecord = isRecord(accountResult) && isRecord(accountResult.account)
    ? accountResult.account
    : accountResult
  const accountPlanType = isRecord(accountRecord)
    ? asOptionalString(firstDefined(accountRecord, ["planType", "plan_type", "subscriptionType", "subscription_type"]))
    : null

  if (!codexBucket) {
    return buildProviderSnapshot({
      provider: "codex",
      label: "Codex",
      status: "unavailable",
      planType: accountPlanType,
      accountEmail,
      source: CODEX_APP_SERVER_SOURCE,
      updatedAt: now,
      error: "Codex app-server did not return a codex rate-limit bucket.",
      windows: defaultUsageWindows(),
    })
  }

  const windows = codexWindowsFromAppServerBucket(codexBucket)
  const hasUsage = windows.some((window) => window.usedPercent !== null)

  return buildProviderSnapshot({
    provider: "codex",
    label: "Codex",
    status: hasUsage ? "available" : "unavailable",
    planType: accountPlanType ?? asOptionalString(firstDefined(codexBucket, ["planType", "plan_type"])),
    accountEmail,
    source: CODEX_APP_SERVER_SOURCE,
    updatedAt: now,
    error: hasUsage ? null : "Codex app-server did not return usable rate-limit windows.",
    windows,
  })
}

function selectCodexRateLimitBucket(rateLimitsResult: unknown): Record<string, unknown> | null {
  const result = isRecord(rateLimitsResult) ? rateLimitsResult : null
  if (!result) return null

  const byLimitId = asRecord(firstDefined(result, ["rateLimitsByLimitId", "rate_limits_by_limit_id"]))
  const codexBucket = asRecord(byLimitId?.codex)
  if (codexBucket) return codexBucket

  const primaryBucket = asRecord(firstDefined(result, ["rateLimits", "rate_limits"]))
  if (!primaryBucket) return null

  const limitId = asOptionalString(firstDefined(primaryBucket, ["limitId", "limit_id"]))
  if (limitId && limitId !== "codex") return null
  return hasRateLimitWindows(primaryBucket) ? primaryBucket : null
}

function hasRateLimitWindows(bucket: Record<string, unknown>) {
  return Boolean(
    asRecord(firstDefined(bucket, ["primary", "primaryWindow", "primary_window"]))
      || asRecord(firstDefined(bucket, ["secondary", "secondaryWindow", "secondary_window"]))
  )
}

function codexWindowsFromAppServerBucket(bucket: Record<string, unknown>): SubscriptionUsageWindow[] {
  return [
    codexWindowFromAppServerLimit(
      "five_hour",
      "5-hour window",
      asRecord(firstDefined(bucket, ["primary", "primaryWindow", "primary_window"])),
      FIVE_HOUR_MINUTES
    ),
    codexWindowFromAppServerLimit(
      "weekly",
      "Weekly window",
      asRecord(firstDefined(bucket, ["secondary", "secondaryWindow", "secondary_window"])),
      WEEKLY_MINUTES
    ),
  ]
}

function codexWindowFromAppServerLimit(
  id: SubscriptionUsageWindow["id"],
  label: string,
  limit: Record<string, unknown> | null,
  fallbackWindowMinutes: number
): SubscriptionUsageWindow {
  return {
    id,
    label,
    usedPercent: asOptionalNumber(firstDefined(limit, ["usedPercent", "used_percent"])),
    windowMinutes: asOptionalNumber(firstDefined(limit, ["windowDurationMins", "window_duration_mins", "windowMinutes", "window_minutes"]))
      ?? fallbackWindowMinutes,
    resetsAt: normalizeEpochMs(firstDefined(limit, ["resetsAt", "resets_at", "resetAt", "reset_at"])),
    resetsAtText: null,
  }
}

async function readCodexAppServerSnapshot(
  options: { timeoutMs: number }
): Promise<CodexAppServerSnapshot> {
  const child = spawn(getCodexCliCommand(), ["app-server"], {
    cwd: os.homedir(),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...inheritAgentEnvironment(),
      DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY ?? "1",
    },
  })
  const lineReader = createInterface({ input: child.stdout })
  const pending = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>()
  const stderrChunks: string[] = []
  let nextId = 1
  let closed = false

  const stderrText = () => stderrChunks.join("").trim().slice(-1_000)
  const rejectPending = (error: Error) => {
    for (const request of pending.values()) {
      request.reject(error)
    }
    pending.clear()
  }

  child.stderr.on("data", (chunk) => {
    stderrChunks.push(Buffer.from(chunk).toString("utf8"))
  })
  child.on("error", (error) => {
    closed = true
    rejectPending(error)
  })
  child.on("close", (code) => {
    closed = true
    if (pending.size === 0) return
    const detail = stderrText()
    rejectPending(new Error(
      detail
        ? `codex app-server exited with code ${code ?? "unknown"}: ${detail}`
        : `codex app-server exited with code ${code ?? "unknown"}.`
    ))
  })
  lineReader.on("line", (line) => {
    const message = parseJsonObject(line)
    if (!message || !("id" in message)) return

    const request = pending.get(String(message.id))
    if (!request) return
    pending.delete(String(message.id))

    if ("error" in message && message.error) {
      request.reject(new Error(jsonRpcErrorMessage(message.error)))
      return
    }
    request.resolve(message.result)
  })

  const timeout = setTimeout(() => {
    rejectPending(new Error(`codex app-server timed out after ${options.timeoutMs}ms.`))
    child.kill("SIGTERM")
  }, options.timeoutMs)

  const send = (method: string, params: Record<string, unknown>) => {
    if (closed) {
      return Promise.reject(new Error("codex app-server is closed."))
    }

    const id = String(nextId++)
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(payload, (error) => {
        if (!error) return
        pending.delete(id)
        reject(error)
      })
    })
  }
  const notify = (method: string, params: Record<string, unknown> = {}) => {
    if (!closed) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
    }
  }

  try {
    await send("initialize", {
      clientInfo: {
        name: "stillon",
        title: APP_NAME,
        version: APP_VERSION,
      },
      capabilities: {},
    })
    notify("initialized")

    const account = await send("account/read", { refreshToken: false })
    const rateLimits = await send("account/rateLimits/read", {})
    return { account, rateLimits }
  } finally {
    clearTimeout(timeout)
    lineReader.close()
    child.kill("SIGTERM")
  }
}

function parseClaudeAuthStatus(stdout: string): { planType: string | null; accountEmail: string | null } {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (!isRecord(parsed)) return { planType: null, accountEmail: null }
    return {
      planType: asOptionalString(parsed.subscriptionType),
      accountEmail: findEmailValue(parsed),
    }
  } catch {
    return { planType: null, accountEmail: null }
  }
}

function parseClaudeUsageCommandResult(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (isRecord(parsed) && typeof parsed.result === "string") {
      return parsed.result
    }
  } catch {
    return stdout
  }
  return stdout
}

export function parseClaudeUsageResult(resultText: string, now = Date.now()): SubscriptionUsageWindow[] {
  const windows = defaultUsageWindows()
  const lines = resultText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

  for (const line of lines) {
    const sessionMatch = line.match(/^Current session:\s*([0-9]+(?:\.[0-9]+)?)%\s*used(?:\s*[·•-]\s*resets\s*(.+))?$/i)
    if (sessionMatch) {
      windows[0] = claudeWindowFromMatch("five_hour", "5-hour window", FIVE_HOUR_MINUTES, sessionMatch, now)
      continue
    }

    const weeklyMatch = line.match(/^Current week(?:\s*\([^)]*\))?:\s*([0-9]+(?:\.[0-9]+)?)%\s*used(?:\s*[·•-]\s*resets\s*(.+))?$/i)
    if (weeklyMatch) {
      windows[1] = claudeWindowFromMatch("weekly", "Weekly window", WEEKLY_MINUTES, weeklyMatch, now)
    }
  }

  return windows
}

function claudeWindowFromMatch(
  id: SubscriptionUsageWindow["id"],
  label: string,
  windowMinutes: number,
  match: RegExpMatchArray,
  now: number
): SubscriptionUsageWindow {
  const resetText = match[2]?.trim() || null
  return {
    id,
    label,
    usedPercent: asOptionalNumber(match[1]),
    windowMinutes,
    resetsAt: resetText ? parseClaudeResetAtText(resetText, now) : null,
    resetsAtText: resetText,
  }
}

export function parseClaudeResetAtText(resetText: string, now = Date.now()): number | null {
  const match = resetText.match(/^([A-Za-z]+)\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?(?:\s*\(([^)]+)\))?$/i)
  if (!match) return null

  const month = MONTH_INDEX[match[1]?.toLowerCase() ?? ""]
  const day = Number(match[2])
  let hour = Number(match[3])
  const minute = Number(match[4] ?? "0")
  const meridiem = match[5]?.toLowerCase()

  if (month === undefined || !Number.isFinite(day) || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null
  }

  if (meridiem === "pm" && hour < 12) hour += 12
  if (meridiem === "am" && hour === 12) hour = 0

  const nowDate = new Date(now)
  let parsed = new Date(nowDate.getFullYear(), month, day, hour, minute, 0, 0).getTime()
  if (!Number.isFinite(parsed)) return null

  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
  if (parsed < now - thirtyDaysMs) {
    parsed = new Date(nowDate.getFullYear() + 1, month, day, hour, minute, 0, 0).getTime()
  }

  return Number.isFinite(parsed) ? parsed : null
}

async function runCliCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number }
): Promise<{ stdout: string; stderr: string }> {
  let timedOut = false
  const subprocess = Bun.spawn([command, ...args], {
    cwd: os.homedir(),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...inheritAgentEnvironment(),
      DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY ?? "1",
    },
  })
  const timeout = setTimeout(() => {
    timedOut = true
    subprocess.kill("SIGTERM")
  }, options.timeoutMs)

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ])

    if (timedOut) {
      throw new Error(`${command} timed out after ${options.timeoutMs}ms.`)
    }
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${exitCode}.`)
    }

    return { stdout, stderr }
  } finally {
    clearTimeout(timeout)
  }
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function asOptionalNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeEpochMs(value: unknown): number | null {
  const parsed = asOptionalNumber(value)
  if (parsed === null) return null
  return parsed > 10_000_000_000 ? parsed : parsed * 1000
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function firstDefined(record: Record<string, unknown> | null | undefined, keys: string[]): unknown {
  if (!record) return undefined
  for (const key of keys) {
    if (record[key] !== undefined) return record[key]
  }
  return undefined
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line) as unknown)
  } catch {
    return null
  }
}

function jsonRpcErrorMessage(error: unknown) {
  if (!isRecord(error)) return String(error)
  if (typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message
  }
  return JSON.stringify(error)
}

function findEmailValue(value: unknown, depth = 0): string | null {
  if (depth > 4 || !isRecord(value)) return null

  for (const [key, nested] of Object.entries(value)) {
    if (key.toLowerCase() === "email" && typeof nested === "string" && nested.includes("@")) {
      return nested
    }
    const found = findEmailValue(nested, depth + 1)
    if (found) return found
  }

  return null
}

function errorToMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

function isCommandUnavailable(error: unknown) {
  const message = errorToMessage(error, "").toLowerCase()
  return message.includes("enoent") || message.includes("not found") || message.includes("no such file")
}
