import { describe, expect, test } from "bun:test"
import {
  getAgentNetworkStatus,
  inheritAgentEnvironment,
  inheritClaudeAgentEnvironment,
  mergeAgentNetworkEnvironment,
} from "./agent-environment"
import type { AgentNetworkProxySettings } from "../shared/types"

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

  test("system mode preserves --env-file proxy values without overriding them", () => {
    const settings: AgentNetworkProxySettings = {
      mode: "system",
      httpProxy: "http://settings.invalid:1",
      httpsProxy: "",
      allProxy: "",
      noProxy: "localhost,127.0.0.1,::1",
    }
    const inherited = mergeAgentNetworkEnvironment(proxyEnvironment, settings)

    expect(inherited.HTTP_PROXY).toBe(proxyEnvironment.HTTP_PROXY)
    expect(inherited.HTTPS_PROXY).toBe(proxyEnvironment.HTTPS_PROXY)
  })

  test("manual settings override only explicitly saved variables and keep inherited fallbacks", () => {
    const inherited = mergeAgentNetworkEnvironment({
      ...proxyEnvironment,
      NO_PROXY: ".corp.local,localhost",
    }, {
      mode: "manual",
      httpProxy: "http://127.0.0.1:9000",
      httpsProxy: "",
      allProxy: "",
      noProxy: "localhost,127.0.0.1,::1",
    })

    expect(inherited.HTTP_PROXY).toBe("http://127.0.0.1:9000")
    expect(inherited.http_proxy).toBe("http://127.0.0.1:9000")
    expect(inherited.HTTPS_PROXY).toBe(proxyEnvironment.HTTPS_PROXY)
    expect(inherited.NO_PROXY).toBe(".corp.local,localhost,127.0.0.1,::1")
  })

  test("reports redacted effective sources without exposing inherited credentials", () => {
    const status = getAgentNetworkStatus({
      mode: "system",
      httpProxy: "",
      httpsProxy: "",
      allProxy: "",
      noProxy: "localhost,127.0.0.1,::1",
    }, {
      HTTPS_PROXY: "http://proxy-user:proxy-password@127.0.0.1:7890/secret-token?key=hidden",
    })

    expect(status.source).toBe("inherited")
    expect(status.sourceLabel).toContain("--env-file")
    expect(status.effectiveProxy[0]?.value).toBe("http://127.0.0.1:7890")
    expect(JSON.stringify(status)).not.toContain("proxy-password")
    expect(JSON.stringify(status)).not.toContain("secret-token")
    expect(JSON.stringify(status)).not.toContain("hidden")
  })
})
