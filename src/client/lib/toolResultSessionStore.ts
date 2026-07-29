import type { ToolResultBodyResult } from "../../shared/protocol"
import type { ToolResultEntry } from "../../shared/types"

export const DEFAULT_TOOL_RESULT_CACHE_BYTES = 16 * 1024 * 1024
export const DEFAULT_TOOL_RESULT_CACHE_ENTRIES = 128

export interface ToolResultLoadRequest {
  chatId: string
  resultId: string
  revision: string
  byteLength: number
}

export type ToolResultLoadState =
  | { status: "preview" }
  | { status: "loading" }
  | { status: "ready"; entry: ToolResultEntry }
  | { status: "error"; message: string }
  | { status: "missing" }
  | { status: "stale"; currentRevision: string }

export type ToolResultLoader = (
  request: ToolResultLoadRequest,
) => Promise<ToolResultBodyResult>

interface StoredRecord {
  state: ToolResultLoadState
  volatile: boolean
}

const PREVIEW_STATE: ToolResultLoadState = { status: "preview" }

export function getToolResultCacheKey(request: ToolResultLoadRequest) {
  return JSON.stringify([
    request.chatId,
    request.revision,
    request.resultId,
  ])
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export class ToolResultSessionStore {
  private readonly loader: ToolResultLoader
  private readonly maxBytes: number
  private readonly maxEntries: number
  private readonly records = new Map<string, StoredRecord>()
  private readonly recordOrder = new Map<string, true>()
  private readonly readyLru = new Map<string, number>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly retainCounts = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<ToolResultLoadState>>()
  private cachedBytes = 0
  private disposed = false

  constructor(
    loader: ToolResultLoader,
    options: {
      maxBytes?: number
      maxEntries?: number
    } = {},
  ) {
    this.loader = loader
    this.maxBytes = Math.max(0, Math.floor(
      options.maxBytes ?? DEFAULT_TOOL_RESULT_CACHE_BYTES,
    ))
    this.maxEntries = Math.max(1, Math.floor(
      options.maxEntries ?? DEFAULT_TOOL_RESULT_CACHE_ENTRIES,
    ))
  }

  getSnapshot(request: ToolResultLoadRequest): ToolResultLoadState {
    return this.records.get(getToolResultCacheKey(request))?.state ?? PREVIEW_STATE
  }

  subscribe(request: ToolResultLoadRequest, listener: () => void) {
    if (this.disposed) return () => undefined
    const key = getToolResultCacheKey(request)
    const listeners = this.listeners.get(key) ?? new Set()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.listeners.delete(key)
      }
    }
  }

  retain(request: ToolResultLoadRequest) {
    if (this.disposed) return () => undefined
    const key = getToolResultCacheKey(request)
    this.retainCounts.set(key, (this.retainCounts.get(key) ?? 0) + 1)
    this.touch(key)

    let released = false
    return () => {
      if (released) return
      released = true
      const nextCount = Math.max(0, (this.retainCounts.get(key) ?? 1) - 1)
      if (nextCount === 0) {
        this.retainCounts.delete(key)
      } else {
        this.retainCounts.set(key, nextCount)
      }

      const record = this.records.get(key)
      if (nextCount === 0 && record?.volatile) {
        this.deleteRecord(key)
        this.notify(key)
      }
      this.evictReadyRecords()
      this.pruneRecords()
    }
  }

  load(
    request: ToolResultLoadRequest,
    options: { force?: boolean } = {},
  ): Promise<ToolResultLoadState> {
    if (this.disposed) {
      return Promise.resolve({
        status: "error",
        message: "Tool result cache is disposed.",
      })
    }

    const key = getToolResultCacheKey(request)
    const current = this.records.get(key)
    if (
      !options.force
      && current
      && current.state.status !== "loading"
    ) {
      this.touch(key)
      return Promise.resolve(current.state)
    }

    const pending = this.inFlight.get(key)
    if (pending) return pending

    const promise = this.performLoad(key, request)
    this.inFlight.set(key, promise)
    void promise.finally(() => {
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key)
      }
    })
    return promise
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    const listeners = [...this.listeners.values()].flatMap((entries) => [...entries])
    this.records.clear()
    this.recordOrder.clear()
    this.readyLru.clear()
    this.retainCounts.clear()
    this.cachedBytes = 0
    for (const listener of listeners) {
      listener()
    }
    this.listeners.clear()
  }

  private async performLoad(
    key: string,
    request: ToolResultLoadRequest,
  ): Promise<ToolResultLoadState> {
    this.setRecord(key, request, { status: "loading" })

    try {
      const response = await this.loader(request)
      if (this.disposed) {
        return {
          status: "error",
          message: "Tool result cache is disposed.",
        }
      }

      let state: ToolResultLoadState
      switch (response.status) {
        case "ok":
          if (
            response.chatId !== request.chatId
            || response.resultId !== request.resultId
            || response.revision !== request.revision
            || response.entry._id !== request.resultId
            || response.entry.kind !== "tool_result"
            || response.entry.deferredContent !== undefined
          ) {
            throw new Error("Tool result response did not match the request.")
          }
          state = {
            status: "ready",
            entry: response.entry,
          }
          break
        case "missing":
          if (
            response.chatId !== request.chatId
            || response.resultId !== request.resultId
            || response.revision !== request.revision
          ) {
            throw new Error("Tool result response did not match the request.")
          }
          state = { status: "missing" }
          break
        case "stale":
          if (
            response.chatId !== request.chatId
            || response.resultId !== request.resultId
            || response.requestedRevision !== request.revision
            || !response.currentRevision
          ) {
            throw new Error("Tool result response did not match the request.")
          }
          state = {
            status: "stale",
            currentRevision: response.currentRevision,
          }
          break
      }

      this.setRecord(key, request, state)
      return state
    } catch (error) {
      const state: ToolResultLoadState = {
        status: "error",
        message: errorMessage(error),
      }
      if (!this.disposed) {
        this.setRecord(key, request, state)
      }
      return state
    }
  }

  private setRecord(
    key: string,
    request: ToolResultLoadRequest,
    state: ToolResultLoadState,
  ) {
    this.deleteRecord(key)
    const volatile = state.status === "ready" && request.byteLength > this.maxBytes
    this.records.set(key, { state, volatile })
    this.touch(key)

    if (state.status === "ready" && !volatile) {
      this.readyLru.set(key, request.byteLength)
      this.cachedBytes += request.byteLength
    }

    this.evictReadyRecords()
    this.pruneRecords()
    this.notify(key)

    if (volatile && (this.retainCounts.get(key) ?? 0) === 0) {
      this.deleteRecord(key)
      this.notify(key)
    }
  }

  private touch(key: string) {
    if (this.recordOrder.delete(key)) {
      this.recordOrder.set(key, true)
    } else if (this.records.has(key)) {
      this.recordOrder.set(key, true)
    }

    const readyBytes = this.readyLru.get(key)
    if (readyBytes !== undefined) {
      this.readyLru.delete(key)
      this.readyLru.set(key, readyBytes)
    }
  }

  private deleteRecord(key: string) {
    const readyBytes = this.readyLru.get(key)
    if (readyBytes !== undefined) {
      this.cachedBytes = Math.max(0, this.cachedBytes - readyBytes)
      this.readyLru.delete(key)
    }
    this.records.delete(key)
    this.recordOrder.delete(key)
  }

  private evictReadyRecords() {
    while (this.cachedBytes > this.maxBytes) {
      const candidate = [...this.readyLru.keys()].find((key) => (
        (this.retainCounts.get(key) ?? 0) === 0
      ))
      if (!candidate) return
      this.deleteRecord(candidate)
      this.notify(candidate)
    }
  }

  private pruneRecords() {
    if (this.records.size <= this.maxEntries) return
    for (const key of [...this.recordOrder.keys()]) {
      if (this.records.size <= this.maxEntries) return
      if ((this.retainCounts.get(key) ?? 0) > 0) continue
      const state = this.records.get(key)?.state
      if (!state || state.status === "loading") continue
      this.deleteRecord(key)
      this.notify(key)
    }
  }

  private notify(key: string) {
    for (const listener of this.listeners.get(key) ?? []) {
      listener()
    }
  }
}
