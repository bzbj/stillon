import { describe, expect, test } from "bun:test"
import {
  DEFAULT_DEV_CLIENT_PORT,
  getDefaultDevServerPort,
  parseDevArgs,
  resolveDevPorts,
  stripPortArg,
} from "./dev-ports"

describe("getDefaultDevServerPort", () => {
  test("derives the default backend port from the client port", () => {
    expect(getDefaultDevServerPort()).toBe(DEFAULT_DEV_CLIENT_PORT + 1)
    expect(getDefaultDevServerPort(4000)).toBe(4001)
  })
})

describe("resolveDevPorts", () => {
  test("uses default dev ports when no port override is provided", () => {
    expect(resolveDevPorts([])).toEqual({
      clientPort: DEFAULT_DEV_CLIENT_PORT,
      serverPort: DEFAULT_DEV_CLIENT_PORT + 1,
    })
  })

  test("treats --port as the client port and derives the backend port", () => {
    expect(resolveDevPorts(["--remote", "--port", "4000"])).toEqual({
      clientPort: 4000,
      serverPort: 4001,
    })
  })

  test("supports an inline client port", () => {
    expect(resolveDevPorts(["--port=4000"])).toEqual({
      clientPort: 4000,
      serverPort: 4001,
    })
  })

  test("uses the last provided --port value", () => {
    expect(resolveDevPorts(["--port", "4000", "--port", "4100"])).toEqual({
      clientPort: 4100,
      serverPort: 4101,
    })
  })

  test("throws when --port is missing a value", () => {
    expect(() => resolveDevPorts(["--port"])).toThrow("Missing value for --port")
    expect(() => resolveDevPorts(["--port", "--remote"])).toThrow("Missing value for --port")
  })
})

describe("stripPortArg", () => {
  test("removes --port and its value while preserving server arguments", () => {
    expect(stripPortArg(["--remote", "--port", "4000", "--host", "dev-box"])).toEqual([
      "--remote",
      "--host",
      "dev-box",
    ])
  })

  test("removes an inline --port while preserving server arguments", () => {
    expect(stripPortArg(["--remote", "--port=4000", "--host=dev-box"])).toEqual([
      "--remote",
      "--host=dev-box",
    ])
  })
})

describe("parseDevArgs", () => {
  test("uses loopback interfaces by default", () => {
    expect(parseDevArgs(["--port", "3333"], "dev-machine")).toEqual({
      clientPort: 3333,
      serverPort: 3334,
      clientHost: "127.0.0.1",
      backendTargetHost: "127.0.0.1",
      allowedHosts: ["localhost", "127.0.0.1", "dev-machine"],
      serverArgs: [],
    })
  })

  test("keeps direct remote listening available when explicitly requested", () => {
    expect(parseDevArgs(["--remote", "--port", "3333"], "dev-machine")).toEqual({
      clientPort: 3333,
      serverPort: 3334,
      clientHost: "0.0.0.0",
      backendTargetHost: "127.0.0.1",
      allowedHosts: true,
      serverArgs: ["--remote"],
    })
  })

  test("keeps development listeners on loopback while allowing an explicit trusted proxy host", () => {
    expect(parseDevArgs(["--trust-proxy", "--port", "3333"], "dev-machine")).toEqual({
      clientPort: 3333,
      serverPort: 3334,
      clientHost: "127.0.0.1",
      backendTargetHost: "127.0.0.1",
      allowedHosts: true,
      serverArgs: ["--trust-proxy"],
    })
  })

  test("uses a specific host for the Vite listener and backend proxy", () => {
    expect(parseDevArgs(["--host", "dev-box", "--port", "3333"], "dev-machine")).toEqual({
      clientPort: 3333,
      serverPort: 3334,
      clientHost: "dev-box",
      backendTargetHost: "dev-box",
      allowedHosts: ["localhost", "127.0.0.1", "dev-machine", "dev-box"],
      serverArgs: ["--host", "dev-box"],
    })
  })

  test("supports an inline host for the Vite listener and backend proxy", () => {
    expect(parseDevArgs(["--host=dev-box", "--port=3333"], "dev-machine")).toEqual({
      clientPort: 3333,
      serverPort: 3334,
      clientHost: "dev-box",
      backendTargetHost: "dev-box",
      allowedHosts: ["localhost", "127.0.0.1", "dev-machine", "dev-box"],
      serverArgs: ["--host=dev-box"],
    })
  })

  test("rejects removed built-in tunnel options", () => {
    expect(() => parseDevArgs(["--share"], "dev-machine")).toThrow("--share is no longer built in")
    expect(() => parseDevArgs(["--cloudflared", "token"], "dev-machine")).toThrow("--cloudflared is no longer built in")
  })
})
