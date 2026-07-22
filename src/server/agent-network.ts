import process from "node:process"
import { connect as connectTcp, type Socket } from "node:net"
import { connect as connectTls } from "node:tls"
import type {
  AgentNetworkConnectionTestResult,
  AgentNetworkDetectionResult,
  AgentNetworkMode,
  AgentNetworkProxySettings,
  AgentProvider,
} from "../shared/types"
import {
  getAgentNetworkStatus,
  mergeAgentNetworkEnvironment,
  redactProxyValue,
} from "./agent-environment"

export const DEFAULT_AGENT_NO_PROXY = "localhost,127.0.0.1,::1"

const PROXY_FIELD_LABELS = {
  httpProxy: "HTTP_PROXY",
  httpsProxy: "HTTPS_PROXY",
  allProxy: "ALL_PROXY",
} as const

type ProxyField = keyof typeof PROXY_FIELD_LABELS

export function createDefaultAgentNetworkSettings(): AgentNetworkProxySettings {
  return {
    mode: "system",
    httpProxy: "",
    httpsProxy: "",
    allProxy: "",
    noProxy: DEFAULT_AGENT_NO_PROXY,
  }
}

function normalizeMode(value: unknown): AgentNetworkMode {
  return value === "detected" || value === "manual" || value === "system" ? value : "system"
}

function normalizeProxyUrl(value: unknown, field: ProxyField) {
  const raw = typeof value === "string" ? value.trim() : ""
  if (!raw) return ""
  if (raw.length > 2_048) {
    throw new Error(`${PROXY_FIELD_LABELS[field]} is too long.`)
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${PROXY_FIELD_LABELS[field]} must be a complete proxy URL, for example http://127.0.0.1:7890.`)
  }

  const allowedProtocols = field === "allProxy"
    ? new Set(["http:", "https:", "socks5:", "socks5h:"])
    : new Set(["http:", "https:"])
  if (!allowedProtocols.has(url.protocol)) {
    throw new Error(`${PROXY_FIELD_LABELS[field]} uses an unsupported scheme.`)
  }
  if (!url.hostname) {
    throw new Error(`${PROXY_FIELD_LABELS[field]} must include a host.`)
  }
  if (url.username || url.password) {
    throw new Error(`${PROXY_FIELD_LABELS[field]} cannot contain credentials. Put authenticated proxy URLs in a restricted --env-file instead.`)
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error(`${PROXY_FIELD_LABELS[field]} must not contain a path, query, or fragment.`)
  }

  return url.toString().replace(/\/$/u, "")
}

function normalizeNoProxy(value: unknown, includeLocalDefaults: boolean) {
  const raw = typeof value === "string" ? value.trim() : ""
  if (raw.length > 4_096) throw new Error("NO_PROXY is too long.")

  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  for (const entry of entries) {
    if (/[:][/][/]|[@\u0000-\u001f\u007f]|\s/u.test(entry)) {
      throw new Error(`NO_PROXY contains an invalid entry: ${entry.slice(0, 80)}`)
    }
  }

  if (includeLocalDefaults) {
    for (const localEntry of DEFAULT_AGENT_NO_PROXY.split(",")) {
      if (!entries.some((entry) => entry.toLowerCase() === localEntry.toLowerCase())) {
        entries.push(localEntry)
      }
    }
  }
  return entries.join(",")
}

export function normalizeAgentNetworkSettings(
  value: unknown,
  options: { strict?: boolean } = {},
): { settings: AgentNetworkProxySettings; warnings: string[] } {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<keyof AgentNetworkProxySettings, unknown>>
    : {}
  const settings = createDefaultAgentNetworkSettings()
  const warnings: string[] = []
  settings.mode = normalizeMode(source.mode)

  for (const field of Object.keys(PROXY_FIELD_LABELS) as ProxyField[]) {
    try {
      settings[field] = normalizeProxyUrl(source[field], field)
    } catch (error) {
      if (options.strict) throw error
      warnings.push(error instanceof Error ? error.message : String(error))
      settings[field] = ""
    }
  }

  try {
    settings.noProxy = normalizeNoProxy(source.noProxy, settings.mode !== "system") || DEFAULT_AGENT_NO_PROXY
  } catch (error) {
    if (options.strict) throw error
    warnings.push(error instanceof Error ? error.message : String(error))
    settings.noProxy = DEFAULT_AGENT_NO_PROXY
  }

  return { settings, warnings }
}

export function applyAgentNetworkPatch(
  current: AgentNetworkProxySettings,
  patch: Partial<AgentNetworkProxySettings>,
) {
  return normalizeAgentNetworkSettings({ ...current, ...patch }, { strict: true }).settings
}

interface DetectionCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

type DetectionCommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<DetectionCommandResult>

async function runDetectionCommand(command: string, args: string[], timeoutMs: number): Promise<DetectionCommandResult> {
  const child = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGTERM")
  }, timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (timedOut) throw new Error("System proxy detection timed out.")
    return { stdout, stderr, exitCode }
  } finally {
    clearTimeout(timer)
  }
}

function proxyUrl(scheme: string, host: string, port: string | number) {
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  return `${scheme}://${normalizedHost}:${port}`
}

function detectedSettings(values: Partial<AgentNetworkProxySettings>): AgentNetworkProxySettings {
  return normalizeAgentNetworkSettings({
    ...createDefaultAgentNetworkSettings(),
    ...values,
    mode: "detected",
  }, { strict: true }).settings
}

function detectionResult(args: Omit<AgentNetworkDetectionResult, "platform"> & { platform?: NodeJS.Platform }): AgentNetworkDetectionResult {
  return { platform: args.platform ?? process.platform, ...args }
}

export function parseMacOsProxySettings(output: string): AgentNetworkDetectionResult {
  const readValue = (key: string) => output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m"))?.[1]?.trim() ?? ""
  const isEnabled = (key: string) => readValue(key) === "1"
  const values: Partial<AgentNetworkProxySettings> = {}

  if (isEnabled("HTTPEnable") && readValue("HTTPProxy") && readValue("HTTPPort")) {
    values.httpProxy = proxyUrl("http", readValue("HTTPProxy"), readValue("HTTPPort"))
  }
  if (isEnabled("HTTPSEnable") && readValue("HTTPSProxy") && readValue("HTTPSPort")) {
    values.httpsProxy = proxyUrl("http", readValue("HTTPSProxy"), readValue("HTTPSPort"))
  }
  if (isEnabled("SOCKSEnable") && readValue("SOCKSProxy") && readValue("SOCKSPort")) {
    values.allProxy = proxyUrl("socks5", readValue("SOCKSProxy"), readValue("SOCKSPort"))
  }

  const exceptionsBlock = output.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\n\s*\}/u)?.[1] ?? ""
  const exceptions = [...exceptionsBlock.matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gmu)].map((match) => match[1] ?? "")
  if (exceptions.length > 0) values.noProxy = exceptions.join(",")

  const pacDetected = isEnabled("ProxyAutoConfigEnable") || Boolean(readValue("ProxyAutoConfigURLString"))
  if (!values.httpProxy && !values.httpsProxy && !values.allProxy) {
    return detectionResult({
      platform: "darwin",
      status: pacDetected ? "pac_only" : "none",
      sourceLabel: "macOS System Configuration",
      settings: null,
      message: pacDetected
        ? "macOS has a PAC configuration. StillOn does not execute PAC scripts; enter the resolved proxy manually."
        : "macOS does not declare a manual HTTP, HTTPS, or SOCKS proxy.",
      pacUrlDetected: pacDetected,
    })
  }
  return detectionResult({
    platform: "darwin",
    status: "detected",
    sourceLabel: "macOS System Configuration",
    settings: detectedSettings(values),
    message: pacDetected
      ? "Detected manual proxy values. A PAC configuration also exists and was not executed. Review before saving."
      : "Detected system proxy values. Review them before saving.",
    pacUrlDetected: pacDetected,
  })
}

function parseWindowsProxyServer(value: string) {
  const values: Partial<AgentNetworkProxySettings> = {}
  const parts = value.split(";").map((part) => part.trim()).filter(Boolean)
  const assignments = parts.filter((part) => part.includes("="))
  const asUrl = (raw: string, scheme = "http") => /^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : `${scheme}://${raw}`
  if (assignments.length === 0 && parts[0]) {
    values.httpProxy = asUrl(parts[0])
    values.httpsProxy = asUrl(parts[0])
    return values
  }
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=")
    const kind = assignment.slice(0, separator).trim().toLowerCase()
    const endpoint = assignment.slice(separator + 1).trim()
    if (!endpoint) continue
    if (kind === "http") values.httpProxy = asUrl(endpoint)
    if (kind === "https") values.httpsProxy = asUrl(endpoint)
    if (kind === "socks" || kind === "socks5") values.allProxy = asUrl(endpoint, "socks5")
  }
  return values
}

export function parseWindowsProxySettings(output: string): AgentNetworkDetectionResult {
  let parsed: { ProxyEnable?: unknown; ProxyServer?: unknown; ProxyOverride?: unknown; AutoConfigURL?: unknown; WinHttp?: unknown }
  try {
    parsed = JSON.parse(output) as typeof parsed
  } catch {
    return detectionResult({
      platform: "win32",
      status: "error",
      sourceLabel: "Windows proxy settings",
      settings: null,
      message: "Windows returned proxy settings in an unreadable format.",
      pacUrlDetected: false,
    })
  }

  const pacDetected = typeof parsed.AutoConfigURL === "string" && parsed.AutoConfigURL.trim().length > 0
  let values: Partial<AgentNetworkProxySettings> = {}
  if (parsed.ProxyEnable === true || parsed.ProxyEnable === 1) {
    values = parseWindowsProxyServer(typeof parsed.ProxyServer === "string" ? parsed.ProxyServer : "")
    if (typeof parsed.ProxyOverride === "string") values.noProxy = parsed.ProxyOverride.replace(/;/gu, ",").replace(/<local>/giu, "localhost")
  }

  if (!values.httpProxy && !values.httpsProxy && !values.allProxy && typeof parsed.WinHttp === "string") {
    const proxy = parsed.WinHttp.match(/Proxy Server\(s\)\s*:\s*(.+)/iu)?.[1]?.trim()
    if (proxy && !/Direct access/iu.test(proxy)) values = parseWindowsProxyServer(proxy)
    const bypass = parsed.WinHttp.match(/Bypass List\s*:\s*(.+)/iu)?.[1]?.trim()
    if (bypass) values.noProxy = bypass.replace(/;/gu, ",")
  }

  if (!values.httpProxy && !values.httpsProxy && !values.allProxy) {
    return detectionResult({
      platform: "win32",
      status: pacDetected ? "pac_only" : "none",
      sourceLabel: "Windows user / WinHTTP proxy",
      settings: null,
      message: pacDetected
        ? "Windows has a PAC configuration. StillOn does not execute PAC scripts; enter the resolved proxy manually."
        : "Windows does not declare a manual user or WinHTTP proxy.",
      pacUrlDetected: pacDetected,
    })
  }
  return detectionResult({
    platform: "win32",
    status: "detected",
    sourceLabel: "Windows user / WinHTTP proxy",
    settings: detectedSettings(values),
    message: "Detected Windows proxy values. Review them before saving.",
    pacUrlDetected: pacDetected,
  })
}

function unquoteGSettings(value: string) {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseLinuxProxySettings(output: string): AgentNetworkDetectionResult {
  const valuesByKey = new Map<string, string>()
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^org\.gnome\.system\.proxy(?:\.([a-z]+))?\s+([a-z-]+)\s+(.+)$/u)
    if (!match) continue
    valuesByKey.set(`${match[1] ?? "root"}.${match[2]}`, match[3] ?? "")
  }
  const mode = unquoteGSettings(valuesByKey.get("root.mode") ?? "")
  const pacDetected = mode === "auto"
  if (mode !== "manual") {
    return detectionResult({
      platform: "linux",
      status: pacDetected ? "pac_only" : "none",
      sourceLabel: "GNOME system proxy",
      settings: null,
      message: pacDetected
        ? "GNOME uses automatic proxy configuration. StillOn does not execute PAC scripts; enter the resolved proxy manually."
        : "GNOME does not declare a manual proxy. Other Linux desktop proxy stores are not changed or scanned.",
      pacUrlDetected: pacDetected,
    })
  }

  const values: Partial<AgentNetworkProxySettings> = {}
  const addEndpoint = (kind: "http" | "https" | "socks", field: ProxyField, scheme: string) => {
    const host = unquoteGSettings(valuesByKey.get(`${kind}.host`) ?? "")
    const port = unquoteGSettings(valuesByKey.get(`${kind}.port`) ?? "")
    if (host && port && port !== "0") values[field] = proxyUrl(scheme, host, port)
  }
  addEndpoint("http", "httpProxy", "http")
  addEndpoint("https", "httpsProxy", "http")
  addEndpoint("socks", "allProxy", "socks5")
  const ignoredHosts = valuesByKey.get("root.ignore-hosts")?.match(/'([^']+)'/gu)?.map((entry) => entry.slice(1, -1)) ?? []
  if (ignoredHosts.length > 0) values.noProxy = ignoredHosts.join(",")

  if (!values.httpProxy && !values.httpsProxy && !values.allProxy) {
    return detectionResult({
      platform: "linux",
      status: "none",
      sourceLabel: "GNOME system proxy",
      settings: null,
      message: "GNOME is in manual mode but does not declare a usable proxy host and port.",
      pacUrlDetected: false,
    })
  }
  return detectionResult({
    platform: "linux",
    status: "detected",
    sourceLabel: "GNOME system proxy",
    settings: detectedSettings(values),
    message: "Detected GNOME proxy values. Review them before saving.",
    pacUrlDetected: false,
  })
}

export async function detectSystemProxy(options: {
  platform?: NodeJS.Platform
  runCommand?: DetectionCommandRunner
  timeoutMs?: number
} = {}): Promise<AgentNetworkDetectionResult> {
  const platform = options.platform ?? process.platform
  const runCommand = options.runCommand ?? runDetectionCommand
  const timeoutMs = options.timeoutMs ?? 5_000
  try {
    if (platform === "darwin") {
      const result = await runCommand("scutil", ["--proxy"], timeoutMs)
      if (result.exitCode !== 0) throw new Error("scutil failed")
      return parseMacOsProxySettings(result.stdout)
    }
    if (platform === "win32") {
      const script = [
        "$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue",
        "$w = (& netsh winhttp show proxy 2>$null) -join \"`n\"",
        "[PSCustomObject]@{ ProxyEnable = [bool]$p.ProxyEnable; ProxyServer = $p.ProxyServer; ProxyOverride = $p.ProxyOverride; AutoConfigURL = $p.AutoConfigURL; WinHttp = $w } | ConvertTo-Json -Compress",
      ].join("; ")
      const result = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], timeoutMs)
      if (result.exitCode !== 0) throw new Error("PowerShell failed")
      return parseWindowsProxySettings(result.stdout)
    }
    if (platform === "linux") {
      const result = await runCommand("gsettings", ["list-recursively", "org.gnome.system.proxy"], timeoutMs)
      if (result.exitCode !== 0) {
        return detectionResult({
          platform,
          status: "unsupported",
          sourceLabel: "Linux desktop proxy",
          settings: null,
          message: "No supported desktop proxy store was available. Keep system mode for VPN routing or enter a proxy manually.",
          pacUrlDetected: false,
        })
      }
      return parseLinuxProxySettings(result.stdout)
    }
    return detectionResult({
      platform,
      status: "unsupported",
      sourceLabel: "System proxy",
      settings: null,
      message: `Automatic proxy detection is not supported on ${platform}. Use system routing or enter a proxy manually.`,
      pacUrlDetected: false,
    })
  } catch {
    return detectionResult({
      platform,
      status: "error",
      sourceLabel: "System proxy",
      settings: null,
      message: "StillOn could not read the operating system proxy settings. No network settings were changed.",
      pacUrlDetected: false,
    })
  }
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string) {
  return environment[name]?.trim() || environment[name.toLowerCase()]?.trim() || ""
}

function hostMatchesNoProxy(hostname: string, noProxy: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "")
  return noProxy.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean).some((entry) => {
    if (entry === "*") return true
    const colonCount = (entry.match(/:/gu) ?? []).length
    const closingBracket = entry.indexOf("]")
    const withoutPort = entry.startsWith("[") && closingBracket > 0
      ? entry.slice(1, closingBracket)
      : colonCount === 1
        ? entry.replace(/:\d+$/u, "")
        : entry
    const pattern = withoutPort.replace(/^\*/u, "").replace(/^\./u, "")
    return host === pattern || (!pattern.includes(":") && host.endsWith(`.${pattern}`))
  })
}

export function resolveAgentProxyForUrl(
  url: URL,
  environment: NodeJS.ProcessEnv,
) {
  if (hostMatchesNoProxy(url.hostname, environmentValue(environment, "NO_PROXY"))) return ""
  if (url.protocol === "https:") {
    return environmentValue(environment, "HTTPS_PROXY")
      || environmentValue(environment, "ALL_PROXY")
      || environmentValue(environment, "HTTP_PROXY")
  }
  return environmentValue(environment, "HTTP_PROXY")
    || environmentValue(environment, "ALL_PROXY")
}

export function createAgentNetworkFetch(
  environment: NodeJS.ProcessEnv,
  fetchImpl: ProxyFetch = fetch as unknown as ProxyFetch,
): typeof fetch {
  const agentFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL
      ? input
      : input instanceof Request
        ? new URL(input.url)
        : new URL(input)
    const proxy = resolveAgentProxyForUrl(url, environment)
    if (/^socks5h?:/iu.test(proxy)) {
      throw new Error("The embedded Quick Response SDK cannot use a SOCKS5 proxy directly; Claude/Codex fallback agents will use the configured proxy.")
    }
    return await fetchImpl(input, {
      ...init,
      ...(proxy ? { proxy } : {}),
    })
  }
  return agentFetch as typeof fetch
}

function connectionErrorCode(error: unknown, usingProxy: boolean): AgentNetworkConnectionTestResult["errorCode"] {
  const record = error && typeof error === "object" ? error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown } : {}
  const cause = record.cause && typeof record.cause === "object" ? record.cause as { code?: unknown; message?: unknown } : {}
  const code = String(cause.code ?? record.code ?? "").toUpperCase()
  const message = `${String(record.name ?? "")} ${String(record.message ?? "")} ${String(cause.message ?? "")}`.toLowerCase()
  if (record.name === "AbortError" || record.name === "TimeoutError" || message.includes("timed out") || message.includes("timeout")) return "timeout"
  if (message.includes("407") || message.includes("proxy authentication")) return "proxy_auth_required"
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return usingProxy ? "proxy_unreachable" : "dns_failed"
  if (usingProxy && ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "proxy_unreachable"
  if (message.includes("certificate") || message.includes("tls") || message.includes("ssl") || code.startsWith("ERR_TLS") || code.includes("CERT")) return "tls_failed"
  return usingProxy ? "proxy_rejected" : "http_failed"
}

function connectionErrorMessage(code: AgentNetworkConnectionTestResult["errorCode"], targetLabel: string) {
  switch (code) {
    case "dns_failed":
      return `DNS could not resolve ${targetLabel}. Check the active VPN, DNS, or system network.`
    case "proxy_unreachable":
      return "The configured proxy could not be reached. Confirm that the proxy app is running and the host/port are correct."
    case "proxy_auth_required":
      return "The proxy requires authentication. Store the credentialed URL in a restricted --env-file; Settings never stores proxy credentials."
    case "tls_failed":
      return `A TLS connection to ${targetLabel} could not be established. Check proxy interception certificates and the system clock.`
    case "timeout":
      return "The connection timed out. Check the VPN/proxy route and firewall, then try again."
    case "proxy_rejected":
      return `The proxy rejected or could not complete the connection to ${targetLabel}.`
    case "invalid_configuration":
      return "The effective proxy configuration is invalid. Review Settings or the service --env-file."
    case "http_failed":
    default:
      return `${targetLabel} could not be reached over HTTP. Check the active VPN, proxy, and firewall.`
  }
}

type ProxyFetch = (input: RequestInfo | URL, init: RequestInit & { proxy?: string }) => Promise<Response>

class SocksConnectionError extends Error {
  constructor(readonly diagnosticCode: NonNullable<AgentNetworkConnectionTestResult["errorCode"]>) {
    super(diagnosticCode)
  }
}

class SocketByteReader {
  private buffer = Buffer.alloc(0)
  private pending: { length: number; resolve: (value: Buffer) => void; reject: (error: Error) => void } | null = null
  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.flush()
  }
  private readonly onError = (error: Error) => this.reject(error)
  private readonly onClose = () => this.reject(new Error("Proxy connection closed unexpectedly."))

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData)
    socket.on("error", this.onError)
    socket.on("close", this.onClose)
  }

  read(length: number) {
    if (this.pending) throw new Error("Concurrent proxy reads are not supported.")
    if (this.buffer.length >= length) {
      const value = this.buffer.subarray(0, length)
      this.buffer = this.buffer.subarray(length)
      return Promise.resolve(value)
    }
    return new Promise<Buffer>((resolve, reject) => {
      this.pending = { length, resolve, reject }
    })
  }

  dispose() {
    this.socket.off("data", this.onData)
    this.socket.off("error", this.onError)
    this.socket.off("close", this.onClose)
  }

  private flush() {
    if (!this.pending || this.buffer.length < this.pending.length) return
    const pending = this.pending
    this.pending = null
    const value = this.buffer.subarray(0, pending.length)
    this.buffer = this.buffer.subarray(pending.length)
    pending.resolve(value)
  }

  private reject(error: Error) {
    if (!this.pending) return
    const pending = this.pending
    this.pending = null
    pending.reject(error)
  }
}

function connectSocket(host: string, port: number, timeoutMs: number) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connectTcp({ host, port })
    const fail = (error: Error) => {
      socket.destroy()
      reject(error)
    }
    socket.setTimeout(timeoutMs, () => fail(new SocksConnectionError("timeout")))
    socket.once("error", fail)
    socket.once("connect", () => {
      socket.off("error", fail)
      resolve(socket)
    })
  })
}

async function testSocks5TlsHttp(proxyUrl: URL, targetUrl: URL, timeoutMs: number) {
  const port = Number(proxyUrl.port || 1080)
  let socket: Socket
  try {
    socket = await connectSocket(proxyUrl.hostname, port, timeoutMs)
  } catch (error) {
    if (error instanceof SocksConnectionError) throw error
    throw new SocksConnectionError("proxy_unreachable")
  }
  const reader = new SocketByteReader(socket)

  try {
    const hasCredentials = Boolean(proxyUrl.username || proxyUrl.password)
    socket.write(Buffer.from(hasCredentials ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))
    const greeting = await reader.read(2)
    if (greeting[0] !== 0x05 || greeting[1] === 0xff) throw new SocksConnectionError("proxy_auth_required")
    if (greeting[1] === 0x02) {
      const username = Buffer.from(decodeURIComponent(proxyUrl.username), "utf8")
      const password = Buffer.from(decodeURIComponent(proxyUrl.password), "utf8")
      if (username.length > 255 || password.length > 255) throw new SocksConnectionError("proxy_auth_required")
      socket.write(Buffer.concat([
        Buffer.from([0x01, username.length]),
        username,
        Buffer.from([password.length]),
        password,
      ]))
      const auth = await reader.read(2)
      if (auth[1] !== 0x00) throw new SocksConnectionError("proxy_auth_required")
    } else if (greeting[1] !== 0x00) {
      throw new SocksConnectionError("proxy_rejected")
    }

    const targetHost = Buffer.from(targetUrl.hostname, "utf8")
    if (targetHost.length > 255) throw new SocksConnectionError("invalid_configuration")
    const targetPort = Number(targetUrl.port || 443)
    socket.write(Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, targetHost.length]),
      targetHost,
      Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    ]))
    const reply = await reader.read(4)
    if (reply[0] !== 0x05 || reply[1] !== 0x00) {
      throw new SocksConnectionError(reply[1] === 0x02 ? "proxy_rejected" : "proxy_unreachable")
    }
    const addressLength = reply[3] === 0x01
      ? 4
      : reply[3] === 0x04
        ? 16
        : reply[3] === 0x03
          ? (await reader.read(1))[0] ?? 0
          : 0
    if (!addressLength) throw new SocksConnectionError("proxy_rejected")
    await reader.read(addressLength + 2)
    reader.dispose()

    const tlsSocket = connectTls({ socket, servername: targetUrl.hostname })
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error)
      tlsSocket.setTimeout(timeoutMs, () => reject(new SocksConnectionError("timeout")))
      tlsSocket.once("error", fail)
      tlsSocket.once("secureConnect", () => {
        tlsSocket.off("error", fail)
        resolve()
      })
    }).catch((error) => {
      if (error instanceof SocksConnectionError) throw error
      throw new SocksConnectionError("tls_failed")
    })

    tlsSocket.write(`HEAD ${targetUrl.pathname || "/"} HTTP/1.1\r\nHost: ${targetUrl.hostname}\r\nConnection: close\r\n\r\n`)
    await new Promise<void>((resolve, reject) => {
      tlsSocket.once("data", (chunk) => {
        const statusLine = Buffer.from(chunk).toString("utf8").split(/\r?\n/u)[0] ?? ""
        if (/^HTTP\/\d(?:\.\d)?\s+\d{3}\b/u.test(statusLine)) resolve()
        else reject(new SocksConnectionError("http_failed"))
      })
      tlsSocket.once("error", () => reject(new SocksConnectionError("http_failed")))
      tlsSocket.once("timeout", () => reject(new SocksConnectionError("timeout")))
    })
    tlsSocket.destroy()
  } finally {
    reader.dispose()
    socket.destroy()
  }
}

export async function testAgentNetworkConnection(args: {
  provider: AgentProvider
  settings: AgentNetworkProxySettings
  environment?: NodeJS.ProcessEnv
  fetchImpl?: ProxyFetch
  timeoutMs?: number
}): Promise<AgentNetworkConnectionTestResult> {
  const startedAt = performance.now()
  const environment = mergeAgentNetworkEnvironment(args.environment ?? process.env, args.settings)
  const status = getAgentNetworkStatus(args.settings, args.environment ?? process.env)
  const target = args.provider === "claude"
    ? { label: "Claude API", url: "https://api.anthropic.com/" }
    : { label: "Codex / ChatGPT", url: "https://chatgpt.com/" }
  const targetUrl = new URL(target.url)
  const rawProxy = resolveAgentProxyForUrl(targetUrl, environment)
  let proxy: string | undefined
  let parsedProxy: URL | null = null
  if (rawProxy) {
    try {
      parsedProxy = new URL(rawProxy)
      if (!parsedProxy.hostname) throw new Error("missing host")
      proxy = rawProxy
    } catch {
      return {
        ok: false,
        provider: args.provider,
        targetLabel: target.label,
        sourceLabel: status.sourceLabel,
        proxy: "Configured (invalid URL)",
        durationMs: Math.round(performance.now() - startedAt),
        errorCode: "invalid_configuration",
        message: connectionErrorMessage("invalid_configuration", target.label),
      }
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 10_000)
  try {
    if (parsedProxy?.protocol === "socks5:" || parsedProxy?.protocol === "socks5h:") {
      await testSocks5TlsHttp(parsedProxy, targetUrl, args.timeoutMs ?? 10_000)
      return {
        ok: true,
        provider: args.provider,
        targetLabel: target.label,
        sourceLabel: status.sourceLabel,
        proxy: redactProxyValue(proxy ?? ""),
        durationMs: Math.round(performance.now() - startedAt),
        errorCode: null,
        message: `${target.label} is reachable through the effective SOCKS5 proxy.`,
      }
    }
    const fetchImpl = args.fetchImpl ?? (fetch as unknown as ProxyFetch)
    const response = await fetchImpl(target.url, {
      method: "HEAD",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
      ...(proxy ? { proxy } : {}),
    })
    if (response.status === 407) {
      return {
        ok: false,
        provider: args.provider,
        targetLabel: target.label,
        sourceLabel: status.sourceLabel,
        proxy: proxy ? redactProxyValue(proxy) : null,
        durationMs: Math.round(performance.now() - startedAt),
        errorCode: "proxy_auth_required",
        message: connectionErrorMessage("proxy_auth_required", target.label),
      }
    }
    if ([502, 503, 504].includes(response.status)) {
      const errorCode = proxy ? "proxy_rejected" : "http_failed"
      return {
        ok: false,
        provider: args.provider,
        targetLabel: target.label,
        sourceLabel: status.sourceLabel,
        proxy: proxy ? redactProxyValue(proxy) : null,
        durationMs: Math.round(performance.now() - startedAt),
        errorCode,
        message: connectionErrorMessage(errorCode, target.label),
      }
    }
    return {
      ok: true,
      provider: args.provider,
      targetLabel: target.label,
      sourceLabel: status.sourceLabel,
      proxy: proxy ? redactProxyValue(proxy) : null,
      durationMs: Math.round(performance.now() - startedAt),
      errorCode: null,
      message: `${target.label} is reachable${proxy ? " through the effective proxy" : " through the system network"}.`,
    }
  } catch (error) {
    const errorCode = error instanceof SocksConnectionError
      ? error.diagnosticCode
      : connectionErrorCode(error, Boolean(proxy))
    return {
      ok: false,
      provider: args.provider,
      targetLabel: target.label,
      sourceLabel: status.sourceLabel,
      proxy: proxy ? redactProxyValue(proxy) : null,
      durationMs: Math.round(performance.now() - startedAt),
      errorCode,
      message: connectionErrorMessage(errorCode, target.label),
    }
  } finally {
    clearTimeout(timer)
  }
}
