import { SERVICE_WORKER_ACTIVATE_MESSAGE } from "../../shared/service-worker-protocol"

export type ServiceWorkerUpdateStatus =
  | "idle"
  | "waiting"
  | "activating"
  | "error"

export interface ServiceWorkerUpdateSnapshot {
  status: ServiceWorkerUpdateStatus
}

type SnapshotListener = (snapshot: ServiceWorkerUpdateSnapshot) => void

interface ServiceWorkerContainerLike {
  readonly controller: ServiceWorker | null
  getRegistrations(): Promise<readonly ServiceWorkerRegistration[]>
  register(scriptURL: string | URL, options?: RegistrationOptions): Promise<ServiceWorkerRegistration>
  addEventListener(type: "controllerchange", listener: EventListener): void
  removeEventListener(type: "controllerchange", listener: EventListener): void
}

interface EventTargetLike {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

export interface ServiceWorkerUpdateManagerDependencies {
  container: ServiceWorkerContainerLike
  documentTarget: EventTargetLike & { readonly visibilityState: DocumentVisibilityState }
  onlineTarget: EventTargetLike
  reload: () => void
  now?: () => number
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

const UPDATE_CHECK_THROTTLE_MS = 30_000
const ACTIVATION_TIMEOUT_MS = 12_000
const PREVIEW_SERVICE_WORKER_SCOPE_PREFIX = "/api/browser-proxy/"

function isPreviewServiceWorkerRegistration(candidate: ServiceWorkerRegistration) {
  try {
    if (new URL(candidate.scope).pathname.startsWith(PREVIEW_SERVICE_WORKER_SCOPE_PREFIX)) {
      return true
    }
  } catch {
    // Keep checking the worker scripts when a stale registration has a bad scope.
  }

  return [candidate.installing, candidate.waiting, candidate.active].some((worker) => {
    if (!worker) return false
    try {
      return new URL(worker.scriptURL).pathname.startsWith(PREVIEW_SERVICE_WORKER_SCOPE_PREFIX)
    } catch {
      return false
    }
  })
}

export class ServiceWorkerUpdateManager {
  private snapshot: ServiceWorkerUpdateSnapshot = { status: "idle" }
  private readonly listeners = new Set<SnapshotListener>()
  private readonly now: () => number
  private readonly scheduleTimeout: typeof globalThis.setTimeout
  private readonly cancelTimeout: typeof globalThis.clearTimeout
  private registration: ServiceWorkerRegistration | null = null
  private waitingWorker: ServiceWorker | null = null
  private registrationCleanup: (() => void) | null = null
  private activationTimeout: ReturnType<typeof globalThis.setTimeout> | null = null
  private lastUpdateCheckAt = Number.NEGATIVE_INFINITY
  private controllerKnown: boolean
  private activationRequested = false
  private reloadCommitted = false
  private started = false
  private disposed = false

  constructor(private readonly dependencies: ServiceWorkerUpdateManagerDependencies) {
    this.now = dependencies.now ?? Date.now
    this.scheduleTimeout = dependencies.setTimeout ?? globalThis.setTimeout
    this.cancelTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout
    this.controllerKnown = dependencies.container.controller !== null
  }

  subscribe(listener: SnapshotListener) {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setStatus(status: ServiceWorkerUpdateStatus) {
    if (this.snapshot.status === status) return
    this.snapshot = { status }
    for (const listener of this.listeners) listener(this.snapshot)
  }

  private readonly handleControllerChange: EventListener = () => {
    const previouslyControlled = this.controllerKnown
    this.controllerKnown = this.dependencies.container.controller !== null

    if (this.activationRequested) {
      this.commitReload()
      return
    }

    if (previouslyControlled && this.controllerKnown) {
      // Activation is origin-wide. Reload every old controlled tab so it
      // cannot mix the previous JavaScript graph with the new worker/cache.
      this.commitReload()
    }
  }

  private readonly handleVisibilityChange: EventListener = () => {
    if (this.dependencies.documentTarget.visibilityState === "visible") {
      void this.checkForUpdate()
    }
  }

  private readonly handleOnline: EventListener = () => {
    void this.checkForUpdate()
  }

  private watchRegistration(registration: ServiceWorkerRegistration) {
    const cleanups = new Set<() => void>()

    const watchInstallingWorker = (worker: ServiceWorker | null) => {
      if (!worker) return
      const handleStateChange: EventListener = () => {
        if (worker.state !== "installed") return
        if (this.dependencies.container.controller) {
          this.waitingWorker = registration.waiting ?? worker
          this.setStatus("waiting")
        }
      }
      worker.addEventListener("statechange", handleStateChange)
      cleanups.add(() => worker.removeEventListener("statechange", handleStateChange))
    }

    const handleUpdateFound: EventListener = () => {
      watchInstallingWorker(registration.installing)
    }
    registration.addEventListener("updatefound", handleUpdateFound)
    cleanups.add(() => registration.removeEventListener("updatefound", handleUpdateFound))
    watchInstallingWorker(registration.installing)

    this.registrationCleanup = () => {
      for (const cleanup of cleanups) cleanup()
      cleanups.clear()
    }
  }

  async start() {
    if (this.started || this.disposed) return
    this.started = true

    this.dependencies.container.addEventListener("controllerchange", this.handleControllerChange)
    this.dependencies.documentTarget.addEventListener("visibilitychange", this.handleVisibilityChange)
    this.dependencies.onlineTarget.addEventListener("online", this.handleOnline)

    try {
      const registrations = await this.dependencies.container.getRegistrations()
      await Promise.allSettled(registrations.map(async (candidate) => {
        try {
          if (isPreviewServiceWorkerRegistration(candidate)) {
            await candidate.unregister()
          }
        } catch {
          // A malformed or failed unrelated registration must not block StillOn.
        }
      }))
    } catch {
      // Registration enumeration is cleanup only; continue with the trusted URL.
    }

    let registration: ServiceWorkerRegistration
    try {
      registration = await this.dependencies.container.register("/service-worker.js", {
        scope: "/",
        updateViaCache: "none",
      })
    } catch {
      return
    }
    if (this.disposed) return

    this.registration = registration
    this.watchRegistration(registration)
    if (registration.waiting && this.dependencies.container.controller) {
      this.waitingWorker = registration.waiting
      this.setStatus("waiting")
    }
  }

  async checkForUpdate(force = false) {
    const registration = this.registration
    if (!registration || this.disposed) return

    const checkedAt = this.now()
    if (!force && checkedAt - this.lastUpdateCheckAt < UPDATE_CHECK_THROTTLE_MS) return
    this.lastUpdateCheckAt = checkedAt

    try {
      await registration.update()
      if (registration.waiting && this.dependencies.container.controller) {
        this.waitingWorker = registration.waiting
        this.setStatus("waiting")
      }
    } catch {
      // Update discovery is opportunistic and must never block the online app.
    }
  }

  activateUpdate() {
    if (this.reloadCommitted || this.disposed) return

    if (this.snapshot.status === "error") {
      this.commitReload()
      return
    }

    const worker = this.registration?.waiting ?? this.waitingWorker
    if (!worker) {
      this.setStatus("error")
      return
    }

    this.waitingWorker = worker
    this.activationRequested = true
    this.setStatus("activating")
    if (this.activationTimeout !== null) this.cancelTimeout(this.activationTimeout)
    this.activationTimeout = this.scheduleTimeout(() => {
      this.activationTimeout = null
      if (this.reloadCommitted) return
      this.activationRequested = false
      if (this.registration?.waiting) {
        this.waitingWorker = this.registration.waiting
        this.setStatus("waiting")
      } else {
        this.waitingWorker = null
        this.setStatus("error")
      }
    }, ACTIVATION_TIMEOUT_MS)

    try {
      worker.postMessage({ type: SERVICE_WORKER_ACTIVATE_MESSAGE })
    } catch {
      this.activationRequested = false
      if (this.activationTimeout !== null) {
        this.cancelTimeout(this.activationTimeout)
        this.activationTimeout = null
      }
      this.waitingWorker = null
      this.setStatus("error")
    }
  }

  private commitReload() {
    if (this.reloadCommitted) return
    this.reloadCommitted = true
    if (this.activationTimeout !== null) {
      this.cancelTimeout(this.activationTimeout)
      this.activationTimeout = null
    }
    this.dependencies.reload()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.registrationCleanup?.()
    this.registrationCleanup = null
    if (this.activationTimeout !== null) {
      this.cancelTimeout(this.activationTimeout)
      this.activationTimeout = null
    }
    this.dependencies.container.removeEventListener("controllerchange", this.handleControllerChange)
    this.dependencies.documentTarget.removeEventListener("visibilitychange", this.handleVisibilityChange)
    this.dependencies.onlineTarget.removeEventListener("online", this.handleOnline)
    this.listeners.clear()
  }
}

export function createBrowserServiceWorkerUpdateManager() {
  if (
    typeof window === "undefined"
    || window.isSecureContext !== true
    || !("serviceWorker" in navigator)
  ) {
    return null
  }

  return new ServiceWorkerUpdateManager({
    container: navigator.serviceWorker,
    documentTarget: document,
    onlineTarget: window,
    reload: () => window.location.reload(),
  })
}
