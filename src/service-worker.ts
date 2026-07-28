import { createAppShellWorkerRuntime } from "./client/pwa/service-worker-runtime"

declare const __STILLON_APP_SHELL_BUILD_ID__: string
declare const __STILLON_APP_SHELL_DIGEST__: string
declare const __STILLON_APP_SHELL_PRECACHE_URLS__: string[]
declare const __STILLON_APP_SHELL_RUNTIME_ASSET_URLS__: string[]
declare const __STILLON_APP_SHELL_ASSET_DIGESTS__: Record<string, string>

interface WorkerEventMap {
  install: {
    waitUntil(promise: Promise<unknown>): void
  }
  activate: {
    waitUntil(promise: Promise<unknown>): void
  }
  fetch: {
    request: Request
    respondWith(response: Promise<Response>): void
  }
  message: {
    data: unknown
    waitUntil(promise: Promise<unknown>): void
  }
}

interface ServiceWorkerScope {
  location: Location
  caches: CacheStorage
  clients: {
    claim(): Promise<void>
  }
  skipWaiting(): Promise<void>
  addEventListener<Type extends keyof WorkerEventMap>(
    type: Type,
    listener: (event: WorkerEventMap[Type]) => void,
  ): void
}

const workerScope = self as unknown as ServiceWorkerScope
const runtime = createAppShellWorkerRuntime(
  {
    buildId: __STILLON_APP_SHELL_BUILD_ID__,
    shellDigest: __STILLON_APP_SHELL_DIGEST__,
    origin: workerScope.location.origin,
    precacheUrls: __STILLON_APP_SHELL_PRECACHE_URLS__,
    runtimeAssetUrls: __STILLON_APP_SHELL_RUNTIME_ASSET_URLS__,
    assetDigests: __STILLON_APP_SHELL_ASSET_DIGESTS__,
  },
  {
    caches: workerScope.caches,
    fetch: globalThis.fetch.bind(globalThis),
    claimClients: () => workerScope.clients.claim(),
    skipWaiting: () => workerScope.skipWaiting(),
  },
)

workerScope.addEventListener("install", (event) => {
  event.waitUntil(runtime.install())
})

workerScope.addEventListener("activate", (event) => {
  event.waitUntil(runtime.activate())
})

workerScope.addEventListener("fetch", (event) => {
  const response = runtime.handleFetch(event.request)
  if (response) event.respondWith(response)
})

workerScope.addEventListener("message", (event) => {
  const activation = runtime.handleMessage(event.data)
  if (activation) event.waitUntil(activation)
})
