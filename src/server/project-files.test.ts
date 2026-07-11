import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildLocalFileContentUrl } from "../shared/local-file-urls"
import { startStillOnServer } from "./server"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function startProjectFileServer() {
  const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-files-"))
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-project-files-data-"))
  tempDirs.push(projectDir, dataDir)
  const server = await startStillOnServer({
    dataDir,
    port: 4460,
    strictPort: false,
    openBrowser: false,
  })
  const project = await server.store.openProject(projectDir, "Project")
  return { server, project, projectDir }
}

describe("project file routes", () => {
  test("serves project files for preview and download", async () => {
    const { server, project, projectDir } = await startProjectFileServer()

    try {
      await mkdir(path.join(projectDir, "dist"), { recursive: true })
      await writeFile(
        path.join(projectDir, "dist", "index.html"),
        "<!doctype html><title>Generated</title><script src=\"./app.js\"></script>",
        "utf8"
      )
      await writeFile(path.join(projectDir, "dist", "app.js"), "console.log('preview')", "utf8")

      const previewResponse = await fetch(`http://localhost:${server.port}/api/projects/${project.id}/preview/dist/index.html`)
      expect(previewResponse.status).toBe(200)
      expect(previewResponse.headers.get("content-type")).toBe("text/html; charset=utf-8")
      expect(previewResponse.headers.get("content-security-policy")).toContain("sandbox")
      expect(await previewResponse.text()).toContain("<title>Generated</title>")

      const scriptResponse = await fetch(`http://localhost:${server.port}/api/projects/${project.id}/preview/dist/app.js`)
      expect(scriptResponse.status).toBe(200)
      expect(scriptResponse.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
      expect(await scriptResponse.text()).toBe("console.log('preview')")

      const contentUrl = `http://localhost:${server.port}/api/projects/${project.id}/files/${encodeURIComponent("dist/index.html")}/content`
      const contentResponse = await fetch(contentUrl)
      expect(contentResponse.status).toBe(200)
      expect(contentResponse.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(contentResponse.headers.get("content-disposition")).toBeNull()

      const downloadResponse = await fetch(`${contentUrl}?download=1`)
      expect(downloadResponse.status).toBe(200)
      expect(downloadResponse.headers.get("content-disposition")).toContain("attachment")
      expect(downloadResponse.headers.get("content-disposition")).toContain("index.html")

      const traversalResponse = await fetch(`http://localhost:${server.port}/api/projects/${project.id}/preview/..%2Fsecret.txt`)
      expect(traversalResponse.status).toBe(400)
    } finally {
      await server.stop()
    }
  })

  test("serves local markdown files through the local file content route", async () => {
    const localDir = await mkdtemp(path.join(tmpdir(), "kanna-local-markdown-"))
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-local-markdown-data-"))
    tempDirs.push(localDir, dataDir)
    const markdownPath = path.join(localDir, "SKILL.md")
    const envPath = path.join(localDir, ".env")
    await writeFile(markdownPath, "# Skill\n\nBody", "utf8")
    await writeFile(envPath, "SECRET=1", "utf8")

    const server = await startStillOnServer({
      dataDir,
      port: 4460,
      strictPort: false,
      openBrowser: false,
    })

    try {
      const markdownResponse = await fetch(`http://localhost:${server.port}${buildLocalFileContentUrl(markdownPath)}`)
      expect(markdownResponse.status).toBe(200)
      expect(markdownResponse.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
      expect(await markdownResponse.text()).toBe("# Skill\n\nBody")

      const envResponse = await fetch(`http://localhost:${server.port}${buildLocalFileContentUrl(envPath)}`)
      expect(envResponse.status).toBe(400)
    } finally {
      await server.stop()
    }
  })
})
