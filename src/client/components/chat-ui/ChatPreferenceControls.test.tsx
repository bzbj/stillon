import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PROVIDERS } from "../../../shared/types"
import { ChatPreferenceControls, INPUT_POPOVER_MENU_CLASS } from "./ChatPreferenceControls"

describe("ChatPreferenceControls", () => {
  test("Harness labels and reasoning choices come from the exact discovered model", () => {
    const catalog = { id: "deepseek" as const, label: "DeepSeek Harness", defaultModel: "dsh:gateway:shared", efforts: [{ id: "high", label: "Wrong global level" }],
      models: [{ id: "dsh:gateway:shared", label: "Shared model · gateway", supportsEffort: true, efforts: [{ id: "adaptive", label: "Provider adaptive reasoning" }] }] }
    const html = renderToStaticMarkup(<ChatPreferenceControls availableProviders={[catalog]} selectedProvider="deepseek" model={catalog.defaultModel}
      modelOptions={{ reasoningEffort: "adaptive" }} onModelChange={() => {}} onModelOptionChange={() => {}} />)
    expect(html).toContain("DeepSeek Harness")
    expect(html).toContain("Shared model · gateway")
    expect(html).toContain("Provider adaptive reasoning")
    expect(html).not.toContain("Wrong global level")
    const plain = renderToStaticMarkup(<ChatPreferenceControls availableProviders={[{ ...catalog, models: [{ ...catalog.models[0]!, supportsEffort: false }] }]} selectedProvider="deepseek" model={catalog.defaultModel}
      modelOptions={{ reasoningEffort: "default" }} onModelChange={() => {}} onModelOptionChange={() => {}} />)
    expect(plain).not.toContain("Provider adaptive reasoning")
  })
  test("renders codex-specific controls without a run or plan mode selector", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-6.1-sol"
        modelOptions={{ reasoningEffort: "xhigh", fastMode: true }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
      />
    )

    expect(html).toContain("Codex")
    expect(html).toContain("GPT-6.1-Sol")
    expect(html).toContain("XHigh")
    expect(html).toContain("Fast Mode")
    expect(html).not.toContain("Run Mode")
    expect(html).not.toContain("Plan Mode")
  })

  test("renders Astra with Ultra effort and Fast Mode", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-6-astra"
        modelOptions={{ reasoningEffort: "ultra", fastMode: true }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
      />
    )

    expect(html).toContain("GPT-6-Astra")
    expect(html).toContain("Ultra")
    expect(html).toContain("Fast Mode")
    expect(html).not.toContain('disabled=""')
  })

  test("renders Luna with Fast Mode", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-6-luna"
        modelOptions={{ reasoningEffort: "high", fastMode: true }}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
      />
    )

    expect(html).toContain("GPT-6-Luna")
    expect(html).toContain("Fast Mode")
  })

  test("renders Claude controls without a run or plan mode selector", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="claude"
        model="claude-opus-4-8"
        modelOptions={{ reasoningEffort: "max", contextWindow: "1m" }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
      />
    )

    expect(html).toContain("Claude")
    expect(html).toContain("Opus")
    expect(html).toContain("Max")
    expect(html).toContain("1M")
    expect(html).not.toContain("Run Mode")
    expect(html).not.toContain("Plan Mode")
  })

  test("renders Fable as a Claude model option", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="claude"
        model="claude-fable-5"
        modelOptions={{ reasoningEffort: "high", contextWindow: "1m" }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
      />
    )

    expect(html).toContain("Fable")
    expect(html).toContain("High")
  })

  test("keeps a long model menu within the available viewport height and scrollable", () => {
    expect(INPUT_POPOVER_MENU_CLASS).toContain("max-h-[calc(var(--radix-popover-content-available-height)-0.5rem)]")
    expect(INPUT_POPOVER_MENU_CLASS).toContain("overflow-y-auto")
    expect(INPUT_POPOVER_MENU_CLASS).toContain("overscroll-contain")
  })
})
