import { useCallback, useEffect, useRef, useState } from "react"
import type { ConnectHost } from "../../shared/connect"
import { isConnectBrowser } from "../lib/remoteSession"
import type { SidebarViewSnapshot } from "../../shared/sidebar-view"
import { markStartupPhase } from "../lib/startupMetrics"
import { setResourceSessionScope } from "../lib/resourceRequests"

interface AuthStatusResponse {
  enabled: boolean
  authenticated: boolean
  cacheScope?: string | null
  mode?: "connect"
  loginUrl?: string
  portalUrl?: string
  host?: ConnectHost
}

type AppAuthState =
  | { status: "checking" }
  | { status: "ready"; cacheScope: string | null; sidebarView?: SidebarViewSnapshot; checkId?: number }
  | { status: "locked"; error: string | null }
  | { status: "connect-unavailable"; loginUrl: string; portalUrl: string; host?: ConnectHost }

function authCacheScope(payload: Partial<AuthStatusResponse>) {
  return typeof payload.cacheScope === "string" ? payload.cacheScope.trim() || null : null
}

export function getAppAuthStateFromStatus(payload: Partial<AuthStatusResponse>): AppAuthState {
  if (payload.mode === "connect" && (!payload.authenticated || !payload.host?.online)) return {
    status: "connect-unavailable", loginUrl: payload.loginUrl ?? "/_connect/login", portalUrl: payload.portalUrl ?? "/", host: payload.host,
  }
  if (!payload.enabled || payload.authenticated) {
    return { status: "ready", cacheScope: authCacheScope(payload) }
  }

  return { status: "locked", error: null }
}

export function useAppAuthState() {
  const [state, setState] = useState<AppAuthState>({ status: "checking" })
  const currentState = useRef(state)
  const requestGeneration = useRef(0)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const updateState = useCallback((next: AppAuthState) => {
    currentState.current = next
    setState(next)
  }, [])

  const refresh = useCallback((): Promise<void> => {
    // Focus/pageshow may arrive together. Background checks never hide an
    // already authenticated workspace or restart its readiness lifecycle.
    if (inFlightRef.current) return inFlightRef.current
    const generation = ++requestGeneration.current
    const request = (async () => {
      try {
        markStartupPhase("auth-start")
        const response = await fetch("/auth/status", {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
        })
        if (generation !== requestGeneration.current) return
        if (!response.ok) return
        const payload = await response.json() as Partial<AuthStatusResponse>
        if (generation !== requestGeneration.current) return
        if (!payload || typeof payload.enabled !== "boolean" || typeof payload.authenticated !== "boolean") return
        const next = getAppAuthStateFromStatus(payload)
        const current = currentState.current
        // An authenticated computer going offline is a connection change,
        // not a reason to discard the visible workspace and its draft.
        if (next.status === "connect-unavailable" && payload.authenticated
          && current.status === "ready" && current.cacheScope === authCacheScope(payload)) return
        if (next.status === "ready") {
          if (current.status === "ready" && current.cacheScope === next.cacheScope) return
          // The authenticated socket delivers authoritative view preferences.
          // Only the sidebar waits for them; project/chat subscriptions start now.
          markStartupPhase("authenticated")
          setResourceSessionScope(next.cacheScope ?? window.location.origin)
          updateState({ ...next, checkId: generation })
        } else {
          setResourceSessionScope(null)
          updateState(next)
        }
      } catch {
        // An occasional unavailable check changes nothing. The next normal
        // poll/focus/online event can check again; no immediate retry loop.
      }
    })()
    inFlightRef.current = request
    void request.finally(() => {
      if (inFlightRef.current === request) inFlightRef.current = null
    })
    return request
  }, [updateState])

  useEffect(() => {
    void refresh()
    const invalidatePendingCheck = () => {
      requestGeneration.current++
      inFlightRef.current = null
    }
    const recheck = () => { invalidatePendingCheck(); void refresh() }
    window.addEventListener("stillon:check-session", recheck)
    window.addEventListener("focus", refresh)
    window.addEventListener("pageshow", refresh)
    window.addEventListener("online", refresh)
    window.addEventListener("pagehide", invalidatePendingCheck)
    // Local startup can recover too, without polling a healthy local session.
    const timer = window.setInterval(() => {
      if (isConnectBrowser() || currentState.current.status === "checking") void refresh()
    }, 15_000)
    return () => {
      requestGeneration.current++
      inFlightRef.current = null
      window.clearInterval(timer)
      window.removeEventListener("stillon:check-session", recheck)
      window.removeEventListener("focus", refresh)
      window.removeEventListener("pageshow", refresh)
      window.removeEventListener("online", refresh)
      window.removeEventListener("pagehide", invalidatePendingCheck)
    }
  }, [refresh])

  const submitPassword = useCallback(async (password: string) => {
    const response = await fetch("/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ password, next: window.location.pathname + window.location.search }),
    })

    if (!response.ok) {
      updateState({ status: "locked", error: "Incorrect password. Try again." })
      return
    }

    await refresh()
  }, [refresh, updateState])

  return {
    state,
    submitPassword,
  }
}
