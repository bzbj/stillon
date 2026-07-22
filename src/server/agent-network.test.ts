import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:net"
import {
  applyAgentNetworkPatch,
  createAgentNetworkFetch,
  createDefaultAgentNetworkSettings,
  detectSystemProxy,
  normalizeAgentNetworkSettings,
  parseLinuxProxySettings,
  parseMacOsProxySettings,
  parseWindowsProxySettings,
  resolveAgentProxyForUrl,
  testAgentNetworkConnection,
} from "./agent-network"

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers.length = 0
})

describe("agent network settings", () => {
  test("normalizes proxy URLs and retains loopback bypass entries", () => {
    const { settings, warnings } = normalizeAgentNetworkSettings({
      mode: "manual",
      httpProxy: " http://proxy.local:7890/ ",
      allProxy: "socks5://127.0.0.1:1080",
      noProxy: ".internal",
    }, { strict: true })

    expect(warnings).toEqual([])
    expect(settings.httpProxy).toBe("http://proxy.local:7890")
    expect(settings.allProxy).toBe("socks5://127.0.0.1:1080")
    expect(settings.noProxy.split(",")).toEqual([".internal", "localhost", "127.0.0.1", "::1"])
  })

  test("rejects credentialed proxy URLs instead of persisting secrets", () => {
    expect(() => applyAgentNetworkPatch(createDefaultAgentNetworkSettings(), {
      mode: "manual",
      httpsProxy: "http://user:secret@proxy.local:7890",
    })).toThrow("cannot contain credentials")
  })
})

describe("system proxy detection adapters", () => {
  test("parses macOS HTTP, HTTPS, SOCKS, bypass, and PAC declarations without executing PAC", () => {
    const result = parseMacOsProxySettings(`
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : proxy.local
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
  ExceptionsList : <array> {
    0 : *.local
  }
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : https://example.test/proxy.pac
}`)

    expect(result.status).toBe("detected")
    expect(result.pacUrlDetected).toBe(true)
    expect(result.settings).toMatchObject({
      mode: "detected",
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://proxy.local:7891",
      allProxy: "socks5://127.0.0.1:1080",
    })
    expect(result.settings?.noProxy).toContain("*.local")
  })

  test("parses Windows user proxy mappings and bypass entries", () => {
    const result = parseWindowsProxySettings(JSON.stringify({
      ProxyEnable: true,
      ProxyServer: "http=127.0.0.1:7890;https=proxy.local:7891;socks=127.0.0.1:1080",
      ProxyOverride: "<local>;*.internal",
      AutoConfigURL: null,
      WinHttp: "",
    }))

    expect(result.status).toBe("detected")
    expect(result.settings).toMatchObject({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://proxy.local:7891",
      allProxy: "socks5://127.0.0.1:1080",
    })
    expect(result.settings?.noProxy).toContain("localhost")
  })

  test("parses GNOME manual proxy settings", () => {
    const result = parseLinuxProxySettings(`
org.gnome.system.proxy mode 'manual'
org.gnome.system.proxy ignore-hosts ['localhost', '127.0.0.1', '*.local']
org.gnome.system.proxy.http host '127.0.0.1'
org.gnome.system.proxy.http port 7890
org.gnome.system.proxy.https host 'proxy.local'
org.gnome.system.proxy.https port 7891
org.gnome.system.proxy.socks host '127.0.0.1'
org.gnome.system.proxy.socks port 1080
`)

    expect(result.status).toBe("detected")
    expect(result.settings?.httpsProxy).toBe("http://proxy.local:7891")
    expect(result.settings?.allProxy).toBe("socks5://127.0.0.1:1080")
  })

  test("uses only the declared OS adapter command", async () => {
    const calls: Array<[string, string[]]> = []
    const result = await detectSystemProxy({
      platform: "darwin",
      runCommand: async (command, args) => {
        calls.push([command, args])
        return { stdout: "HTTPEnable : 0", stderr: "", exitCode: 0 }
      },
    })

    expect(result.status).toBe("none")
    expect(calls).toEqual([["scutil", ["--proxy"]]])
  })
})

describe("agent network connection diagnostics", () => {
  test("resolves provider HTTP proxy precedence and honors NO_PROXY", () => {
    const environment = {
      HTTP_PROXY: "http://http-proxy.local:8080",
      HTTPS_PROXY: "http://https-proxy.local:8443",
      ALL_PROXY: "socks5://socks-proxy.local:1080",
      NO_PROXY: ".internal",
    }
    expect(resolveAgentProxyForUrl(new URL("https://api.openai.com"), environment)).toBe("http://https-proxy.local:8443")
    expect(resolveAgentProxyForUrl(new URL("https://service.internal"), environment)).toBe("")
    expect(resolveAgentProxyForUrl(new URL("http://[::1]:3210"), environment)).toBe("http://http-proxy.local:8080")
    expect(resolveAgentProxyForUrl(new URL("http://[::1]:3210"), { ...environment, NO_PROXY: "::1" })).toBe("")
    expect(resolveAgentProxyForUrl(new URL("http://[::1]:3210"), { ...environment, NO_PROXY: "[::1]:3210" })).toBe("")
  })

  test("preserves a Request input while adding the effective proxy option", async () => {
    const request = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "X-Test": "preserved" },
      body: "payload",
    })
    const capturedInputs: Array<RequestInfo | URL> = []
    let capturedProxy = ""
    const wrapped = createAgentNetworkFetch(
      { HTTPS_PROXY: "http://127.0.0.1:7890" },
      async (input, init) => {
        capturedInputs.push(input)
        capturedProxy = init.proxy ?? ""
        return new Response(null, { status: 200 })
      },
    )

    await wrapped(request)
    expect(capturedInputs[0]).toBe(request)
    expect((capturedInputs[0] as Request).method).toBe("POST")
    expect((capturedInputs[0] as Request).headers.get("X-Test")).toBe("preserved")
    expect(capturedProxy).toBe("http://127.0.0.1:7890")
  })

  test("passes the effective HTTP CONNECT proxy to fetch and redacts inherited credentials", async () => {
    let proxyOption = ""
    const result = await testAgentNetworkConnection({
      provider: "codex",
      settings: createDefaultAgentNetworkSettings(),
      environment: { HTTPS_PROXY: "http://user:secret@127.0.0.1:7890" },
      fetchImpl: async (_input, init) => {
        proxyOption = init.proxy ?? ""
        return new Response(null, { status: 401 })
      },
    })

    expect(result.ok).toBe(true)
    expect(proxyOption).toBe("http://user:secret@127.0.0.1:7890")
    expect(result.proxy).toBe("http://127.0.0.1:7890")
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test("returns an actionable proxy authentication result", async () => {
    const result = await testAgentNetworkConnection({
      provider: "claude",
      settings: {
        ...createDefaultAgentNetworkSettings(),
        mode: "manual",
        httpsProxy: "http://127.0.0.1:7890",
      },
      environment: {},
      fetchImpl: async () => new Response(null, { status: 407 }),
    })

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe("proxy_auth_required")
    expect(result.message).toContain("--env-file")
  })

  test("does not report a proxy upstream gateway failure as reachable", async () => {
    const result = await testAgentNetworkConnection({
      provider: "codex",
      settings: {
        ...createDefaultAgentNetworkSettings(),
        mode: "manual",
        httpsProxy: "http://127.0.0.1:7890",
      },
      environment: {},
      fetchImpl: async () => new Response(null, { status: 502 }),
    })

    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe("proxy_rejected")
  })

  test("performs a SOCKS5 handshake instead of passing SOCKS to Bun fetch", async () => {
    const server = createServer((socket) => {
      let stage = 0
      socket.on("data", () => {
        if (stage === 0) {
          stage = 1
          socket.write(Buffer.from([0x05, 0x00]))
          return
        }
        socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing test server address")
    let fetchCalled = false

    const result = await testAgentNetworkConnection({
      provider: "claude",
      settings: {
        ...createDefaultAgentNetworkSettings(),
        mode: "manual",
        allProxy: `socks5://127.0.0.1:${address.port}`,
      },
      environment: {},
      timeoutMs: 2_000,
      fetchImpl: async () => {
        fetchCalled = true
        return new Response(null, { status: 200 })
      },
    })

    expect(fetchCalled).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe("proxy_unreachable")
  })
})
