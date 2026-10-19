import { useCallback, useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import type { ConnectHost } from "../../shared/connect"
import { isConnectBrowser } from "../lib/remoteSession"
import type { SidebarViewSnapshot } from "../../shared/sidebar-view"
import { markStartupPhase } from "../lib/startupMetrics"
import { setResourceSessionScope } from "../lib/resourceRequests"
import { getStartupController } from "../lib/startup"

const AUTH_STATUS_RETRY_DELAY_MS = 500

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

export function getAppAuthStateFromStatus(payload: Partial<AuthStatusResponse>): AppAuthState {
  if (payload.mode === "connect" && (!payload.authenticated || !payload.host?.online)) return {
    status: "connect-unavailable", loginUrl: payload.loginUrl ?? "/_connect/login", portalUrl: payload.portalUrl ?? "/", host: payload.host,
  }
  if (!payload.enabled || payload.authenticated) {
    const cacheScope = typeof payload.cacheScope === "string"
      ? payload.cacheScope.trim() || null
      : null
    return { status: "ready", cacheScope }
  }

  return { status: "locked", error: null }
}

export function shouldRetryAuthStatusRequest(responseOk: boolean | null) {
  return responseOk !== true
}

export function useAppAuthState() {
  const [state, setState] = useState<AppAuthState>({ status: "checking" })
  const retryTimeoutRef = useRef<number | null>(null)
  const requestGeneration = useRef(0)
  const inFlightRef = useRef<Promise<void> | null>(null)

  const refresh = useCallback((): Promise<void> => {
    // focus/pageshow may arrive together. One check is enough until a genuine
    // invalidation fences it off; routine focus must not paint a modal shield.
    if (inFlightRef.current) return inFlightRef.current
    const generation = ++requestGeneration.current
    if (retryTimeoutRef.current !== null) {
      window.clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }

    const request = (async () => {
      setState((current) => current.status === "ready" ? current : { status: "checking" })
      try {
        markStartupPhase("auth-start")
        const response = await fetch("/auth/status", {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
        })
        if (generation !== requestGeneration.current) return
        if (shouldRetryAuthStatusRequest(response.ok)) throw new Error("Session status unavailable")
        const payload = await response.json() as Partial<AuthStatusResponse>
        if (generation !== requestGeneration.current) return
        const next = getAppAuthStateFromStatus(payload)
        if (next.status === "ready") {
          // The authenticated socket delivers authoritative view preferences.
          // Only the sidebar waits for them; project/chat subscriptions start now.
          markStartupPhase("authenticated")
          setResourceSessionScope(next.cacheScope ?? window.location.origin)
          setState({ ...next, checkId: generation })
        } else {
          setResourceSessionScope(null)
          setState(next)
        }
      } catch {
        if (generation !== requestGeneration.current) return
        // Preserve fail-closed handling for a check that cannot be completed.
        if (isConnectBrowser()) { setResourceSessionScope(null); setState({ status: "checking" }) }
        retryTimeoutRef.current = window.setTimeout(() => {
          void refresh()
        }, AUTH_STATUS_RETRY_DELAY_MS)
      }
    })()
    inFlightRef.current = request
    void request.finally(() => {
      if (inFlightRef.current === request) inFlightRef.current = null
    })
    return request
  }, [])

  useEffect(() => {
    void refresh()
    const hidePrivatePage = () => {
      if (isConnectBrowser()) {
        getStartupController()?.hold()
        setResourceSessionScope(null)
        requestGeneration.current++
        inFlightRef.current = null
        flushSync(() => setState({ status: "checking" }))
      }
    }
    const recheck = () => { hidePrivatePage(); void refresh() }
    if (isConnectBrowser()) {
      window.addEventListener("stillon:check-session", recheck)
      window.addEventListener("focus", refresh)
      window.addEventListener("pageshow", refresh)
      window.addEventListener("pagehide", hidePrivatePage)
    }
    const timer = isConnectBrowser() ? window.setInterval(() => { void refresh() }, 15_000) : null
    return () => {
      requestGeneration.current++
      inFlightRef.current = null
      if (timer !== null) window.clearInterval(timer)
      window.removeEventListener("stillon:check-session", recheck)
      window.removeEventListener("focus", refresh)
      window.removeEventListener("pageshow", refresh)
      window.removeEventListener("pagehide", hidePrivatePage)
      if (retryTimeoutRef.current !== null) {
        window.clearTimeout(retryTimeoutRef.current)
      }
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
      setState({ status: "locked", error: "Incorrect password. Try again." })
      return
    }

    await refresh()
  }, [refresh])

  return {
    state,
    submitPassword,
  }
}
