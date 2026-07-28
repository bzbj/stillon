import { describe, expect, test } from "bun:test"
import { SERVICE_WORKER_ACTIVATE_MESSAGE } from "../../shared/service-worker-protocol"
import {
  ServiceWorkerUpdateManager,
  type ServiceWorkerUpdateSnapshot,
} from "./service-worker-registration"

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<EventListener>>()

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type))
    }
  }
}

class FakeWorker extends FakeEventTarget {
  state: ServiceWorkerState = "installing"
  scriptURL = "https://stillon.test/service-worker.js"
  readonly messages: unknown[] = []

  postMessage(message: unknown) {
    this.messages.push(message)
  }

  install() {
    this.state = "installed"
    this.dispatch("statechange")
  }
}

class FakeRegistration extends FakeEventTarget {
  installing: ServiceWorker | null = null
  waiting: ServiceWorker | null = null
  active: ServiceWorker | null = null
  updateCount = 0
  unregisterCount = 0
  scope = "https://stillon.test/"

  async update() {
    this.updateCount += 1
    return this as unknown as ServiceWorkerRegistration
  }

  async unregister() {
    this.unregisterCount += 1
    return true
  }
}

class FakeContainer extends FakeEventTarget {
  controller: ServiceWorker | null
  readonly registration = new FakeRegistration()
  registerCalls: Array<{ url: string; options?: RegistrationOptions }> = []
  extraRegistrations: FakeRegistration[] = []
  hasRegistration: boolean

  constructor(controlled: boolean) {
    super()
    this.controller = controlled ? new FakeWorker() as unknown as ServiceWorker : null
    this.hasRegistration = controlled
  }

  async getRegistrations() {
    return [
      ...(this.hasRegistration ? [this.registration] : []),
      ...this.extraRegistrations,
    ] as unknown as ServiceWorkerRegistration[]
  }

  async register(url: string | URL, options?: RegistrationOptions) {
    this.registerCalls.push({ url: String(url), options })
    this.hasRegistration = true
    return this.registration as unknown as ServiceWorkerRegistration
  }

  changeController() {
    this.controller = new FakeWorker() as unknown as ServiceWorker
    this.dispatch("controllerchange")
  }
}

function createManager(controlled = true) {
  const container = new FakeContainer(controlled)
  const documentTarget = Object.assign(new FakeEventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  })
  const onlineTarget = new FakeEventTarget()
  const snapshots: ServiceWorkerUpdateSnapshot[] = []
  let reloadCount = 0
  const manager = new ServiceWorkerUpdateManager({
    container: container as never,
    documentTarget,
    onlineTarget,
    reload: () => {
      reloadCount += 1
    },
  })
  manager.subscribe((snapshot) => snapshots.push(snapshot))

  return {
    container,
    documentTarget,
    onlineTarget,
    manager,
    snapshots,
    get reloadCount() {
      return reloadCount
    },
  }
}

describe("service-worker update manager", () => {
  test("registers the stable worker with uncached update checks", async () => {
    const harness = createManager(false)
    await harness.manager.start()

    expect(harness.container.registerCalls).toEqual([{
      url: "/service-worker.js",
      options: {
        scope: "/",
        updateViaCache: "none",
      },
    }])
    expect(harness.container.registration.updateCount).toBe(0)
    harness.manager.dispose()
  })

  test("re-registers the trusted stable URL without a duplicate update call", async () => {
    const harness = createManager(true)
    await harness.manager.start()

    expect(harness.container.registerCalls).toEqual([{
      url: "/service-worker.js",
      options: {
        scope: "/",
        updateViaCache: "none",
      },
    }])
    expect(harness.container.registration.updateCount).toBe(0)
    harness.manager.dispose()
  })

  test("removes only stale browser-preview worker scopes", async () => {
    const harness = createManager(true)
    const previewRegistration = new FakeRegistration()
    previewRegistration.scope = "https://stillon.test/api/browser-proxy/5173/"
    const unrelatedRegistration = new FakeRegistration()
    unrelatedRegistration.scope = "https://stillon.test/another-app/"
    harness.container.extraRegistrations.push(previewRegistration, unrelatedRegistration)

    await harness.manager.start()

    expect(previewRegistration.unregisterCount).toBe(1)
    expect(unrelatedRegistration.unregisterCount).toBe(0)
    expect(harness.container.registration.unregisterCount).toBe(0)
    harness.manager.dispose()
  })

  test("removes a widened stale preview scope by its worker script URL", async () => {
    const harness = createManager(true)
    const previewRegistration = new FakeRegistration()
    const previewWorker = new FakeWorker()
    previewRegistration.scope = "https://stillon.test/api/"
    previewWorker.scriptURL = "https://stillon.test/api/browser-proxy/5173/sw.js"
    previewRegistration.active = previewWorker as unknown as ServiceWorker
    harness.container.extraRegistrations.push(previewRegistration)

    await harness.manager.start()

    expect(previewRegistration.unregisterCount).toBe(1)
    expect(harness.container.registration.unregisterCount).toBe(0)
    harness.manager.dispose()
  })

  test("keeps a first install silent but announces an installed update", async () => {
    const firstInstall = createManager(false)
    const firstWorker = new FakeWorker()
    firstInstall.container.registration.installing = firstWorker as unknown as ServiceWorker
    await firstInstall.manager.start()
    firstWorker.install()
    expect(firstInstall.snapshots.at(-1)).toEqual({ status: "idle" })
    firstInstall.manager.dispose()

    const update = createManager(true)
    const updateWorker = new FakeWorker()
    update.container.registration.installing = updateWorker as unknown as ServiceWorker
    await update.manager.start()
    updateWorker.install()
    expect(update.snapshots.at(-1)).toEqual({ status: "waiting" })
    update.manager.dispose()
  })

  test("surfaces an already waiting update without activating it", async () => {
    const harness = createManager()
    const worker = new FakeWorker()
    worker.state = "installed"
    harness.container.registration.waiting = worker as unknown as ServiceWorker

    await harness.manager.start()

    expect(harness.snapshots.at(-1)).toEqual({ status: "waiting" })
    expect(worker.messages).toEqual([])
    harness.manager.dispose()
  })

  test("activates only after the click and reloads at most once", async () => {
    const harness = createManager()
    const worker = new FakeWorker()
    worker.state = "installed"
    harness.container.registration.waiting = worker as unknown as ServiceWorker
    await harness.manager.start()

    harness.manager.activateUpdate()
    expect(worker.messages).toEqual([{ type: SERVICE_WORKER_ACTIVATE_MESSAGE }])
    expect(harness.snapshots.at(-1)).toEqual({ status: "activating" })

    harness.container.changeController()
    harness.container.changeController()
    expect(harness.reloadCount).toBe(1)
    harness.manager.dispose()
  })

  test("reloads once when another tab activates the origin-wide update", async () => {
    const harness = createManager()
    await harness.manager.start()

    harness.container.changeController()
    expect(harness.reloadCount).toBe(1)
    harness.container.changeController()
    expect(harness.reloadCount).toBe(1)
    harness.manager.dispose()
  })
})
