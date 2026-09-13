import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildLocalFileContentUrl } from "../shared/local-file-urls"
import { buildProjectFileContentUrl } from "../shared/project-file-urls"
import { startStillOnServer } from "./server"
import { getProjectUploadDir } from "./paths"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function startDownloadServer() {
  const directory = await mkdtemp(path.join(tmpdir(), "stillon-download-headers-"))
  tempDirs.push(directory)
  const server = await startStillOnServer({
    dataDir: path.join(directory, "data"),
    port: 4460,
    strictPort: false,
    openBrowser: false,
  })
  const project = await server.store.openProject(directory, "Downloads")
  return { server, project, directory, baseUrl: `http://127.0.0.1:${server.port}` }
}

function expectDownloadHeader(response: Response, fileName: string) {
  expect(response.status).toBe(200)
  const disposition = response.headers.get("content-disposition") ?? ""
  expect(disposition).toStartWith("attachment; filename=\"")
  expect(disposition).toMatch(/^[\x20-\x7e]+$/)
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1]
  expect(encodedName).toBeDefined()
  expect(decodeURIComponent(encodedName!)).toBe(fileName)
  if (/^[\x20-\x7e]+$/.test(fileName)) {
    expect(disposition).toContain(`filename="${fileName}"`)
  }
}

describe("download response filenames", () => {
  test.each([
    "report.xlsx",
    "report 2026.xlsx",
    "中文报告.xlsx",
    "café.xlsx",
    "📊报告 (Q1)'s.xlsx",
  ])("serves project downloads and HEAD requests for %s", async (fileName) => {
    const { server, project, directory, baseUrl } = await startDownloadServer()
    const contents = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])
    try {
      await writeFile(path.join(directory, fileName), contents)
      const contentUrl = `${baseUrl}${buildProjectFileContentUrl(project.id, fileName, { download: true })}`
      const response = await fetch(contentUrl)
      expectDownloadHeader(response, fileName)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(contents)

      const head = await fetch(contentUrl, { method: "HEAD" })
      expectDownloadHeader(head, fileName)
      expect(await head.text()).toBe("")
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  test("preserves non-ASCII names when downloading uploaded attachments", async () => {
    const { server, project, directory, baseUrl } = await startDownloadServer()
    try {
      const fileName = "附件 résumé.txt"
      const uploadDir = getProjectUploadDir(directory)
      await mkdir(uploadDir, { recursive: true })
      await writeFile(path.join(uploadDir, fileName), "attachment contents", "utf8")
      const response = await fetch(`${baseUrl}/api/projects/${project.id}/uploads/${encodeURIComponent(fileName)}/content?download=1`)
      expectDownloadHeader(response, fileName)
      expect(await response.text()).toBe("attachment contents")
    } finally {
      await server.stop()
    }
  })

  test("preserves non-ASCII names when downloading local Markdown", async () => {
    const { server, directory, baseUrl } = await startDownloadServer()
    try {
      const fileName = "使用说明.md"
      const filePath = path.join(directory, fileName)
      await writeFile(filePath, "# Local documentation\n", "utf8")
      const response = await fetch(`${baseUrl}${buildLocalFileContentUrl(filePath, { download: true })}`)
      expectDownloadHeader(response, fileName)
      expect(await response.text()).toBe("# Local documentation\n")
    } finally {
      await server.stop()
    }
  })
})
