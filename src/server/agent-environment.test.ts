import { describe, expect, test } from "bun:test"
import { inheritAgentEnvironment, inheritClaudeAgentEnvironment } from "./agent-environment"

const proxyEnvironment = {
  HTTP_PROXY: "http://127.0.0.1:7890",
  HTTPS_PROXY: "http://127.0.0.1:7890",
  ALL_PROXY: "socks5://127.0.0.1:1080",
  NO_PROXY: "127.0.0.1,localhost,::1",
} satisfies NodeJS.ProcessEnv

describe("agent environment inheritance", () => {
  test("preserves standard proxy variables for Codex and other child agents", () => {
    const source = {
      ...proxyEnvironment,
      STILLON_MACHINE_NAME: "Office Mac",
    }
    const inherited = inheritAgentEnvironment(source)

    expect(inherited).toMatchObject(proxyEnvironment)
    expect(inherited.STILLON_MACHINE_NAME).toBe("Office Mac")
    expect(inherited).not.toBe(source)
  })

  test("preserves proxy variables for Claude while removing only CLAUDECODE", () => {
    const inherited = inheritClaudeAgentEnvironment({
      ...proxyEnvironment,
      CLAUDECODE: "1",
    })

    expect(inherited).toMatchObject(proxyEnvironment)
    expect(inherited.CLAUDECODE).toBeUndefined()
  })
})
