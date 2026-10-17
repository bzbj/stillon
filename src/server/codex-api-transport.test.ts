import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { codexApiTransportArgs } from "./codex-api-transport"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(text = "") {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-codex-connection-"))
  roots.push(root)
  await writeFile(path.join(root, "config.toml"), text)
  return { root, environment: { CODEX_HOME: root }, text }
}
function overrides(args: string[]) {
  return Bun.TOML.parse(args.filter((_, index) => index % 2 === 1).join("\n")) as any
}

test("Automatic passes through without reading or overriding an invalid Codex config", async () => {
  const f = await fixture("broken config credential=secret")
  expect(codexApiTransportArgs("auto", f.environment)).toEqual([])
  expect(await readFile(path.join(f.root, "config.toml"), "utf8")).toBe(f.text)
})

test("HTTPS uses a process-only alias that keeps ChatGPT/API auth endpoint selection", async () => {
  const f = await fixture('model = "gpt-6.1-sol"\n')
  const values = overrides(codexApiTransportArgs("https", f.environment))
  expect(values.model_provider).toBe("stillon-openai-https")
  expect(values.model_providers[values.model_provider]).toEqual({
    name: "OpenAI", wire_api: "responses", requires_openai_auth: true,
    supports_websockets: false, supports_standalone_web_search: true,
    env_http_headers: { "OpenAI-Organization": "OPENAI_ORGANIZATION", "OpenAI-Project": "OPENAI_PROJECT" },
  })
  expect(await readFile(path.join(f.root, "config.toml"), "utf8")).toBe(f.text)
})

test("missing user config remains missing and gets the normal OpenAI auth defaults", async () => {
  const f = await fixture()
  await rm(path.join(f.root, "config.toml"))
  expect(overrides(codexApiTransportArgs("https", f.environment)).model_provider).toBe("stillon-openai-https")
  expect(await Bun.file(path.join(f.root, "config.toml")).exists()).toBe(false)
})

test("explicit OpenAI gateway URL wins over the environment and alias IDs never overwrite a user provider", async () => {
  const f = await fixture('openai_base_url = "https://gateway.example/v1"\n[model_providers.stillon-openai-https]\nname = "Existing custom provider"\n')
  const values = overrides(codexApiTransportArgs("https", { ...f.environment, OPENAI_BASE_URL: "https://other.example/v1" }))
  expect(values.model_provider).toBe("stillon-openai-https-1")
  expect(values.model_providers[values.model_provider].base_url).toBe("https://gateway.example/v1")
  expect(await readFile(path.join(f.root, "config.toml"), "utf8")).toBe(f.text)
})

test("OpenAI environment base URL is preserved", async () => {
  const f = await fixture()
  const values = overrides(codexApiTransportArgs("https", { ...f.environment, OPENAI_BASE_URL: "http://127.0.0.1:8080/v1" }))
  expect(values.model_providers[values.model_provider].base_url).toBe("http://127.0.0.1:8080/v1")
})

test.each(["gateway", "provider.with.dots", 'provider"quoted'])('custom provider %s keeps its endpoint, auth and all other config', async (id) => {
  const f = await fixture(`model_provider = ${JSON.stringify(id)}\n[model_providers.${JSON.stringify(id)}]\nname = "Gateway"\nbase_url = "https://gateway.example/v1"\nenv_key = "PRIVATE_GATEWAY_KEY"\nsupports_websockets = true\n`)
  const values = overrides(codexApiTransportArgs("https", f.environment))
  expect(values).toEqual({ model_providers: { [id]: { supports_websockets: false } } })
  expect(await readFile(path.join(f.root, "config.toml"), "utf8")).toBe(f.text)
})

test("resolves the selected provider from a profile file", async () => {
  const f = await fixture('profile = "work"\n')
  await writeFile(path.join(f.root, "work.config.toml"), 'model_provider = "work-gateway"\n[model_providers.work-gateway]\nname="Work"\nbase_url="https://work.example/v1"\n')
  expect(overrides(codexApiTransportArgs("https", f.environment))).toEqual({ model_providers: { "work-gateway": { supports_websockets: false } } })
})

test("legacy profile selection is preserved", async () => {
  const f = await fixture('profile="work"\n[profiles.work]\nmodel_provider="work"\n[model_providers.work]\nname="Work"\n')
  expect(overrides(codexApiTransportArgs("https", f.environment))).toEqual({ model_providers: { work: { supports_websockets: false } } })
})

test("unresolvable or invalid config fails without redirecting credentials or exposing parser contents", async () => {
  const f = await fixture('model_provider = "missing"\n')
  expect(() => codexApiTransportArgs("https", f.environment)).toThrow("Unable to resolve")
  await writeFile(path.join(f.root, "config.toml"), 'private_key="sensitive text\n')
  try { codexApiTransportArgs("https", f.environment); throw new Error("Expected failure") } catch (error) {
    expect(String(error)).toContain("Unable to read Codex")
    expect(String(error)).not.toContain("sensitive text")
  }
})

test.each(["ollama", "lmstudio", "amazon-bedrock", "amazon-bedrock-runtime"])("leaves HTTP provider %s unchanged", async (provider) => {
  const f = await fixture(`model_provider=${JSON.stringify(provider)}\n`)
  expect(codexApiTransportArgs("https", f.environment)).toEqual([])
})
