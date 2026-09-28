import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { TextMessage } from "../client/components/messages/TextMessage"
import { OpenLocalLinkProvider } from "../client/components/messages/shared"
import { startStillOnServer } from "./server"

const dirs: string[] = []
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8mQAAAAASUVORK5CYII=", "base64")

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function imageSrc(filePath: string, projectId: string, localPath: string) {
  const html = renderToStaticMarkup(
    <OpenLocalLinkProvider projectId={projectId} localPath={localPath}>
      <TextMessage message={{
        id: "image",
        kind: "assistant_text",
        text: `![chart](<${filePath}>)`,
        timestamp: "2026-09-28T00:00:00Z",
      }} />
    </OpenLocalLinkProvider>
  )
  const src = html.match(/<img[^>]*src="([^"]+)"/)?.[1]
  expect(src).toBeDefined()
  return src!
}

describe("chat image content", () => {
  for (const password of [undefined, "image-test-password"]) {
    test(`serves rendered images locally and remotely ${password ? "with authentication" : "on a private network"}`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "stillon-chat-images-"))
      dirs.push(root)
      const projectDir = path.join(root, "project")
      await mkdir(projectDir)
      const filePath = path.join(projectDir, "图片 chart.png")
      const externalPath = path.join(root, "external.png")
      await writeFile(filePath, png)
      await writeFile(externalPath, png)
      const server = await startStillOnServer({
        dataDir: path.join(root, "data"),
        port: 4490,
        strictPort: false,
        openBrowser: false,
        password,
      })
      try {
        const project = await server.store.openProject(projectDir, "Image test")
        const src = imageSrc(filePath, project.id, projectDir)
        expect(src).toStartWith(`/api/projects/${project.id}/files/`)
        const externalSrc = imageSrc(externalPath, project.id, projectDir)
        const base = `http://127.0.0.1:${server.port}`
        for (const host of [`127.0.0.1:${server.port}`, "stillon.example.com"]) {
          const headers: Record<string, string> = { Host: host }
          if (password) {
            const unauthorized = await fetch(base + src, { headers })
            expect(unauthorized.status).toBe(401)
            const login = await fetch(base + "/auth/login", {
              method: "POST",
              headers: { ...headers, "Content-Type": "application/json", Origin: `http://${host}` },
              body: JSON.stringify({ password }),
            })
            expect(login.status).toBe(200)
            headers.Cookie = login.headers.get("set-cookie")!.split(";")[0]
          }
          const response = await fetch(base + src, { headers })
          expect(response.status).toBe(200)
          expect(response.headers.get("content-type")).toBe("image/png")
          expect(Buffer.from(await response.arrayBuffer())).toEqual(png)

          const external = await fetch(base + externalSrc, { headers })
          expect(external.status).toBe(password || host.startsWith("127.") ? 200 : 403)
        }
      } finally {
        await server.stop()
      }
    })
  }
})
