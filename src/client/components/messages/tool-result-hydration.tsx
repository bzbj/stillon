import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import type { DeferredToolResultContent } from "../../../shared/types"
import {
  type ToolResultLoadRequest,
  type ToolResultLoadState,
  ToolResultSessionStore,
} from "../../lib/toolResultSessionStore"

interface ToolResultHydrationContextValue {
  chatId: string
  store: ToolResultSessionStore
  refreshTranscript: () => void
}

const ToolResultHydrationContext =
  createContext<ToolResultHydrationContextValue | null>(null)

const UNAVAILABLE_STATE = { status: "unavailable" } as const
const NOOP_SUBSCRIBE = () => () => undefined

export function ToolResultHydrationProvider({
  chatId,
  store,
  refreshTranscript,
  children,
}: {
  chatId: string | null
  store?: ToolResultSessionStore | null
  refreshTranscript?: () => void
  children: ReactNode
}) {
  const value = useMemo<ToolResultHydrationContextValue | null>(() => (
    chatId && store
      ? {
          chatId,
          store,
          refreshTranscript: refreshTranscript ?? (() => undefined),
        }
      : null
  ), [chatId, refreshTranscript, store])

  return (
    <ToolResultHydrationContext.Provider value={value}>
      {children}
    </ToolResultHydrationContext.Provider>
  )
}

export function useToolResultHydration(
  descriptor: DeferredToolResultContent | undefined,
): {
  state: ToolResultLoadState | typeof UNAVAILABLE_STATE | null
  load: (options?: { force?: boolean }) => Promise<ToolResultLoadState> | null
  retain: () => (() => void)
  refreshTranscript: () => void
  request: ToolResultLoadRequest | null
} {
  const context = useContext(ToolResultHydrationContext)
  const request = useMemo<ToolResultLoadRequest | null>(() => (
    descriptor && context
      ? {
          chatId: context.chatId,
          resultId: descriptor.resultId,
          revision: descriptor.revision,
          byteLength: descriptor.byteLength,
        }
      : null
  ), [context, descriptor])

  const subscribe = useCallback((listener: () => void) => (
    request && context
      ? context.store.subscribe(request, listener)
      : NOOP_SUBSCRIBE()
  ), [context, request])
  const getSnapshot = useCallback(() => (
    request && context
      ? context.store.getSnapshot(request)
      : descriptor
        ? UNAVAILABLE_STATE
        : null
  ), [context, descriptor, request])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const load = useCallback((options?: { force?: boolean }) => (
    request && context
      ? context.store.load(request, options)
      : null
  ), [context, request])
  const retain = useCallback(() => (
    request && context
      ? context.store.retain(request)
      : () => undefined
  ), [context, request])

  return {
    state,
    load,
    retain,
    refreshTranscript: context?.refreshTranscript ?? (() => undefined),
    request,
  }
}
