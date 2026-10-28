import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { rootCertificates } from "node:tls"
import path from "node:path"
import { createHash } from "node:crypto"
import { SharingCache } from "../../shared/sharing-cache"
import { ProofQueue } from "./proof-queue"
import { CONNECT_HEARTBEAT_MS, CONNECT_PROTOCOL, type SharedWorkspaceEntry, type WorkspaceSharingSnapshot, type ConnectBrowserSessions, type ConnectLocalStatus, type DeviceProof } from "../../shared/connect"
import { newDeviceKeys, randomId, signProof, validateDeviceKeys } from "./crypto"
import { startRemoteAdapter } from "./adapter"
import { migrateConnectState, parseConnectRuntimeConfig, type ConnectRuntimeConfig } from "./config"
import pkg from "../../../package.json"
import { connectRequest } from "./http-client"
import { createConnectRouting, networkFailure, transportEnvironment, transportFailure } from "./routing"
import { prepareTransport, readRuntimeTransport, resolveTransport, type TransportLocation, type TransportStatus } from "./transport"
import { FRP_VERSION, TransportError, type TransportComponent } from "./transport-component"

type DeviceKeys = ReturnType<typeof newDeviceKeys>
interface DeviceState {
  version: 1; origin: string; name: string; keys: DeviceKeys
  enrollment?: { id: string; verificationUrl: string; expiresAt: number }
  binding?: { hostId: string; name: string; email: string; epoch: number; gatewayPublicKey: string; url: string }
  paused: boolean; pendingUnbind: boolean; pendingPause?: boolean
}
export class ConnectorError extends Error {
  constructor(public code: string, public status = 503) { super(code) }
}
export interface ConnectorOptions {
  dataDir: string
  targetOrigin: string
  localSecret: string
  origin?: string
  name: () => string
  workspaces?: () => { id: string; title: string }[]
  frpcPath?: string
  runtimeRoot?: string
  /** Explicit CA fixture for integration tests/private installations, never insecure TLS. */
  trustedCaFile?: string
  /** Isolated profiles/tests may select a cache root; never accepted over HTTP. */
  transportLocation?: TransportLocation
  /** Connect-only environment snapshot; not accepted over HTTP. */
  environment?: NodeJS.ProcessEnv
  /** Deterministic lifecycle clock for isolated integration tests. */
  now?: () => number
}
function validOrigin(value: string) {
  const url = new URL(value)
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new ConnectorError("INVALID_SERVICE_ORIGIN", 400)
  return url.origin
}
async function secureFile(file: string) {
  await chmod(file, 0o600)
  if (process.platform === "win32") {
    const { userInfo } = await import("node:os")
    const child = Bun.spawn(["icacls", file, "/inheritance:r", "/grant:r", `${userInfo().username}:(F)`], { stdout: "ignore", stderr: "ignore" })
    if (await child.exited !== 0) throw new ConnectorError("CREDENTIAL_PERMISSIONS_FAILED")
  }
}
export async function createConnector(options: ConnectorOptions) {
  const now = options.now ?? Date.now
  const directory = path.join(options.dataDir, "connect")
  const statePath = path.join(directory, "device.json")
  const configPath = path.join(directory, "frpc.json")
  const runtimeRoot = options.runtimeRoot ?? path.resolve(import.meta.dir, "../../..")
  let component: TransportComponent | null = null
  let componentStatus: TransportStatus | undefined
  if (!options.frpcPath) {
    try { component = await readRuntimeTransport(runtimeRoot) }
    catch { componentStatus = { state: "error", version: FRP_VERSION, error: "CONNECTOR_COMPONENT_INVALID" } }
  }
  const servicePath = path.join(directory, "service.json")
  let savedService: Record<string, unknown> | undefined
  try {
    const value = JSON.parse(await readFile(servicePath, "utf8"))
    if (value && typeof value === "object" && !Array.isArray(value)) savedService = value
  } catch { /* No readable saved service: use explicit/package configuration. */ }
  let packageConfig: ConnectRuntimeConfig | null = null
  let error: string | undefined
  try { packageConfig = parseConnectRuntimeConfig(JSON.parse(await readFile(path.join(runtimeRoot, "runtime/connect.json"), "utf8"))) }
  catch (caught) { if (!(caught instanceof Error && "code" in caught && caught.code === "ENOENT")) error = "INVALID_SERVICE_ORIGIN" }
  const configuredOrigin = options.origin ?? savedService?.origin ?? packageConfig?.origin
  let state: DeviceState | null = null
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as DeviceState
    if (state.version !== 1) throw new Error("Unknown state")
    validOrigin(state.origin); validateDeviceKeys(state.keys)
    await secureFile(statePath)
  } catch (caught) {
    if (!(caught instanceof Error && "code" in caught && caught.code === "ENOENT")) error = "DEVICE_STATE_INVALID"
    state = null
  }
  let origin: string | null = null
  try { origin = state?.origin ?? (typeof configuredOrigin === "string" ? validOrigin(configuredOrigin) : null) } catch { error = "INVALID_SERVICE_ORIGIN" }
  let status: ConnectLocalStatus["state"] = state?.pendingUnbind ? "revocation-pending" : state?.paused ? "paused" : state?.binding ? "connecting" : state?.enrollment ? "pending" : "unbound"
  let adapter: ReturnType<typeof startRemoteAdapter> | null = null
  let frpc: ReturnType<typeof Bun.spawn> | null = null
  let generation = 0, revision = 0, nextBeat = 0, ticking = false, changing = false, stopped = false
  let tunnelFailure: ReturnType<typeof transportFailure> = null
  let transportRevision = 0, transportStartedAt = 0
  let lastCloudResponseAt: number | null = null
  const instanceId = randomId()
  const abort = new AbortController()
  async function saveJson(file: string, value: unknown) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomId()}.tmp`
    try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await secureFile(temporary); await rename(temporary, file) }
    finally { await rm(temporary, { force: true }) }
  }
  async function save() {
    if (!state) { await rm(statePath, { force: true }); return }
    await saveJson(statePath, state)
  }
  // Only the package publisher's exact allowlist can move an existing authority.
  // Save the service first so an interrupted two-file migration retries safely.
  if (origin && packageConfig?.migrateFromOrigins?.includes(origin)
    && (!options.origin || options.origin === origin || options.origin === packageConfig.origin)) {
    const nextOrigin = packageConfig.origin
    await saveJson(servicePath, { ...savedService, origin: nextOrigin })
    if (state) { state = migrateConnectState(state, nextOrigin); await save() }
    origin = nextOrigin
  } else if (packageConfig && state?.origin === packageConfig.origin && typeof savedService?.origin === "string"
    && packageConfig.migrateFromOrigins?.includes(savedService.origin)) {
    // Also finish a migration interrupted after device.json was already saved.
    await saveJson(servicePath, { ...savedService, origin: packageConfig.origin })
  }
  const environment = { ...(options.environment ?? process.env) }
  const trustedCa = options.trustedCaFile ? await readFile(options.trustedCaFile, "utf8") : undefined
  const routing = origin ? createConnectRouting(origin, environment, now) : null
  async function routeFailure(stage: "api" | "tunnel", code: string, version: number) {
    if (routing && routing.version !== version) return false
    const changed = routing?.fail(stage, code, version)
    if (changed || stage === "tunnel") await stopTransport()
    return changed
  }
  async function post<T>(route: string, body: unknown): Promise<T> {
    if (!origin) throw new ConnectorError("SERVICE_NOT_CONFIGURED")
    let response: Response
    const request = () => connectRequest(new URL(`${origin}${route}`), { method: "POST", body: JSON.stringify(body),
      proxy: routing?.proxy ?? "", ca: trustedCa, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]) })
    const version = routing?.version ?? 0
    try { response = await request() }
    catch (caught) {
      if (abort.signal.aborted) throw caught
      const code = networkFailure(caught)
      if (!code) throw caught
      const changed = await routeFailure("api", code, version)
      // Only challenge allocation is replayable. A signed mutation may already
      // have been applied when its response was lost; let its caller reconcile.
      if (changed && route === "/api/connect/device/challenge") {
        try { response = await request() }
        catch (retryError) {
          const failure = networkFailure(retryError)
          if (failure) await routeFailure("api", failure, routing!.version)
          throw new ConnectorError(failure ? `CONNECT_API_${failure}` : "SERVICE_UNAVAILABLE")
        }
      } else throw new ConnectorError(`CONNECT_API_${code}`)
    }
    const result = await response.json() as { error?: string }
    if (!response.ok) throw new ConnectorError(result.error ?? "SERVICE_UNAVAILABLE", response.status)
    lastCloudResponseAt = now()
    return result as T
  }
  const proofQueue = new ProofQueue()
  function prove<T>(action: DeviceProof["action"], payload: Record<string, unknown>, provisional = false, priority = 1): Promise<T> {
    // Local settings requests and heartbeats share the same route and challenge
    // sequence, including while a failed route tears down its transport.
    return proofQueue.run(async () => {
      if (!state) throw new ConnectorError("NOT_BOUND", 409)
      const subject = provisional ? `key:${state.keys.publicKey}` : state.binding?.hostId
      if (!subject) throw new ConnectorError("NOT_BOUND", 409)
      const keys = state.keys
      const { challenge } = await post<{ challenge: string }>("/api/connect/device/challenge", { subject, action })
      return post<T>("/api/connect/device/request", signProof({ subject, challenge, action, payload }, keys.privateKey))
    }, action === "heartbeat" ? 0 : priority)
  }
  const sharingCache = new SharingCache<WorkspaceSharingSnapshot>(force => prove("workspace-sharing", {
    operation: "list", ...(options.workspaces ? { workspaces: options.workspaces() } : {}),
  }, false, force ? 1 : 2), now)
  let transportStopping = Promise.resolve()
  function stopTransport() {
    transportRevision++
    const child = frpc; frpc = null
    const oldAdapter = adapter; adapter = null
    const operation = transportStopping.then(async () => {
      if (child && child.exitCode === null) {
        child.kill()
        await Promise.race([child.exited, Bun.sleep(1_000)])
        if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited }
      }
      await oldAdapter?.stop()
      await rm(configPath, { force: true })
    })
    transportStopping = operation.catch(() => {})
    return operation
  }
  async function executable() {
    if (component) {
      try {
        const file = await resolveTransport(component, options.transportLocation)
        componentStatus = { state: "ready", version: component.version }
        return file
      } catch (error) {
        const code = error instanceof TransportError ? error.code : "CONNECTOR_BLOCKED"
        componentStatus = { state: "error", version: component.version, error: code }
        throw new ConnectorError(code)
      }
    }
    if (componentStatus?.error) throw new ConnectorError(componentStatus.error)
    const file = options.frpcPath ?? path.join(runtimeRoot, "runtime/frp", process.platform === "win32" ? "frpc.exe" : "frpc")
    if (!await Bun.file(file).exists()) throw new ConnectorError("CONNECTOR_NOT_INSTALLED")
    if (!options.frpcPath) {
      try {
        const manifest = JSON.parse(await readFile(path.join(path.dirname(file), "manifest.json"), "utf8"))
        const expected = manifest.files?.[path.basename(file)]
        if (manifest.version !== FRP_VERSION || !/^[a-f0-9]{64}$/.test(expected ?? "")
          || createHash("sha256").update(await readFile(file)).digest("hex") !== expected) throw new Error("Invalid binary")
      } catch { throw new ConnectorError("CONNECTOR_INTEGRITY_FAILED") }
    }
    return file
  }
  async function startTransport(expectedRevision: number) {
    await transportStopping
    const binary = await executable()
    const result = await prove<{ token: string; generation: number; epoch: number; gatewayPublicKey: string; hostOrigin: string;
      tunnel: { hostname: string; port: number; protocol: "wss" | "websocket" }; protocol: number }>("connect", { instanceId, protocol: CONNECT_PROTOCOL, workspaceSharing: 1 })
    if (expectedRevision !== revision || stopped || !state?.binding || state.paused || state.pendingUnbind) return
    if (result.protocol !== CONNECT_PROTOCOL) throw new ConnectorError("UPGRADE_REQUIRED")
    await transportStopping
    const routeVersion = routing!.version
    routing!.setTunnel(new URL(`${result.tunnel.protocol === "wss" ? "https" : "http"}://${result.tunnel.hostname}:${result.tunnel.port}`))
    if (routeVersion !== routing!.version) throw new ConnectorError("CONNECT_ROUTE_CHANGED")
    const activeTransportRevision = transportRevision
    const service = new URL(origin!)
    if (result.tunnel.protocol !== "wss" && service.protocol !== "http:") throw new ConnectorError("INVALID_TUNNEL_CONFIGURATION")
    generation = result.generation
    state.binding.epoch = result.epoch; state.binding.gatewayPublicKey = result.gatewayPublicKey; state.binding.url = result.hostOrigin
    await save()
    adapter = startRemoteAdapter({ targetOrigin: options.targetOrigin, localSecret: options.localSecret,
      publicKey: result.gatewayPublicKey, hostId: state.binding.hostId, epoch: result.epoch, generation })
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const caFile = options.trustedCaFile ?? path.join(directory, "trusted-roots.pem")
    // frp deliberately disables server verification without a CA file. Always
    // supply the runtime's public root bundle; never accept that default.
    if (!options.trustedCaFile) await writeFile(caFile, rootCertificates.join("\n"), { mode: 0o600 })
    const config = { serverAddr: result.tunnel.hostname, serverPort: result.tunnel.port, user: state.binding.hostId,
      metadatas: { connect_token: result.token }, loginFailExit: false,
      transport: { proxyURL: routing!.proxy, protocol: result.tunnel.protocol, tls: { enable: result.tunnel.protocol === "wss", trustedCaFile: caFile, serverName: result.tunnel.hostname }, heartbeatInterval: 15, heartbeatTimeout: 45 },
      log: { to: "console", level: "warn" }, proxies: [{ name: "tunnel", type: "http", localIP: "127.0.0.1", localPort: adapter.port,
        customDomains: [new URL(result.hostOrigin).hostname] }] }
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); await secureFile(configPath)
    if (expectedRevision !== revision || stopped || state.paused || state.pendingUnbind || activeTransportRevision !== transportRevision || routeVersion !== routing!.version) { await stopTransport(); return }
    let child: ReturnType<typeof Bun.spawn>
    const startedAt = now()
    try { child = Bun.spawn([binary, "-c", configPath], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: transportEnvironment(environment) }) }
    catch {
      if (component) componentStatus = { state: "error", version: component.version, error: "CONNECTOR_BLOCKED" }
      throw new ConnectorError("CONNECTOR_BLOCKED")
    }
    tunnelFailure = null
    async function drain(stream: ReadableStream<Uint8Array>) {
      const decoder = new TextDecoder()
      let tail = ""
      try {
        for await (const bytes of stream) {
          // Bound partial-line storage; credentials/paths never reach diagnostics.
          tail = (tail + decoder.decode(bytes, { stream: true })).slice(-4096)
          if (frpc === child) {
            const failure = transportFailure(tail)
            if (failure && tunnelFailure !== "TLS_FAILED") tunnelFailure = failure
          }
          const lastLine = tail.lastIndexOf("\n")
          if (lastLine >= 0) tail = tail.slice(lastLine + 1)
        }
      } catch { /* Process shutdown closes both pipes. */ }
    }
    frpc = child
    void drain(child.stdout as ReadableStream<Uint8Array>); void drain(child.stderr as ReadableStream<Uint8Array>)
    transportStartedAt = now(); status = "connecting"; nextBeat = now() + 2_000
    void child.exited.then(async code => { if (frpc === child) {
      frpc = null; status = "offline"; error = "TUNNEL_DISCONNECTED"
      if (code === 0 || now() - startedAt >= 2_000 || !component) await routeFailure("tunnel", tunnelFailure ?? "TUNNEL_DISCONNECTED", routeVersion)
      // A denied executable or immediate startup failure must not produce an
      // endless relaunch/prompt loop. An explicit local repair retries it.
      if (component && code !== 0 && now() - startedAt < 2_000) {
        error = "CONNECTOR_BLOCKED"; componentStatus = { state: "error", version: component.version, error: "CONNECTOR_BLOCKED" }
      }
      nextBeat = now() + (routing?.retryDelay ?? 5_000)
    } }).catch(() => {})
  }
  async function tick() {
    if (ticking || changing || stopped || !state || !origin || now() < nextBeat) return
    ticking = true
    const currentRevision = revision
    try {
      if (state.pendingUnbind) {
        await revoke()
        if (currentRevision !== revision || stopped) return
        state = null; status = "unbound"; error = undefined; await save(); return
      }
      if (state.enrollment && !state.binding) {
        if (now() >= state.enrollment.expiresAt) { state = null; status = "unbound"; error = "BINDING_EXPIRED"; await save(); return }
        const claimed = await prove<{ state: "pending" } | ({ state: "bound" } & NonNullable<DeviceState["binding"]>)>("claim", { enrollmentId: state.enrollment.id }, true)
        if (currentRevision !== revision || stopped) return
        if (claimed.state === "bound") { state.binding = claimed; delete state.enrollment; await save() }
        else return
      }
      if (state.pendingPause && state.binding) {
        await prove("pause", {}); state.pendingPause = false; error = undefined; await save()
      }
      if (state.paused || !state.binding) return
      if (componentStatus && componentStatus.state !== "ready") return
      // Probe only when no relayed request/stream is active. Route changes never
      // migrate a live stream; a successful probe starts a new tunnel generation.
      if (routing?.probeDue() && !adapter?.activeLeases().length) {
        const version = routing.version
        let healthy = false
        try {
          const response = await connectRequest(new URL(`${origin}/health`), { proxy: "", ca: trustedCa,
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]) })
          healthy = response.ok && (await response.json()).ok === true
        } catch { /* Keep the healthy proxy route until a later idle probe. */ }
        if (currentRevision !== revision || stopped) return
        if (version === routing.version && !adapter?.activeLeases().length) {
          routing.probeResult(healthy)
          if (healthy) { status = "connecting"; await stopTransport() }
        }
      }
      if (!frpc) { await stopTransport(); await startTransport(currentRevision); return }
      if (now() < nextBeat) return
      const heartbeatTransportRevision = transportRevision
      const requested = adapter?.activeLeases() ?? []
      const displayName = options.name().trim().slice(0, 80) || "My computer"
      const result = await prove<{ state: "online" | "connecting"; leases: { id: string; token: string }[] }>("heartbeat", {
        instanceId, generation, leases: requested, name: displayName, ...(options.workspaces ? { workspaces: options.workspaces() } : {}),
      })
      if (currentRevision !== revision || stopped) return
      if (heartbeatTransportRevision !== transportRevision) return
      if (result.state === "connecting" && now() - transportStartedAt >= 30_000) {
        const failure = tunnelFailure ?? "TUNNEL_TIMEOUT"
        await routeFailure("tunnel", failure, routing!.version)
        throw new ConnectorError(failure === "TUNNEL_TIMEOUT" ? "CONNECT_TUNNEL_TIMEOUT" : `CONNECT_TUNNEL_${failure}`)
      }
      if (result.state === "online") { routing?.online(); tunnelFailure = null }
      if (state.name !== displayName) { state.name = displayName; state.binding.name = displayName; await save() }
      adapter?.renew(result.leases, requested); status = result.state; error = undefined; nextBeat = now() + CONNECT_HEARTBEAT_MS
    } catch (caught) {
      if (currentRevision !== revision || stopped) return
      error = caught instanceof ConnectorError ? caught.code : "SERVICE_UNAVAILABLE"
      if (error === "NOT_FOUND" && state?.binding) { status = "revoked"; state.paused = true; await save(); await stopTransport() }
      else if (error === "ACCESS_PAUSED") { status = "paused"; if (state) { state.paused = true; await save() }; await stopTransport() }
      else { if (state?.binding) status = state.pendingUnbind ? "revocation-pending" : state.paused ? "paused" : "offline"; nextBeat = now() + (routing?.retryDelay ?? 5_000)
        if (["CONNECTION_EXPIRED", "DEVICE_ALREADY_CONNECTED"].includes(error)) await stopTransport() }
    } finally { ticking = false }
  }
  async function prepareComponent(repair = false) {
    if (!component) throw new ConnectorError(componentStatus?.error ?? "CONNECTOR_NOT_INSTALLED")
    componentStatus = { state: "preparing", version: component.version }
    try {
      await prepareTransport(component, { ...options.transportLocation, repair, legacyRuntime: runtimeRoot })
      componentStatus = { state: "ready", version: component.version }
      if (error?.startsWith("CONNECTOR_")) error = undefined
      nextBeat = 0
    } catch (caught) {
      const code = caught instanceof TransportError ? caught.code : "CONNECTOR_BLOCKED"
      componentStatus = { state: "error", version: component.version, error: code }
      throw new ConnectorError(code)
    }
  }
  // Compatibility with older independent updater controllers: make one durable
  // preparation attempt at startup. Never block local HTTP readiness or download
  // from tick(). A prior failed/quarantined attempt requires an explicit retry.
  if (component && process.env.STILLON_UPDATE_PROBE !== "1") void prepareComponent().catch(() => {})
  const timer = setInterval(() => { void tick() }, 2_000); timer.unref()
  void tick()
  async function change<T>(operation: () => Promise<T>): Promise<T> {
    if (changing || ticking) throw new ConnectorError("BUSY", 409)
    changing = true; revision++; nextBeat = 0; sharingCache.invalidate()
    try { return await operation() } finally { changing = false }
  }
  async function revoke() {
    try {
      if (state?.binding) await prove("unbind", {})
      else if (state?.enrollment) await prove("cancel-enrollment", { enrollmentId: state.enrollment.id }, true)
    } catch (caught) { if (!(caught instanceof ConnectorError && caught.code === "NOT_FOUND")) throw caught }
  }
  return {
    async workspaceSharing(payload: Record<string, unknown>, force = false) {
      if (!state?.binding || state.pendingUnbind) throw new ConnectorError("NOT_BOUND", 409)
      if (payload.operation === "list") return sharingCache.read(force)
      sharingCache.invalidate()
      try {
        const result = await prove<Partial<WorkspaceSharingSnapshot> & { invitationUrl?: string; delivery?: string }>("workspace-sharing", { ...payload, ...(options.workspaces ? { workspaces: options.workspaces() } : {}) })
        // Invalidate again: an earlier read may have completed during the mutation.
        sharingCache.invalidate()
        if (result.workspaces) sharingCache.set({ workspaces: result.workspaces })
        const snapshot = result.workspaces ? { workspaces: result.workspaces } : await sharingCache.read(true)
        return { ...result, ...snapshot }
      } catch (error) { sharingCache.invalidate(); throw error }
    },
    async sharedWorkspaces() {
      if (!state?.binding || state.pendingUnbind) throw new ConnectorError("NOT_BOUND", 409)
      return prove<{ sharedWorkspaces: SharedWorkspaceEntry[] }>("list-shared-workspaces", {})
    },
    async browserSessions() {
      if (!state?.binding || state.pendingUnbind) throw new ConnectorError("NOT_BOUND", 409)
      return prove<ConnectBrowserSessions>("list-sessions", {})
    },
    async revokeBrowserSession(sessionId: string) {
      if (!state?.binding || state.pendingUnbind) throw new ConnectorError("NOT_BOUND", 409)
      return prove<{ success: true }>("revoke-session", { sessionId })
    },
    diagnostics() {
      // An explicit allowlist prevents new state fields, keys, URLs and private
      // server error text from silently appearing in a copied support report.
      const safeErrors = new Set(["CONNECT_ROUTE_CHANGED", "CONNECT_TUNNEL_TIMEOUT", "CONNECT_TUNNEL_TLS_FAILED", "CONNECT_TUNNEL_DNS_FAILED", "CONNECT_TUNNEL_CONNECTION_FAILED", "CONNECT_API_DNS_FAILED", "CONNECT_API_CONNECTION_FAILED", "CONNECT_API_TIMEOUT", "CONNECT_API_TLS_FAILED", "SERVICE_UNAVAILABLE", "SERVICE_NOT_CONFIGURED", "INVALID_SERVICE_ORIGIN", "DEVICE_STATE_INVALID", "CREDENTIAL_PERMISSIONS_FAILED", "CONNECTOR_NOT_INSTALLED", "CONNECTOR_BLOCKED", "CONNECTOR_INTEGRITY_FAILED", "CONNECTOR_DOWNLOAD_FAILED", "CONNECTOR_REPAIR_REQUIRED", "CONNECTOR_COMPONENT_INVALID", "CONNECTOR_PREPARING", "TUNNEL_DISCONNECTED", "CONNECTION_EXPIRED", "DEVICE_ALREADY_CONNECTED", "BINDING_EXPIRED", "ACCESS_PAUSED", "CLOUD_UPDATE_PENDING", "NOT_FOUND", "RATE_LIMITED", "INVALID_PROOF"])
      return { schema: 1, reportId: randomId(), generatedAt: new Date().toISOString(), scope: "local-connector", version: pkg.version,
        protocol: CONNECT_PROTOCOL, platform: process.platform, architecture: process.arch, state: status, configured: Boolean(origin),
        bound: Boolean(state?.binding), transportRunning: Boolean(frpc), activeStreams: adapter?.activeLeases().length ?? 0,
        lastCloudResponseAt, tunnelFailure, routing: routing?.diagnostics(), transport: componentStatus, error: error ? safeErrors.has(error) ? error : "UNCLASSIFIED_ERROR" : null }
    },
    status(): ConnectLocalStatus { return { configured: Boolean(origin), origin, state: status, name: state?.name ?? options.name(),
      ...(state?.binding ? { email: state.binding.email.replace(/^(.).+(@.*)$/, "$1•••$2"), hostId: state.binding.hostId, url: state.binding.url } : {}),
      ...(state?.enrollment ? { enrollment: state.enrollment } : {}), ...(error ? { error } : {}), ...(componentStatus ? { transport: { ...componentStatus } } : {}) } },
    repairTransport: () => change(async () => {
      if (componentStatus?.state !== "ready") await stopTransport()
      await prepareComponent(true)
    }),
    enroll: () => change(async () => {
      if (!origin) throw new ConnectorError("SERVICE_NOT_CONFIGURED")
      if (error === "DEVICE_STATE_INVALID") throw new ConnectorError(error)
      if (state?.pendingUnbind) throw new ConnectorError("CLOUD_UPDATE_PENDING", 409)
      if (state?.binding) throw new ConnectorError("ALREADY_BOUND", 409)
      if (state?.enrollment && state.enrollment.expiresAt > now()) return state.enrollment
      if (componentStatus?.state === "preparing") throw new ConnectorError("CONNECTOR_PREPARING", 409)
      if (componentStatus?.error) throw new ConnectorError(componentStatus.error)
      await executable()
      state = { version: 1, origin, name: options.name().slice(0, 80) || "My computer", keys: newDeviceKeys(), paused: false, pendingUnbind: false }
      await save()
      state.enrollment = await prove<NonNullable<DeviceState["enrollment"]>>("enroll", { name: state.name, protocol: CONNECT_PROTOCOL }, true)
      status = "pending"; error = undefined; await save(); return state.enrollment
    }),
    pause: () => change(async () => {
      if (!state?.binding) throw new ConnectorError("NOT_BOUND", 409)
      state.paused = true; state.pendingPause = true; await save(); await stopTransport(); status = "paused"
      try { await prove("pause", {}); state.pendingPause = false; await save(); error = undefined } catch { error = "CLOUD_UPDATE_PENDING" }
    }),
    resume: () => change(async () => {
      if (!state?.binding || state.pendingUnbind) throw new ConnectorError("NOT_BOUND", 409)
      await prove("resume", {}); state.paused = false; state.pendingPause = false; status = "connecting"; error = undefined; await save()
    }),
    unbind: () => change(async () => {
      if (!state) return
      state.paused = true; state.pendingUnbind = true; await save(); await stopTransport(); status = "revocation-pending"
      try { await revoke(); state = null; status = "unbound"; error = undefined; await save() }
      catch (caught) {
        if (caught instanceof ConnectorError && caught.code === "NOT_FOUND") { state = null; status = "unbound"; error = undefined; await save() }
        else error = "CLOUD_UPDATE_PENDING"
      }
    }),
    async stop() { stopped = true; revision++; abort.abort(); clearInterval(timer); await stopTransport() },
  }
}
