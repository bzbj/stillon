import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { ArrowLeft, ArrowRight, Check, LoaderCircle, LogOut, Monitor } from "lucide-react"
import { OTPInput, REGEXP_ONLY_DIGITS, type SlotProps } from "input-otp"
import { Button } from "../../client/components/ui/button"
import { Input } from "../../client/components/ui/input"
import { cn } from "../../client/lib/utils"
import { CONNECT_OTP_SECONDS, CONNECT_RESEND_SECONDS, type ConnectError, type ConnectSession } from "../shared"
import type { ConnectHost, ConnectIntent } from "../../shared/connect"

class LoginError extends Error {
  constructor(public code: string, public retryAfterSeconds = 0) { super(code) }
}

async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/connect/${route}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const result = await response.json()
  if (!response.ok) {
    const error = result as ConnectError
    throw new LoginError(error.error, error.retryAfterSeconds)
  }
  return result as T
}

function errorText(error: unknown) {
  if (!(error instanceof LoginError)) return "Unable to connect. Please try again shortly."
  switch (error.code) {
    case "INVALID_EMAIL": return "Enter a valid email address."
    case "INVALID_CODE": return "The code is incorrect or expired. Check your latest email."
    case "LOGIN_EXPIRED": return "This verification has expired. Request a new code."
    case "MAIL_UNAVAILABLE": return "Unable to send a code. Please try again shortly."
    case "RATE_LIMITED": return `Too many attempts. Try again in ${error.retryAfterSeconds || 60} seconds.`
    case "BINDING_EXPIRED": return "The link request has expired. Start again in StillOn on your computer."
    case "ACTION_NOT_COMPLETED": return "Your email was verified, but the computer could not be linked or unlinked. Return to where you started and try again."
    default: return "Unable to sign in. Please try again shortly."
  }
}

function CodeSlot({ char, isActive, hasFakeCaret }: SlotProps) {
  return (
    <div aria-hidden="true" className={cn(
      "relative flex h-14 w-10 items-center justify-center rounded-xl border bg-white text-2xl font-medium sm:w-12",
      isActive ? "border-slate-600 ring-2 ring-slate-200" : "border-slate-200",
    )}>
      {char}
      {hasFakeCaret && <span className="connect-caret absolute h-6 w-px bg-slate-800" />}
    </div>
  )
}

export function ConnectApp() {
  const [route] = useState(() => new URL(window.location.href))
  const [intent] = useState<ConnectIntent | undefined>(() => {
    const id = route.searchParams.get(route.pathname === "/bind" ? "enrollment" : "host")
    return id && /^[a-f0-9]{32}$/.test(id) && ["/bind", "/revoke-host"].includes(route.pathname)
      ? { purpose: route.pathname === "/bind" ? "enroll" : "revoke-host", id } : undefined
  })
  const [intentDone, setIntentDone] = useState(false)
  const [enrollment, setEnrollment] = useState<{ name: string; fingerprint: string } | null>(null)
  const [hosts, setHosts] = useState<ConnectHost[] | null>(null)
  const [session, setSession] = useState<ConnectSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [step, setStep] = useState<"email" | "code">("email")
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [retryAt, setRetryAt] = useState(0)
  const [retryEmail, setRetryEmail] = useState("")
  const [now, setNow] = useState(Date.now())
  const emailInput = useRef<HTMLInputElement>(null)
  const codeInput = useRef<HTMLInputElement>(null)
  const channel = useRef<BroadcastChannel | null>(null)
  const authorization = useRef<Promise<{ redirect: string; hostId: string; userId?: string }> | null>(null)
  const sessionRequest = useRef<Promise<ConnectSession | null> | null>(null)
  const sessionGeneration = useRef(0)
  const previousUserId = useRef<string | null>(null)
  const initialHosts = useRef<ConnectHost[] | null>(null)
  const cooldown = email.trim().toLowerCase() === retryEmail ? Math.max(0, Math.ceil((retryAt - now) / 1_000)) : 0
  const needsCode = Boolean(intent && !intentDone)

  const refreshSession = useCallback((withHosts = false): Promise<ConnectSession | null> => {
    if (sessionRequest.current) return sessionRequest.current
    const generation = sessionGeneration.current
    const request = api<{ session: ConnectSession | null; hosts?: ConnectHost[] }>(withHosts ? "bootstrap" : "session").then(result => {
      if (generation !== sessionGeneration.current) return null
      if (previousUserId.current !== (result.session?.user.id ?? null)) {
        setHosts(null); initialHosts.current = null
      }
      previousUserId.current = result.session?.user.id ?? null
      if (withHosts) initialHosts.current = result.hosts ?? []
      setSession(result.session)
      return result.session
    })
    sessionRequest.current = request
    void request.finally(() => { if (sessionRequest.current === request) sessionRequest.current = null }).catch(() => {})
    return request
  }, [])

  useEffect(() => {
    let alive = true
    const begin = async () => {
      if (route.pathname === "/authorize" && !intent) {
        try {
          authorization.current ??= api<{ redirect: string; hostId: string; userId?: string }>("authorize", { flow: route.searchParams.get("flow") })
          const result = await authorization.current
          if (!alive) return
          if (result.userId) { try { localStorage.setItem(`stillon-connect-host:${result.userId}`, result.hostId) } catch { /* optional preference */ } }
          window.location.replace(result.redirect)
          return
        } catch (error) {
          authorization.current = null
          if (!(error instanceof LoginError && error.code === "AUTH_REQUIRED")) { await refreshSession(); throw error }
        }
      }
      await refreshSession(!intent && route.pathname !== "/authorize" && route.pathname !== "/logout/complete")
    }
    void begin().catch(() => { if (alive) setError("Unable to connect. Refresh the page to try again.") }).finally(() => { if (alive) setLoading(false) })
    const refresh = () => { void refreshSession().catch(() => {}) }
    window.addEventListener("focus", refresh)
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("stillon-connect-auth")
      channel.current.onmessage = refresh
    }
    return () => { alive = false; window.removeEventListener("focus", refresh); channel.current?.close(); channel.current = null }
  }, [refreshSession])

  useEffect(() => {
    if (intent?.purpose === "enroll") void api<{ name: string; fingerprint: string }>(`enrollments/${intent.id}`).then(setEnrollment).catch(handleError)
  }, [intent])

  useEffect(() => {
    if (!session || intent || route.pathname === "/logout/complete") return
    let cancelled = false
    const load = async () => {
      try {
        if (route.pathname === "/authorize") {
          authorization.current ??= api<{ redirect: string; hostId: string }>("authorize", { flow: route.searchParams.get("flow") })
          const result = await authorization.current
          if (!cancelled) {
            try { localStorage.setItem(`stillon-connect-host:${session.user.id}`, result.hostId) } catch { /* optional preference */ }
            window.location.replace(result.redirect)
          }
          return
        }
        const bootstrapHosts = initialHosts.current
        initialHosts.current = null
        const result = bootstrapHosts ? { hosts: bootstrapHosts } : await api<{ hosts: ConnectHost[] }>("hosts")
        if (cancelled) return
        setHosts(result.hosts)
        if (route.pathname !== "/computers" && result.hosts.length) {
          let previous: string | null = null
          try { previous = localStorage.getItem(`stillon-connect-host:${session.user.id}`) } catch { /* optional preference */ }
          const target = result.hosts.find(h => h.id === previous) ?? result.hosts[0]!
          // Selection is stable even if that computer is offline.
          window.location.replace(`${target.url}/_connect/login`)
        }
      } catch (caught) { if (!cancelled) handleError(caught) }
    }
    void load()
    const timer = window.setInterval(() => { if (route.pathname === "/computers") void load() }, 15_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [session?.user.id, intent, route])

  useEffect(() => {
    if (retryAt <= Date.now()) return
    setNow(Date.now())
    const timer = window.setInterval(() => {
      const time = Date.now()
      setNow(time)
      if (time >= retryAt) window.clearInterval(timer)
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [retryAt])

  useEffect(() => {
    if (!loading && (!session || needsCode) && !busy) (step === "email" ? emailInput : codeInput).current?.focus()
  }, [loading, session, needsCode, step, busy])

  useEffect(() => { document.title = session ? "StillOn · My computers" : "StillOn · Sign in" }, [session])

  function handleError(caught: unknown) {
    setError(errorText(caught))
    if (caught instanceof LoginError && caught.retryAfterSeconds) {
      setRetryEmail(email.trim().toLowerCase())
      setNow(Date.now())
      setRetryAt(Date.now() + caught.retryAfterSeconds * 1_000)
    }
  }

  async function sendCode(event?: FormEvent) {
    event?.preventDefault()
    if (busy || cooldown > 0) return
    setBusy(true); setError("")
    try {
      const result = await api<{ email: string; resendAfterSeconds: number }>("request-code", { email: email.trim(), ...(intent ? { intent } : {}) })
      setEmail(result.email)
      setRetryEmail(result.email)
      setCode("")
      setNow(Date.now())
      setRetryAt(Date.now() + (result.resendAfterSeconds || CONNECT_RESEND_SECONDS) * 1_000)
      setStep("code")
      codeInput.current?.focus()
    } catch (caught) { handleError(caught) }
    finally { setBusy(false) }
  }

  async function signIn(event: FormEvent) {
    event.preventDefault()
    if (busy || code.length !== 6) return
    setBusy(true); setError("")
    try {
      await api("verify-code", { email, code, remember, ...(intent ? { intent } : {}) })
      sessionGeneration.current++; sessionRequest.current = null; initialHosts.current = null
      const authenticated = await refreshSession(!intent && route.pathname !== "/authorize")
      if (!authenticated) throw new Error("Missing account session")
      setCode("")
      if (intent) setIntentDone(true)
      channel.current?.postMessage("signed-in")
    } catch (caught) { handleError(caught); codeInput.current?.focus() }
    finally { setBusy(false) }
  }

  async function signOut() {
    if (busy) return
    setBusy(true); setError("")
    try {
      await api("logout", {})
      sessionGeneration.current++; sessionRequest.current = null; initialHosts.current = null; previousUserId.current = null
      setSession(null); setCode(""); setStep("email"); setRetryAt(0)
      setHosts(null)
      channel.current?.postMessage("signed-out")
    } catch (caught) { handleError(caught) }
    finally { setBusy(false) }
  }

  return (
    <div className="connect-shell flex flex-col px-5 py-7 sm:px-10 sm:py-9">
      <header className="flex items-center gap-3">
        <img src="/stillon-mark.svg" alt="" width="34" height="34" />
        <span className="text-lg font-semibold tracking-tight">StillOn</span>
        <span className="ml-1 border-l border-slate-200 pl-4 text-xs tracking-widest text-slate-500">CONNECT</span>
      </header>
      <main className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-12 sm:py-20">
        {loading ? (
          <div role="status" className="flex items-center justify-center gap-3 text-sm text-slate-500"><LoaderCircle className="size-5 animate-spin" />{route.pathname === "/authorize" ? "Opening computer workspace…" : "Checking account session…"}</div>
        ) : route.pathname === "/logout/complete" ? (
          <><Check className="mb-6 size-8 text-emerald-600" /><h1 className="text-3xl font-semibold">Logged out</h1><p className="mt-4 text-sm leading-6 text-slate-500">Computer connections in this browser have ended. Tasks on your computers keep running.</p><a className="mt-8 underline" href="/login">Sign in again</a></>
        ) : intentDone ? (
          <><Check className="mb-6 size-8 text-emerald-600" /><h1 className="text-3xl font-semibold">{intent?.purpose === "enroll" ? "Email linked" : "Computer unlinked"}</h1><p className="mt-4 text-sm leading-6 text-slate-500">{intent?.purpose === "enroll" ? "Return to StillOn on your computer to check the connection. Sign in at this address to use it remotely." : "Remote access is closed. Files and tasks on the computer are preserved."}</p><a className="mt-8 underline" href="/computers">View my computers</a></>
        ) : session && !needsCode ? (
          <>
            <div className="mb-8 flex items-center gap-2 text-sm text-emerald-700"><Check className="size-4" />Signed in</div>
            <h1 className="text-3xl font-semibold tracking-tight">Your computer, wherever you are.</h1>
            <p className="mt-3 break-all text-sm text-slate-500">{session.user.email}</p>
            {hosts?.length ? <div className="my-8 space-y-3">{hosts.map(host => <div key={host.id} className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex items-center gap-3"><Monitor className="size-5 text-slate-400" /><span className="min-w-0 flex-1 truncate font-medium">{host.name}</span><span className={`text-xs ${host.online ? "text-emerald-700" : "text-slate-400"}`}>{host.paused ? "Paused" : host.online ? "Online" : "Offline"}</span></div>
              <div className="mt-4 flex items-center gap-5 text-sm"><a href={`${host.url}/_connect/login`} className="font-medium text-slate-800" onClick={() => { try { localStorage.setItem(`stillon-connect-host:${session.user.id}`, host.id) } catch { /* optional */ } }}>Open computer →</a><a href={`/revoke-host?host=${host.id}`} className="text-slate-400">Unlink</a></div>
            </div>)}</div> : <div className="my-9 rounded-2xl border border-slate-200 bg-white p-7">
              <Monitor className="mb-5 size-7 text-slate-400" />
              <h2 className="font-medium">{hosts ? "No computers linked yet" : "Connecting to your computer…"}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">On your computer, open StillOn → Settings → Remote access and link this email.</p>
            </div>}
            <Button variant="ghost" onClick={() => void signOut()} disabled={busy} className="self-start px-0 hover:bg-transparent"><LogOut className="mr-2 size-4" />Logout</Button>
          </>
        ) : step === "email" ? (
          <>
            <p className="mb-4 text-sm text-slate-500">Your computer stays. Your work continues.</p>
            <h1 className="text-[32px] font-semibold tracking-tight">{intent ? intent.purpose === "enroll" ? "Link this computer" : "Unlink this computer" : "Welcome back to StillOn"}</h1>
            <p className="mt-3 text-sm leading-6 text-slate-500">{intent?.purpose === "enroll" ? `${enrollment?.name ?? "Loading computer details…"} · Verifying your email gives this account remote access to this computer. Continue only if you started this request.` : intent?.purpose === "revoke-host" ? "Verify the linked email again. Unlinking closes all remote connections to this computer." : "Sign in with your email to pick up where you left off."}</p>
            {enrollment && <p className="mt-3 text-xs text-slate-400">Computer fingerprint: {enrollment.fingerprint}</p>}
            <form className="mt-9 space-y-5" onSubmit={sendCode}>
              <div>
                <label htmlFor="connect-email" className="mb-2 block text-sm font-medium">Email address</label>
                <Input ref={emailInput} id="connect-email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} placeholder="you@example.com" required maxLength={254} value={email} onChange={(event) => { setEmail(event.target.value); setError("") }} disabled={busy} aria-describedby={error ? "login-error" : undefined} className="h-12 rounded-xl border-slate-200 bg-white px-4" />
              </div>
              <Button type="submit" disabled={busy || cooldown > 0 || !email.trim() || (intent?.purpose === "enroll" && !enrollment)} className="h-12 w-full rounded-xl bg-slate-900 text-white hover:bg-slate-800">
                {busy ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
                {cooldown > 0 ? `Resend in ${cooldown}s` : "Send verification code"}
                {!busy && cooldown === 0 && <ArrowRight className="ml-2 size-4" />}
              </Button>
            </form>
            <p className="mt-5 text-xs leading-6 text-slate-400">An account is created when you first verify your email.</p>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => { setStep("email"); setCode(""); setError("") }} className="mb-7 self-start px-0 hover:bg-transparent"><ArrowLeft className="mr-2 size-4" />Change email</Button>
            <h1 className="text-3xl font-semibold tracking-tight">Check your email</h1>
            <p className="mt-3 break-words text-sm leading-6 text-slate-500">We sent a code to <span className="font-medium text-slate-800">{email}</span>. It expires in {CONNECT_OTP_SECONDS / 60} minutes.</p>
            <form onSubmit={signIn} className="mt-8 space-y-6">
              <div>
                <label htmlFor="connect-code" className="mb-3 block text-sm font-medium">6-digit code</label>
                <OTPInput id="connect-code" ref={codeInput} maxLength={6} pattern={REGEXP_ONLY_DIGITS} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(value) => { setCode(value); setError("") }} disabled={busy} aria-describedby={error ? "login-error" : undefined} aria-invalid={Boolean(error)} pasteTransformer={(value) => value.replace(/[\s-]/g, "")} containerClassName="flex gap-2 justify-between has-[:disabled]:opacity-60" render={({ slots }) => <>{slots.map((slot, index) => <CodeSlot key={index} {...slot} />)}</>} />
              </div>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-500"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="size-4 accent-slate-900" disabled={busy} />Stay signed in on this device for 30 days</label>
              <Button type="submit" disabled={busy || code.length !== 6} className="h-12 w-full rounded-xl bg-slate-900 text-white hover:bg-slate-800">{busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}{intent ? intent.purpose === "enroll" ? "Verify and link computer" : "Verify and unlink computer" : "Sign in to StillOn"}<ArrowRight className="ml-2 size-4" /></Button>
            </form>
            <div className="mt-6 flex items-center justify-between text-xs text-slate-500">
              <span>No code? Check your spam folder.</span>
              <Button variant="link" size="none" disabled={busy || cooldown > 0} onClick={() => void sendCode()} className="h-8 text-xs text-slate-600">{cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}</Button>
            </div>
          </>
        )}
        {error && <p id="login-error" role="alert" className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">{error}</p>}
      </main>
      <footer className="text-center text-xs tracking-wide text-slate-400">Leave your computer. Agent Still On.</footer>
    </div>
  )
}
