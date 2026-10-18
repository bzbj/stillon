import { describe, expect, test } from "bun:test"
import { extractHtmlTitle, filterLocalHttpServers, isDescendantPid, isPathWithin, listLocalHttpServers, parseLsofListeningEntries, parseLsofListeningPorts, parseWindowsListeningEntries } from "./local-http-servers"

describe("local http servers", () => {
  test("discovers single-family IPv4 and IPv6 listeners with localhost Host semantics", async () => {
    const apps = ["127.0.0.1", "::1"].map(hostname => Bun.serve({ hostname, port: 0, fetch(request) {
      const port = new URL(request.url).port
      return new Response("<!doctype html><title>Loopback fixture " + port + "</title>", { status: request.headers.get("host") === "localhost:" + port ? 200 : 400, headers: { "Content-Type": "text/html" } })
    } }))
    try {
      for (let scan = 0; scan < 5; scan++) {
        const servers = await listLocalHttpServers({ projectPath: "preview-discovery-" + apps.map(app => app.port).join("-") + "-" + scan })
        for (const app of apps) expect(servers.find(server => server.port === app.port)?.title).toBe("Loopback fixture " + app.port)
      }
    } finally { for (const app of apps) await app.stop(true) }
  }, 60_000)

  test("extracts html titles", () => {
    expect(extractHtmlTitle("<html><head><title> Vite App </title></head></html>")).toBe("Vite App")
    expect(extractHtmlTitle("<html></html>")).toBe("")
  })

  test("parses listening tcp ports from lsof output", () => {
    const output = `
COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    12345 jake   23u  IPv4 123456      0t0  TCP *:5174 (LISTEN)
bun     12346 jake   23u  IPv4 123457      0t0  TCP localhost:3210 (LISTEN)
other   12347 jake   23u  IPv4 123458      0t0  TCP 127.0.0.1:8080 (LISTEN)
    `

    expect(parseLsofListeningPorts(output)).toEqual([3210, 5174, 8080])
    expect(parseLsofListeningEntries(output)).toEqual([
      { port: 3210, owners: [{ command: "bun", pid: 12346 }] },
      { port: 5174, owners: [{ command: "node", pid: 12345 }] },
      { port: 8080, owners: [{ command: "other", pid: 12347 }] },
    ])
  })

  test("detects project paths", () => {
    expect(isPathWithin("/tmp/project", "/tmp/project")).toBe(true)
    expect(isPathWithin("/tmp/project", "/tmp/project/app")).toBe(true)
    expect(isPathWithin("/tmp/project", "/tmp/project-other")).toBe(false)
  })

  test("discovers Windows IPv4/IPv6 listeners without duplicate ports or non-listening connections", () => {
    expect(parseWindowsListeningEntries([
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       1234",
      "  TCP    [::]:5173              [::]:0                 LISTENING       1234",
      "  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       5678",
      "  TCP    127.0.0.1:60000        127.0.0.1:8080         ESTABLISHED     5678",
      "  TCP    0.0.0.0:70000          0.0.0.0:0              LISTENING       9",
    ].join("\n"))).toEqual([
      { port: 5173, owners: [{ command: "", pid: 1234 }] },
      { port: 8080, owners: [{ command: "", pid: 5678 }] },
    ])
  })

  test("detects descendant processes", () => {
    const parentByPid = new Map([
      [20, 10],
      [30, 20],
      [40, 1],
    ])

    expect(isDescendantPid(30, new Set([10]), parentByPid)).toBe(true)
    expect(isDescendantPid(40, new Set([10]), parentByPid)).toBe(false)
  })

  test("filters internal responders without collapsing duplicate page titles", () => {
    expect(filterLocalHttpServers([
      { title: "localhost:3211", address: "http://localhost:3211", port: 3211, status: 404, ownerPath: "/tmp/app", processName: "bun", sameProject: true },
      { title: "Sample App", address: "http://localhost:5174", port: 5174, status: 200, ownerPath: "/tmp/app", processName: "node", sameProject: true },
      { title: "Sample App", address: "http://localhost:5175", port: 5175, status: 200, ownerPath: "/tmp/app", processName: "node", sameProject: true },
      { title: "Sample App", address: "http://localhost:8787", port: 8787, status: 200, ownerPath: "/tmp/app", processName: "workerd", sameProject: true },
      { title: "Welcome to nginx!", address: "http://localhost:8080", port: 8080, status: 200, ownerPath: "/opt/homebrew", processName: "nginx", sameProject: false },
      { title: "wterm-demo", address: "http://localhost:5003", port: 5003, status: 200, ownerPath: "/tmp/wterm", processName: "node", sameProject: false },
    ])).toEqual([
      { title: "Sample App", address: "http://localhost:5174", port: 5174, status: 200, ownerPath: "/tmp/app", processName: "node", sameProject: true },
      { title: "Sample App", address: "http://localhost:5175", port: 5175, status: 200, ownerPath: "/tmp/app", processName: "node", sameProject: true },
      { title: "wterm-demo", address: "http://localhost:5003", port: 5003, status: 200, ownerPath: "/tmp/wterm", processName: "node", sameProject: false },
    ])
  })
})
