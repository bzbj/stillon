import { execFile } from "node:child_process"
import path from "node:path"
import { readFile } from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const LOCAL_HTTP_SCAN_TIMEOUT_MS = 450
const LOCAL_HTTP_CACHE_TTL_MS = 30_000

interface LocalHttpServerCacheEntry {
  signature: string
  scannedAt: number
  results: LocalHttpServerInfo[]
}

const localHttpServerCache = new Map<string, LocalHttpServerCacheEntry>()

export interface LocalHttpServerInfo {
  title: string
  address: string
  port: number
  status: number
  ownerPath?: string
  processName?: string
  sameProject?: boolean
}

interface ListeningPortOwner {
  command: string
  pid: number
}

export interface ListeningPortEntry {
  port: number
  owners: ListeningPortOwner[]
}

function stripHtmlTags(text: string) {
  let result = ""
  let cursor = 0

  while (cursor < text.length) {
    const tagStart = text.indexOf("<", cursor)
    if (tagStart === -1) {
      result += text.slice(cursor)
      break
    }

    const tagEnd = text.indexOf(">", tagStart + 1)
    if (tagEnd === -1) {
      result += text.slice(cursor)
      break
    }

    result += text.slice(cursor, tagStart)
    cursor = tagEnd + 1
  }

  return result
}

export function extractHtmlTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return ""
  return stripHtmlTags(match[1])
    .replace(/\s+/g, " ")
    .trim()
}

export function parseLsofListeningEntries(output: string) {
  const entriesByPort = new Map<number, ListeningPortEntry>()

  for (const line of output.split("\n").slice(1)) {
    const match = line.match(/^(\S+)\s+(\d+).*TCP\s+(?:.+?):(\d+)\s+\(LISTEN\)/)
    if (!match) continue

    const command = match[1]
    const pid = Number(match[2])
    const port = Number(match[3])
    if (!Number.isInteger(pid) || !Number.isInteger(port) || port <= 0 || port > 65535) {
      continue
    }

    const entry = entriesByPort.get(port) ?? { port, owners: [] }
    if (!entry.owners.some((owner) => owner.pid === pid)) {
      entry.owners.push({ command, pid })
    }
    entriesByPort.set(port, entry)
  }

  return [...entriesByPort.values()].sort((a, b) => a.port - b.port)
}

export function parseLsofListeningPorts(output: string) {
  return parseLsofListeningEntries(output).map((entry) => entry.port)
}

export function parseWindowsListeningEntries(output: string) {
  const entries = new Map<number, ListeningPortEntry>()
  for (const line of output.split("\n")) {
    const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
    if (!match) continue
    const port = Number(match[1]), pid = Number(match[2])
    if (port < 1 || port > 65535 || pid < 1) continue
    const entry = entries.get(port) ?? { port, owners: [] }
    if (!entry.owners.some(owner => owner.pid === pid)) entry.owners.push({ command: "", pid })
    entries.set(port, entry)
  }
  return [...entries.values()].sort((a, b) => a.port - b.port)
}

export function isPathWithin(parentPath: string | undefined, childPath: string | undefined) {
  if (!parentPath || !childPath) return false
  const normalizedParent = path.resolve(parentPath)
  const normalizedChild = path.resolve(childPath)
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`)
}

export function isDescendantPid(pid: number, rootPids: Set<number>, parentByPid: Map<number, number>) {
  let current: number | undefined = pid
  const visited = new Set<number>()

  while (current !== undefined && current > 0 && !visited.has(current)) {
    if (rootPids.has(current)) return true
    visited.add(current)
    current = parentByPid.get(current)
  }

  return false
}

function isLikelyInternalResponder(server: LocalHttpServerInfo) {
  if (server.status < 200 || server.status >= 400) return true
  if (/^(localhost:\d+|502 Bad Gateway|Welcome to nginx!)$/i.test(server.title)) return true
  if (/^(nginx|cloudflar|workerd|agent-bro|Google|Cursor|ControlCe|figma_age|Superhuma|Spotify|redis|postgres|mysqld)/i.test(server.processName ?? "")) {
    return true
  }
  return false
}

export function filterLocalHttpServers(servers: LocalHttpServerInfo[]) {
  return servers.filter((server) => !isLikelyInternalResponder(server))
}

async function listListeningTcpEntries() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("netstat.exe", ["-ano"], { timeout: 1_500, maxBuffer: 1024 * 1024 })
      return parseWindowsListeningEntries(stdout)
    }
    const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      timeout: 1_500,
      maxBuffer: 1024 * 1024,
    })
    return parseLsofListeningEntries(stdout)
  } catch {
    return []
  }
}

function getListeningEntriesSignature(entries: ListeningPortEntry) {
  return `${entries.port}:${entries.owners.map((owner) => `${owner.command}:${owner.pid}`).join(",")}`
}

function getListeningEntryListSignature(entries: ListeningPortEntry[]) {
  return entries.map(getListeningEntriesSignature).join("|")
}

async function findListeningTcpEntry(port: number) {
  const entries = await listListeningTcpEntries()
  return entries.find((entry) => entry.port === port)
}

export class PreviewServiceUnavailableError extends Error {}

/** A port number is not a process identity. Do not reuse discovery's TTL here. */
export async function readPreviewServiceIdentity(port: number) {
  const entry = await findListeningTcpEntry(port)
  if (!entry?.owners.length) throw new PreviewServiceUnavailableError("The local web service is unavailable")
  if (process.platform === "win32") {
    const ids = entry.owners.map(owner => owner.pid).sort((a, b) => a - b)
    const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "Get-Process -Id " + ids.join(",") + " -ErrorAction Stop | ForEach-Object { '{0}:{1}' -f $_.Id,$_.StartTime.ToUniversalTime().Ticks }"],
    { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true })
    const values = stdout.trim().split(/\r?\n/u)
    if (values.length !== ids.length || values.some(value => !/^\d+:\d+$/u.test(value))) throw new Error("The local service identity could not be verified")
    return values.sort().join("|")
  }
  return (await Promise.all(entry.owners.map(async owner => {
    let started: string
    if (process.platform === "linux") {
      const value = await readFile("/proc/" + owner.pid + "/stat", "utf8")
      started = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/u)[19] ?? ""
    } else {
      started = (await execFileAsync("ps", ["-p", String(owner.pid), "-o", "lstart="], { timeout: 1_500, maxBuffer: 4096 })).stdout.trim()
    }
    if (!started) throw new Error("The local service identity could not be verified")
    return owner.pid + ":" + started
  }))).sort().join("|")
}

export async function killLocalHttpServer(port: number) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Port is invalid.")
  }

  const entry = await findListeningTcpEntry(port)
  const owner = entry?.owners[0]
  if (!owner) {
    throw new Error(`No listening process found on port ${port}.`)
  }

  try {
    process.kill(owner.pid, "SIGTERM")
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : `Unable to kill process on port ${port}.`)
  }

  return {
    ok: true,
    port,
    processName: owner.command,
  }
}

async function readProcessCwd(pid: number) {
  if (process.platform === "win32") return undefined
  try {
    const { stdout } = await execFileAsync("lsof", ["-p", String(pid), "-a", "-d", "cwd", "-Fn"], {
      timeout: 500,
      maxBuffer: 128 * 1024,
    })
    return stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1)
  } catch {
    return undefined
  }
}

async function readParentProcessMap() {
  const parentByPid = new Map<number, number>()
  if (process.platform === "win32") return parentByPid
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=", "-o", "ppid="], {
      timeout: 500,
      maxBuffer: 1024 * 1024,
    })
    for (const line of stdout.split("\n")) {
      const [pidText, ppidText] = line.trim().split(/\s+/)
      const pid = Number(pidText)
      const ppid = Number(ppidText)
      if (Number.isInteger(pid) && Number.isInteger(ppid)) {
        parentByPid.set(pid, ppid)
      }
    }
  } catch {
    // Process ancestry is an enrichment only; discovery still works without it.
  }
  return parentByPid
}

function probeLocalHttp(url: URL, host: string, signal: AbortSignal, redirects = 3): Promise<Response> {
  return new Promise((resolve, reject) => {
    let settled = false, connection: net.Socket | undefined
    const fail = (error: Error) => {
      if (settled) return
      settled = true; signal.removeEventListener("abort", abort)
      request.destroy(); connection?.destroy(); reject(error)
    }
    const abort = () => fail(new Error("Local service discovery timed out"))
    // Dial the selected loopback family directly. Bun's fetch proxy handling
    // can otherwise send literal IPv6 through the process's egress proxy.
    const request = http.request({ hostname: "localhost", port: Number(url.port || 80), path: url.pathname + url.search,
      agent: false, headers: { Host: url.host, "Accept-Encoding": "identity" },
      createConnection: () => connection = net.connect({ host, port: Number(url.port || 80) }),
    }, response => {
      const chunks: Buffer[] = []
      let bytes = 0
      const finish = () => {
        if (settled) return
        settled = true; signal.removeEventListener("abort", abort)
        const location = response.headers.location
        const status = response.statusCode ?? 502
        if (redirects > 0 && status >= 300 && status < 400 && location) {
          let next: URL | undefined
          try { next = new URL(location, url) } catch { /* Ignore malformed redirect hints. */ }
          if (next && next.protocol === "http:" && next.port === url.port && !next.username && !next.password
            && ["localhost", "127.0.0.1", "[::1]"].includes(next.hostname)) {
            resolve(probeLocalHttp(next, host, signal, redirects - 1)); request.destroy(); connection?.destroy(); return
          }
        }
        try { resolve(new Response(Buffer.concat(chunks).subarray(0, 64 * 1024), { status,
          headers: { "Content-Type": String(response.headers["content-type"] ?? "") } })) } catch (error) { reject(error) }
        request.destroy(); connection?.destroy()
      }
      response.on("data", chunk => { const data = Buffer.from(chunk); chunks.push(data); bytes += data.length; if (bytes >= 64 * 1024) finish() })
      response.on("end", finish); response.on("error", fail)
    })
    signal.addEventListener("abort", abort, { once: true })
    request.on("error", fail)
    if (signal.aborted) abort(); else request.end()
  })
}

async function readHttpServer(
  entry: ListeningPortEntry,
  args: {
    fetchImpl?: typeof fetch
    ownerPath?: string
    processName?: string
    projectPath?: string
    projectTerminalRootPids: Set<number>
    parentByPid: Map<number, number>
  }
): Promise<LocalHttpServerInfo | null> {
  const address = `http://localhost:${entry.port}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LOCAL_HTTP_SCAN_TIMEOUT_MS)

  try {
    // Some runtimes resolve localhost to only one family. Probe both actual
    // loopback listeners while retaining the application's localhost Host.
    const response = await Promise.any(["127.0.0.1", "::1"].map(host => args.fetchImpl
      ? args.fetchImpl(`http://${host.includes(":") ? "[" + host + "]" : host}:${entry.port}`, {
        signal: controller.signal, redirect: "follow", headers: { Host: `localhost:${entry.port}` },
      }) : probeLocalHttp(new URL(address), host, controller.signal)))
    const contentType = response.headers.get("content-type") ?? ""
    const text = await response.text().catch(() => "")
    const title = contentType.toLowerCase().includes("text/html")
      ? extractHtmlTitle(text)
      : ""
    const sameProject = isPathWithin(args.projectPath, args.ownerPath)
      || entry.owners.some((owner) => isDescendantPid(owner.pid, args.projectTerminalRootPids, args.parentByPid))

    return {
      title: title || `localhost:${entry.port}`,
      address,
      port: entry.port,
      status: response.status,
      ownerPath: args.ownerPath,
      processName: args.processName,
      sameProject,
    }
  } catch {
    return null
  } finally {
    controller.abort()
    clearTimeout(timeout)
  }
}

export async function listLocalHttpServers(options: {
  fetchImpl?: typeof fetch
  projectPath?: string
  projectTerminalRootPids?: number[]
} = {}) {
  const fetchImpl = options.fetchImpl
  const entries = await listListeningTcpEntries()
  const projectTerminalRootPids = new Set(options.projectTerminalRootPids ?? [])
  const cacheKey = `${options.projectPath ?? ""}\u0000${[...projectTerminalRootPids].sort((a, b) => a - b).join(",")}`
  const signature = getListeningEntryListSignature(entries)
  const cached = localHttpServerCache.get(cacheKey)
  if (cached && cached.signature === signature && Date.now() - cached.scannedAt < LOCAL_HTTP_CACHE_TTL_MS) {
    return cached.results
  }

  const parentByPid = await readParentProcessMap()
  const ownerCwds = new Map<number, string | undefined>()
  const ownerCwdReads = new Map<number, Promise<string | undefined>>()

  await Promise.all(entries.flatMap((entry) => entry.owners.map(async (owner) => {
    if (!ownerCwdReads.has(owner.pid)) ownerCwdReads.set(owner.pid, readProcessCwd(owner.pid))
    ownerCwds.set(owner.pid, await ownerCwdReads.get(owner.pid))
  })))

  const results = await Promise.all(entries.map((entry) => {
    const primaryOwner = entry.owners[0]
    const ownerPath = entry.owners.map((owner) => ownerCwds.get(owner.pid)).find(Boolean)
    return readHttpServer(entry, {
      fetchImpl,
      ownerPath,
      processName: primaryOwner?.command,
      projectPath: options.projectPath,
      projectTerminalRootPids,
      parentByPid,
    })
  }))

  const filteredResults = filterLocalHttpServers(results
    .filter((result): result is LocalHttpServerInfo => result !== null)
  ).sort((a, b) => Number(b.sameProject) - Number(a.sameProject) || a.port - b.port)
  localHttpServerCache.set(cacheKey, {
    signature,
    scannedAt: Date.now(),
    results: filteredResults,
  })

  return filteredResults
}
