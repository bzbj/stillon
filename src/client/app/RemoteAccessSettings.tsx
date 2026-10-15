import { useEffect, useState } from "react"
import { Check, Copy, ExternalLink, LoaderCircle, Monitor } from "lucide-react"
import { Button } from "../components/ui/button"
import type { ConnectHost, ConnectLocalStatus, ConnectRemoteStatus } from "../../shared/connect"

const labels: Record<ConnectLocalStatus["state"], string> = { unbound: "尚未绑定邮箱", pending: "等待邮箱验证", connecting: "正在建立连接", online: "远程访问已开启", offline: "电脑暂时未连上服务", paused: "远程访问已暂停", revoked: "电脑已解绑", "revocation-pending": "通道已关闭，等待完成解绑" }
const errors: Record<string, string> = { CONNECTOR_NOT_INSTALLED: "这个安装包尚未包含远程连接组件，请使用支持 Connect 的安装包。", SERVICE_NOT_CONFIGURED: "尚未设置远程服务地址。", BUSY: "连接状态正在更新，请稍后再试。", CLOUD_UPDATE_PENDING: "本机通道已关闭，恢复联网后将自动同步。", DEVICE_ALREADY_CONNECTED: "另一份相同的电脑身份正在连接。请在原电脑解绑后，再绑定此电脑。", BINDING_EXPIRED: "绑定请求已过期，请重新绑定。", DEVICE_STATE_INVALID: "无法读取电脑身份，请联系安装包提供者处理。" }

export function RemoteAccessSettings({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const [local, setLocal] = useState<ConnectLocalStatus | null>(null)
  const [remote, setRemote] = useState<ConnectRemoteStatus | null>(null)
  const [hosts, setHosts] = useState<ConnectHost[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const [confirmUnbind, setConfirmUnbind] = useState(false)
  async function refresh() {
    const response = await fetch("/auth/status", { cache: "no-store" })
    if (!response.ok) throw new Error("无法读取连接状态。")
    const auth = await response.json()
    if (auth.mode === "connect") {
      setRemote(auth)
      const response = await fetch("/_connect/hosts", { cache: "no-store" })
      if (response.ok) setHosts((await response.json()).hosts)
    } else {
      const response = await fetch("/api/connect-local/status", { cache: "no-store" })
      if (!response.ok) throw new Error(response.status === 403 ? "请在这台电脑上打开 StillOn 的本机地址，以管理远程绑定。" : "无法读取连接状态。")
      setLocal(await response.json())
    }
  }
  useEffect(() => { void refresh().catch(e => setError(e.message)); const timer = window.setInterval(() => { void refresh().catch(() => {}) }, 5_000); return () => window.clearInterval(timer) }, [])
  async function action(name: "enroll" | "pause" | "resume" | "unbind") {
    setBusy(true); setError("")
    try {
      const response = await fetch(`/api/connect-local/${name}`, { method: "POST" })
      const data = await response.json()
      if (!response.ok) throw new Error(errors[data.error] ?? "暂时无法连接远程服务，请稍后再试。")
      await refresh(); setConfirmUnbind(false)
    } catch (e) { setError(e instanceof Error ? e.message : "操作未完成。") }
    finally { setBusy(false) }
  }
  return <section className="max-w-xl space-y-6 py-6">
    {remote ? <>
      <div className="flex items-center gap-3"><Monitor className="size-5" /><div><h3 className="font-medium">{remote.host?.name ?? "当前电脑"}</h3><p className="mt-1 text-sm text-muted-foreground">你正在远程使用这台电脑。任务和文件保存在电脑上。</p></div></div>
      {hosts.length > 1 && <div className="space-y-3"><h4 className="text-sm font-medium">切换电脑</h4>{hosts.map(host => <div key={host.id} className="flex items-center gap-4 rounded-xl border p-4"><span className="min-w-0 flex-1 truncate text-sm">{host.name} · {host.online ? "在线" : "离线"}</span>{host.id === remote.host?.id ? <span className="text-xs text-muted-foreground">当前电脑</span> : <a className="text-sm underline" href={`${host.url}/_connect/login`}>切换</a>}</div>)}</div>}
      <p className="text-sm leading-6 text-muted-foreground">切换仅影响当前标签页。退出登录会结束这个浏览器的所有电脑连接，电脑上的任务继续运行。</p>
      <Button variant="outline" onClick={() => void onSignOut()}>Logout · 退出远程登录</Button>
    </> : local ? <>
      <div className="rounded-2xl border p-5"><div className="flex items-center gap-3"><span className={`size-2 rounded-full ${local.state === "online" ? "bg-emerald-500" : "bg-muted-foreground/40"}`} /><h3 className="font-medium">{labels[local.state]}</h3></div><p className="mt-3 text-sm text-muted-foreground">{local.name}{local.email ? ` · ${local.email}` : ""}</p></div>
      <p className="text-sm leading-6 text-muted-foreground">绑定邮箱后，在其他设备的浏览器登录，就能继续下任务、查看文件和修改结果。请让这台电脑保持开机、联网，并让 StillOn 持续运行。</p>
      {!local.configured ? <p className="text-sm text-muted-foreground">这个版本尚未配置远程服务。本机使用不受影响。</p> : !local.hostId ? <div className="space-y-4">
        <Button disabled={busy} onClick={() => void action("enroll")}>{busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}{local.enrollment ? "刷新绑定状态" : "绑定邮箱"}</Button>
        {local.enrollment && <div className="space-y-3 rounded-xl bg-muted/40 p-4"><p className="text-sm">在验证页面填写邮箱和 6 位验证码，即可绑定这台电脑。</p><a className="inline-flex items-center gap-2 text-sm font-medium underline" href={local.enrollment.verificationUrl} target="_blank" rel="noreferrer">打开邮箱验证页面<ExternalLink className="size-4" /></a></div>}
      </div> : <>
        <div className="space-y-2"><p className="text-sm font-medium">远程登录网址</p><div className="flex items-center gap-3"><a href={local.origin!} target="_blank" rel="noreferrer" className="min-w-0 break-all text-sm underline">{local.origin}</a><Button size="icon" variant="ghost" aria-label="复制远程网址" onClick={() => { void navigator.clipboard.writeText(local.origin!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2_000) }) }}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button></div></div>
        <div className="flex flex-wrap gap-3">{!["revoked", "revocation-pending"].includes(local.state) && <Button disabled={busy} variant="outline" onClick={() => void action(local.state === "paused" ? "resume" : "pause")}>{local.state === "paused" ? "恢复远程访问" : "暂停远程访问"}</Button>}<Button disabled={busy} variant="ghost" onClick={() => setConfirmUnbind(true)}>解绑邮箱</Button></div>
        {confirmUnbind && <div className="space-y-3 rounded-xl border p-4"><p className="text-sm leading-6">解绑会关闭这台电脑的所有远程连接，保留本机文件和任务。之后可以重新绑定邮箱。</p><div className="flex gap-3"><Button disabled={busy} variant="destructive" onClick={() => void action("unbind")}>确认解绑</Button><Button variant="ghost" onClick={() => setConfirmUnbind(false)}>取消</Button></div></div>}
      </>}
      {local.error && <p className="text-sm text-muted-foreground">{errors[local.error] ?? "连接暂时不可用，StillOn 会自动尝试重连。"}</p>}
    </> : !error ? <p className="text-sm text-muted-foreground">正在读取连接状态…</p> : null}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>
}
