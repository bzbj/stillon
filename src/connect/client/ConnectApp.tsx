import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { ArrowLeft, ArrowRight, Check, LoaderCircle, LogOut, Monitor } from "lucide-react"
import { OTPInput, REGEXP_ONLY_DIGITS, type SlotProps } from "input-otp"
import { Button } from "../../client/components/ui/button"
import { Input } from "../../client/components/ui/input"
import { cn } from "../../client/lib/utils"
import { CONNECT_RESEND_SECONDS, type ConnectError, type ConnectSession } from "../shared"

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
  if (!(error instanceof LoginError)) return "暂时无法连接，请稍后重试。"
  switch (error.code) {
    case "INVALID_EMAIL": return "请填写有效的邮箱地址。"
    case "INVALID_CODE": return "验证码不正确或已过期，请检查最新一封邮件。"
    case "LOGIN_EXPIRED": return "本次验证已失效，请重新获取验证码。"
    case "MAIL_UNAVAILABLE": return "验证码暂时发送失败，请稍后重试。"
    case "RATE_LIMITED": return `操作较频繁，请在 ${error.retryAfterSeconds || 60} 秒后重试。`
    default: return "暂时无法登录，请稍后重试。"
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
  const cooldown = email.trim().toLowerCase() === retryEmail ? Math.max(0, Math.ceil((retryAt - now) / 1_000)) : 0

  const refreshSession = useCallback(async () => {
    const result = await api<{ session: ConnectSession | null }>("session")
    setSession(result.session)
    return result.session
  }, [])

  useEffect(() => {
    let alive = true
    void refreshSession().catch(() => { if (alive) setError("暂时无法连接，请刷新页面重试。") }).finally(() => { if (alive) setLoading(false) })
    const refresh = () => { void refreshSession().catch(() => {}) }
    window.addEventListener("focus", refresh)
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("stillon-connect-auth")
      channel.current.onmessage = refresh
    }
    return () => { alive = false; window.removeEventListener("focus", refresh); channel.current?.close(); channel.current = null }
  }, [refreshSession])

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
    if (!loading && !session && !busy) (step === "email" ? emailInput : codeInput).current?.focus()
  }, [loading, session, step, busy])

  useEffect(() => { document.title = session ? "StillOn · 我的电脑" : "StillOn · 登录" }, [session])

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
      const result = await api<{ email: string; resendAfterSeconds: number }>("request-code", { email: email.trim() })
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
      await api("verify-code", { email, code, remember })
      const authenticated = await refreshSession()
      if (!authenticated) throw new Error("Missing account session")
      setCode("")
      channel.current?.postMessage("signed-in")
    } catch (caught) { handleError(caught); codeInput.current?.focus() }
    finally { setBusy(false) }
  }

  async function signOut() {
    if (busy) return
    setBusy(true); setError("")
    try {
      await api("logout", {})
      setSession(null); setCode(""); setStep("email"); setRetryAt(0)
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
          <div role="status" className="flex items-center justify-center gap-3 text-sm text-slate-500"><LoaderCircle className="size-5 animate-spin" />正在连接…</div>
        ) : session ? (
          <>
            <div className="mb-8 flex items-center gap-2 text-sm text-emerald-700"><Check className="size-4" />已登录</div>
            <h1 className="text-3xl font-semibold tracking-tight">你的电脑，随时回来。</h1>
            <p className="mt-3 break-all text-sm text-slate-500">{session.user.email}</p>
            <div className="my-9 rounded-2xl border border-slate-200 bg-white p-7">
              <Monitor className="mb-5 size-7 text-slate-400" />
              <h2 className="font-medium">还没有连接的电脑</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">连接电脑后，就能在这里继续处理任务、查看文件。</p>
            </div>
            <Button variant="ghost" onClick={() => void signOut()} disabled={busy} className="self-start px-0 hover:bg-transparent"><LogOut className="mr-2 size-4" />退出登录</Button>
          </>
        ) : step === "email" ? (
          <>
            <p className="mb-4 text-sm text-slate-500">电脑还在，工作继续。</p>
            <h1 className="text-[32px] font-semibold tracking-tight">回到你的 StillOn</h1>
            <p className="mt-3 text-sm leading-6 text-slate-500">用邮箱登录，继续你手上的工作。</p>
            <form className="mt-9 space-y-5" onSubmit={sendCode}>
              <div>
                <label htmlFor="connect-email" className="mb-2 block text-sm font-medium">邮箱地址</label>
                <Input ref={emailInput} id="connect-email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} placeholder="you@example.com" required maxLength={254} value={email} onChange={(event) => { setEmail(event.target.value); setError("") }} disabled={busy} aria-describedby={error ? "login-error" : undefined} className="h-12 rounded-xl border-slate-200 bg-white px-4" />
              </div>
              <Button type="submit" disabled={busy || cooldown > 0 || !email.trim()} className="h-12 w-full rounded-xl bg-slate-900 text-white hover:bg-slate-800">
                {busy ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
                {cooldown > 0 ? `${cooldown} 秒后可重新发送` : "获取验证码"}
                {!busy && cooldown === 0 && <ArrowRight className="ml-2 size-4" />}
              </Button>
            </form>
            <p className="mt-5 text-xs leading-6 text-slate-400">首次验证邮箱后，会自动创建账号。</p>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => { setStep("email"); setCode(""); setError("") }} className="mb-7 self-start px-0 hover:bg-transparent"><ArrowLeft className="mr-2 size-4" />修改邮箱</Button>
            <h1 className="text-3xl font-semibold tracking-tight">查收你的验证码</h1>
            <p className="mt-3 break-words text-sm leading-6 text-slate-500">验证码已发送至 <span className="font-medium text-slate-800">{email}</span>，5 分钟内有效。</p>
            <form onSubmit={signIn} className="mt-8 space-y-6">
              <div>
                <label htmlFor="connect-code" className="mb-3 block text-sm font-medium">6 位验证码</label>
                <OTPInput id="connect-code" ref={codeInput} maxLength={6} pattern={REGEXP_ONLY_DIGITS} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(value) => { setCode(value); setError("") }} disabled={busy} aria-describedby={error ? "login-error" : undefined} aria-invalid={Boolean(error)} pasteTransformer={(value) => value.replace(/[\s-]/g, "")} containerClassName="flex gap-2 justify-between has-[:disabled]:opacity-60" render={({ slots }) => <>{slots.map((slot, index) => <CodeSlot key={index} {...slot} />)}</>} />
              </div>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-500"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="size-4 accent-slate-900" disabled={busy} />在这台设备上保持登录 30 天</label>
              <Button type="submit" disabled={busy || code.length !== 6} className="h-12 w-full rounded-xl bg-slate-900 text-white hover:bg-slate-800">{busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}登录 StillOn<ArrowRight className="ml-2 size-4" /></Button>
            </form>
            <div className="mt-6 flex items-center justify-between text-xs text-slate-500">
              <span>没收到？也看看垃圾邮件。</span>
              <Button variant="link" size="none" disabled={busy || cooldown > 0} onClick={() => void sendCode()} className="h-8 text-xs text-slate-600">{cooldown > 0 ? `${cooldown} 秒后重发` : "重新发送"}</Button>
            </div>
          </>
        )}
        {error && <p id="login-error" role="alert" className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">{error}</p>}
      </main>
      <footer className="text-center text-xs tracking-wide text-slate-400">Leave your computer. Agent Still On.</footer>
    </div>
  )
}
