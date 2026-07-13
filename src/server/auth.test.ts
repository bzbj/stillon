import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAuthManager } from "./auth"
import { persistProjectUpload } from "./uploads"
import { startStillOnServer } from "./server"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function startPasswordServer(options: { password?: string; trustProxy?: boolean; port?: number } = {}) {
  const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-auth-test-"))
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-auth-data-"))
  tempDirs.push(projectDir)
  tempDirs.push(dataDir)
  const server = await startStillOnServer({
    dataDir,
    port: options.port ?? 4320,
    strictPort: true,
    password: options.password ?? "secret",
    trustProxy: options.trustProxy ?? false,
  })
  const project = await server.store.openProject(projectDir, "Project")
  return { server, projectDir, project }
}

function extractCookie(response: Response) {
  const header = response.headers.get("set-cookie")
  expect(header).toBeTruthy()
  return header!.split(";", 1)[0]
}

async function waitForWebSocketOpen(socket: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for WebSocket connection"))
    }, 2_000)

    socket.addEventListener("open", () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
    socket.addEventListener("error", () => {
      clearTimeout(timeout)
      reject(new Error("WebSocket connection failed"))
    }, { once: true })
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout)
      reject(new Error(`WebSocket closed before opening (${event.code})`))
    }, { once: true })
  })
}

function openWebSocketWithHeaders(url: string, headers: NonNullable<Bun.WebSocketOptions["headers"]>) {
  // The client app includes DOM types, while Bun supports test-only headers.
  const BunWebSocket = WebSocket as unknown as {
    new (url: string, options?: Bun.WebSocketOptions): WebSocket
  }
  return new BunWebSocket(url, { headers })
}

describe("password auth", () => {
  test("uses X-Forwarded-For for trusted-proxy login rate limits", async () => {
    const auth = createAuthManager("secret", { trustProxy: true })

    function failedLogin(clientIp: string) {
      return auth.handleLogin(new Request("https://stillon.example.test/auth/login", {
        method: "POST",
        body: JSON.stringify({ password: "wrong" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://stillon.example.test",
          "X-Forwarded-For": clientIp,
        },
      }), "/")
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await failedLogin("198.51.100.10")).status).toBe(401)
    }
    expect((await failedLogin("198.51.100.10")).status).toBe(429)
    expect((await failedLogin("198.51.100.11")).status).toBe(401)
  })

  test("serves the app shell to unauthenticated browser requests", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/chat/demo`, { headers: { Accept: "text/html" } })
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(await response.text()).toContain('id="root"')
    } finally {
      await server.stop()
    }
  })

  test("serves health checks without authentication", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/health`, { redirect: "manual" })
      expect(response.status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  test("blocks unauthenticated api requests", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/api/projects/project-1/uploads`, { redirect: "manual" })
      expect(response.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  test("redirects /auth/login back into the app", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login?next=%2Fchat%2Fdemo`, { redirect: "manual" })
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(`http://localhost:${server.port}/chat/demo`)
    } finally {
      await server.stop()
    }
  })

  test("sets a session cookie after a successful login", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })

      expect(response.status).toBe(200)
      expect(extractCookie(response)).toContain("stillon_session=")
    } finally {
      await server.stop()
    }
  })

  test("accepts a one-character application password", async () => {
    const { server } = await startPasswordServer({ password: "x" })

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "x", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })

      expect(response.status).toBe(200)
      expect(extractCookie(response)).toContain("stillon_session=")
    } finally {
      await server.stop()
    }
  })

  test("rejects an invalid password", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "wrong", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })

      expect(response.status).toBe(401)
      expect(response.headers.get("set-cookie")).toBeNull()
    } finally {
      await server.stop()
    }
  })

  test("rate limits repeated invalid passwords", async () => {
    const { server } = await startPasswordServer()

    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await fetch(`http://localhost:${server.port}/auth/login`, {
          method: "POST",
          body: JSON.stringify({ password: "wrong" }),
          headers: {
            "Content-Type": "application/json",
            Origin: `http://localhost:${server.port}`,
          },
        })
        expect(response.status).toBe(401)
      }

      const limitedResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "wrong" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })
      expect(limitedResponse.status).toBe(429)
      expect(Number(limitedResponse.headers.get("retry-after"))).toBeGreaterThan(0)
    } finally {
      await server.stop()
    }
  })

  test("rejects cross-origin login attempts", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil.test",
        },
      })

      expect(response.status).toBe(403)
    } finally {
      await server.stop()
    }
  })

  test("allows authenticated access to protected routes", async () => {
    const { server, project, projectDir } = await startPasswordServer()

    try {
      const attachment = await persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "hello.txt",
        bytes: new TextEncoder().encode("hello from upload"),
        fallbackMimeType: "text/plain",
      })

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })
      const cookie = extractCookie(loginResponse)

      const healthResponse = await fetch(`http://localhost:${server.port}/health`, {
        headers: {
          Cookie: cookie,
        },
      })
      expect(healthResponse.status).toBe(200)

      const contentResponse = await fetch(`http://localhost:${server.port}${attachment.contentUrl}`, {
        headers: {
          Cookie: cookie,
        },
      })
      expect(contentResponse.status).toBe(200)
      expect(await contentResponse.text()).toBe("hello from upload")
    } finally {
      await server.stop()
    }
  })

  test("ignores forwarded proto when trustProxy is off", async () => {
    const { server } = await startPasswordServer({ port: 54321 })

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login?next=%2F`, {
        redirect: "manual",
        headers: {
          "X-Forwarded-Proto": "https",
        },
      })
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(`http://localhost:${server.port}/`)

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.test",
          "X-Forwarded-Proto": "https",
        },
      })
      expect(loginResponse.status).toBe(403)

      const goodLoginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
          "X-Forwarded-Proto": "https",
        },
      })
      expect(goodLoginResponse.status).toBe(200)
      const cookieHeader = goodLoginResponse.headers.get("set-cookie") ?? ""
      expect(cookieHeader).not.toContain("Secure")
    } finally {
      await server.stop()
    }
  })

  test("honors forwarded proto when trustProxy is on", async () => {
    const { server } = await startPasswordServer({ port: 54322, trustProxy: true })

    try {
      const redirect = await fetch(`http://localhost:${server.port}/auth/login?next=%2F`, {
        redirect: "manual",
        headers: {
          "X-Forwarded-Proto": "https",
        },
      })
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get("location")).toBe(`https://localhost:${server.port}/`)

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `https://localhost:${server.port}`,
          "X-Forwarded-Proto": "https",
        },
      })
      expect(loginResponse.status).toBe(200)
      expect(loginResponse.headers.get("set-cookie") ?? "").toContain("Secure")

      const evilResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })
      expect(evilResponse.status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  test("honors the public Host supplied by a trusted proxy", async () => {
    const { server } = await startPasswordServer({ port: 54324, trustProxy: true })
    const publicHost = "stillon.example.test"

    try {
      const redirect = await fetch(`http://127.0.0.1:${server.port}/auth/login?next=%2Fchat%2Fdemo`, {
        redirect: "manual",
        headers: {
          Host: publicHost,
          "X-Forwarded-Host": "attacker.example.test",
          "X-Forwarded-Proto": "https",
        },
      })
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get("location")).toBe(`https://${publicHost}/chat/demo`)

      const loginResponse = await fetch(`http://127.0.0.1:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Host: publicHost,
          Origin: `https://${publicHost}`,
          "X-Forwarded-Host": "attacker.example.test",
          "X-Forwarded-Proto": "https",
        },
      })
      expect(loginResponse.status).toBe(200)
      expect(loginResponse.headers.get("set-cookie") ?? "").toContain("Secure")
    } finally {
      await server.stop()
    }
  })

  test("accepts an authenticated WebSocket through a trusted public host", async () => {
    const { server } = await startPasswordServer({ port: 54325, trustProxy: true })
    const publicHost = "stillon.example.test"

    try {
      const loginResponse = await fetch(`http://127.0.0.1:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Host: publicHost,
          Origin: `https://${publicHost}`,
          "X-Forwarded-Proto": "https",
        },
      })
      const cookie = extractCookie(loginResponse)

      const socket = openWebSocketWithHeaders(`ws://127.0.0.1:${server.port}/ws`, {
        Host: publicHost,
        Origin: `https://${publicHost}`,
        Cookie: cookie,
        "X-Forwarded-Proto": "https",
      })
      await waitForWebSocketOpen(socket)
      socket.close()
    } finally {
      await server.stop()
    }
  })

  test("ignores invalid forwarded proto values", async () => {
    const { server } = await startPasswordServer({ port: 54323, trustProxy: true })

    try {
      const redirect = await fetch(`http://localhost:${server.port}/auth/login?next=%2F`, {
        redirect: "manual",
        headers: {
          "X-Forwarded-Proto": "ftp",
        },
      })
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get("location")).toBe(`http://localhost:${server.port}/`)

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
          "X-Forwarded-Proto": "ftp",
        },
      })
      expect(loginResponse.status).toBe(200)
      expect(loginResponse.headers.get("set-cookie") ?? "").not.toContain("Secure")
    } finally {
      await server.stop()
    }
  })

  test("clears the session cookie on logout", async () => {
    const { server } = await startPasswordServer()

    try {
      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })
      const cookie = extractCookie(loginResponse)

      const logoutResponse = await fetch(`http://localhost:${server.port}/auth/logout`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: `http://localhost:${server.port}`,
        },
      })

      expect(logoutResponse.status).toBe(200)
      expect(logoutResponse.headers.get("set-cookie")).toContain("Max-Age=0")

      const healthResponse = await fetch(`http://localhost:${server.port}/health`, {
        headers: {
          Cookie: cookie,
        },
      })
      expect(healthResponse.status).toBe(200)
    } finally {
      await server.stop()
    }
  })
})
