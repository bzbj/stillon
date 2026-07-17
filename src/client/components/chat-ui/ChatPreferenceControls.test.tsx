import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PROVIDERS } from "../../../shared/types"
import { ChatPreferenceControls } from "./ChatPreferenceControls"

describe("ChatPreferenceControls", () => {
  test("renders codex-specific controls without a run or plan mode selector", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-5.6-sol"
        modelOptions={{ reasoningEffort: "xhigh", fastMode: true }}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
      />
    )

    expect(html).toContain("Codex")
    expect(html).toContain("GPT-5.6-Sol")
    expect(html).toContain("XHigh")
    expect(html).toContain("Fast Mode")
    expect(html).not.toContain("Run Mode")
    expect(html).not.toContain("Plan Mode")
  })

  test("locks unsupported Codex models to Standard mode", () => {
    const html = renderToStaticMarkup(
      <ChatPreferenceControls
        availableProviders={PROVIDERS}
        selectedProvider="codex"
        model="gpt-5.4-mini"
        modelOptions={{ reasoningEffort: "high", fastMode: false }}
        onModelChange={() => {}}
        onModelOptionChange={() => {}}
      />
    )

    expect(html).toContain("GPT-5.4-Mini")
    expect(html).toContain("Standard")
    expect(html).toContain("disabled=\"\"")
    expect(html).not.toContain("Fast Mode")
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
})
