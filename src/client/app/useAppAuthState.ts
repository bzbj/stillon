import { useCallback, useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import type { ConnectHost } from "../../shared/connect"
import { isConnectBrowser } from "../lib/remoteSession"

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
  | { status: "ready"; cacheScope: string | null }
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

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current
    if (retryTimeoutRef.current !== null) {
      window.clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }

    setState((current) => current.status === "ready" ? current : { status: "checking" })

    let response: Response
    try {
      response = await fetch("/auth/status", {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      })
    } catch {
      if (generation !== requestGeneration.current) return
      if (isConnectBrowser()) setState({ status: "checking" })
      retryTimeoutRef.current = window.setTimeout(() => {
        void refresh()
      }, AUTH_STATUS_RETRY_DELAY_MS)
      return
    }

    if (generation !== requestGeneration.current) return
    if (shouldRetryAuthStatusRequest(response.ok)) {
      if (isConnectBrowser()) setState({ status: "checking" })
      retryTimeoutRef.current = window.setTimeout(() => {
        void refresh()
      }, AUTH_STATUS_RETRY_DELAY_MS)
      return
    }

    const payload = await response.json() as Partial<AuthStatusResponse>
    if (generation !== requestGeneration.current) return
    setState(getAppAuthStateFromStatus(payload))
  }, [])

  useEffect(() => {
    void refresh()
    const hidePrivatePage = () => {
      if (isConnectBrowser()) { requestGeneration.current++; flushSync(() => setState({ status: "checking" })) }
    }
    const recheck = () => { hidePrivatePage(); void refresh() }
    if (isConnectBrowser()) {
      window.addEventListener("stillon:check-session", recheck)
      window.addEventListener("focus", recheck)
      window.addEventListener("pageshow", recheck)
      window.addEventListener("pagehide", hidePrivatePage)
    }
    const timer = isConnectBrowser() ? window.setInterval(() => { void refresh() }, 15_000) : null
    return () => {
      requestGeneration.current++
      if (timer !== null) window.clearInterval(timer)
      window.removeEventListener("stillon:check-session", recheck)
      window.removeEventListener("focus", recheck)
      window.removeEventListener("pageshow", recheck)
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
