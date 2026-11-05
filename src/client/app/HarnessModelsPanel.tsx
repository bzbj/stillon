import { useEffect, useState } from "react"
import type { HarnessConfiguration, HarnessConfigInput, HarnessModel, HarnessModelPolicy } from "../../shared/harness-models"
import { Button } from "../components/ui/button"
import { notifyAddonsChanged } from "../hooks/useProviderCatalog"

const field = "w-full rounded-md border border-border bg-background p-2 text-sm"
async function request(body?: unknown) {
  const response = await fetch("/api/addons/deepseek/models", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || "Unable to read Harness models.")
  return data
}
export function HarnessModelsPanel({ onDefaultModel }: { onDefaultModel: (model: string) => void }) {
  const [configuration, setConfiguration] = useState<HarnessConfiguration | null>(null)
  const [serviceId, setServiceId] = useState("deepseek-official"), [customId, setCustomId] = useState("")
  const [baseURL, setBaseURL] = useState(""), [api, setApi] = useState<HarnessConfigInput["api"]>("")
  const [key, setKey] = useState(""), [manual, setManual] = useState("")
  const [models, setModels] = useState<HarnessModel[]>([]), [enabled, setEnabled] = useState<string[]>([]), [defaultModel, setDefaultModel] = useState("")
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("")
  const service = configuration?.services.find(s => s.id === serviceId)
  const custom = serviceId === "__new__"
  function choose(id: string, config = configuration) {
    const selected = config?.services.find(s => s.id === id)
    setServiceId(id); setBaseURL(selected?.baseURL ?? ""); setApi((selected?.api || "") as HarnessConfigInput["api"]); setKey(""); setManual("")
  }
  function adoptPolicy(policy: HarnessModelPolicy) { setModels(policy.models); setEnabled(policy.models.map(m => m.id)); setDefaultModel(policy.defaultModel) }
  async function reload(initial = false, selectedId = serviceId) {
    const data = await request()
    setConfiguration(data.configuration); choose(selectedId, data.configuration)
    if (initial && data.policy) adoptPolicy(data.policy)
    if (data.error) setError(data.error)
  }
  async function run(operation: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("")
    try { await operation() } catch (error) { setError(error instanceof Error ? error.message : "Harness operation failed.") }
    finally { setBusy(false) }
  }
  useEffect(() => { void run(() => reload(true)) }, [])
  const input = (): HarnessConfigInput => ({ provider: custom ? customId.trim() : serviceId, revision: service?.revision ?? "", baseURL: baseURL.trim(), api,
    ...(key ? { apiKey: key } : {}), ...(manual.trim() ? { models: [...new Set(manual.split(/[\n,]/).map(s => s.trim()).filter(Boolean))] } : {}) })
  async function discover(provider = serviceId) {
    const data = await request({ action: "discover", input: { provider } })
    const found = data.models as HarnessModel[]
    setModels(previous => [...previous.filter(m => m.provider !== provider || enabled.includes(m.id)), ...found.filter(m => !enabled.includes(m.id))]
      .map(m => found.find(n => n.id === m.id) ?? m))
    setMessage(found.length ? `Found ${found.length} models. Select the models to enable, then save the chat model list.` : "Harness returned no models for this service. Check its credentials and native configuration.")
  }
  return <section aria-label="DeepSeek Harness models" className="space-y-5 border-t border-border py-5">
    <div><h3 className="text-sm font-semibold">Model services in DeepSeek Harness</h3>
      <p className="mt-2 text-sm text-muted-foreground">StillOn launches your installed Harness using its sdk profile. Choose a model service here; API keys are stored by Harness and are never returned to this form.</p></div>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1 text-sm">Model service<select aria-label="Harness model service" className={field} disabled={busy || !configuration} value={serviceId} onChange={e => choose(e.target.value)}>
        {configuration?.services.map(s => <option key={s.id} value={s.id}>{s.label} ({s.id}){s.active ? " · Loaded" : ""}</option>)}
        <option value="__new__">Add a custom provider…</option>
      </select></label>
      {custom && <label className="space-y-1 text-sm">Provider ID<input aria-label="Harness provider ID" className={field} disabled={busy} value={customId} placeholder="my-gateway" onChange={e => setCustomId(e.target.value)} /></label>}
    </div>
    {service?.account ? <p className="text-sm text-muted-foreground">Uses your DeepSeek account sign-in in Harness. This service does not use an API key. Sign in with the Harness app, then discover its available models.</p> : <fieldset disabled={busy || !configuration} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">Base URL<input aria-label="Harness base URL" className={field} value={baseURL} placeholder="Use the Harness default" onChange={e => setBaseURL(e.target.value)} /></label>
        {serviceId !== "deepseek-official" && <label className="space-y-1 text-sm">API protocol<select aria-label="Harness API protocol" className={field} value={api} onChange={e => setApi(e.target.value as HarnessConfigInput["api"])}>
          <option value="">Use the Harness provider default</option><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option>
        </select></label>}
        <label className="space-y-1 text-sm">API key<input aria-label="Harness API key" className={field} type="password" autoComplete="new-password" value={key} placeholder={service?.apiKeyConfigured ? "Configured in Harness · leave blank to keep" : "Leave blank to use Harness authentication"} onChange={e => setKey(e.target.value)} />
          <span className="block text-xs text-muted-foreground">{service?.apiKeyConfigured ? "A credential reference is configured." : "Existing Harness sign-in and environment credentials are retained."}</span></label>
      </div>
      <label className="block space-y-1 text-sm">Model IDs (optional)<textarea aria-label="Harness model IDs" className={field} rows={3} value={manual} placeholder="Leave blank to keep the Harness catalog. For a custom endpoint, enter one model ID per line or fetch its available models." onChange={e => setManual(e.target.value)} /></label>
      <div className="flex flex-wrap gap-2">
        {serviceId !== "deepseek-official" && <Button variant="outline" onClick={() => void run(async () => {
          const data = await request({ action: "fetchModels", input: input() })
          setManual(data.result.map((m: { id: string }) => m.id).join("\n")); setMessage("Available models loaded into the draft. Review the IDs, then save the service.")
        })}>Fetch endpoint models</Button>}
        <Button variant="outline" onClick={() => void run(async () => {
          const draft = input(); await request({ action: "configure", input: draft }); setKey("")
          await reload(false, draft.provider); setMessage("Service saved in the Harness sdk profile. Discover its loaded models to enable them for chats.")
        })}>Save model service</Button>
      </div>
    </fieldset>}
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || !service?.active || custom} onClick={() => void run(() => discover())}>Discover loaded models</Button>
      <Button variant="ghost" disabled={busy} onClick={() => void run(() => reload())}>Reload Harness configuration</Button>
    </div>
    <div className="space-y-3"><h3 className="text-sm font-semibold">Models enabled in chats</h3>
      <p className="text-sm text-muted-foreground">Discovery reads the models and reasoning levels loaded by Harness. Chats use this saved list; discovery does not change existing chats. Before your first save, the integration keeps its original DeepSeek API models.</p>
      {models.length > 0 && <>
        <div className="max-h-72 overflow-auto rounded-lg border border-border p-3 space-y-2">{models.map(m => <label key={m.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={busy} checked={enabled.includes(m.id)} onChange={e => setEnabled(previous => e.target.checked ? [...previous, m.id] : previous.filter(id => id !== m.id))} />
          <span>{m.label}</span>
        </label>)}</div>
        <label className="block space-y-1 text-sm">Default chat model<select aria-label="Harness default chat model" className={field} disabled={busy} value={defaultModel} onChange={e => setDefaultModel(e.target.value)}>
          <option value="">Choose an enabled model</option>{models.filter(m => enabled.includes(m.id)).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select></label>
        <Button disabled={busy || !enabled.includes(defaultModel)} onClick={() => void run(async () => {
          const data = await request({ action: "apply", selection: { ids: enabled, defaultModel } }); adoptPolicy(data.policy)
          onDefaultModel(defaultModel); notifyAddonsChanged(); setMessage("Chat model list saved. Existing chats keep their selected provider and model.")
        })}>Save chat model list</Button>
      </>}
    </div>
    {busy && <p role="status" className="text-sm text-muted-foreground">Reading or updating your local Harness…</p>}
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>
}
