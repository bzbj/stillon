import { describe, expect, test } from "bun:test"
import {
  canOpenTranscriptFilesOnHost,
  resolveTranscriptLocalFileDisposition,
} from "./transcriptLocalLinkPolicy"

describe("transcript local link policy", () => {
  test("previews status JSON and text inside the workspace on Mac, Windows and remote clients", () => {
    for (const hostname of ["127.0.0.1", "localhost", "stillon.example.com"]) {
      for (const filePath of ["/workspace/output/status.json", "C:/workspace/中文 folder/status.json", "/workspace/app.ts", "/workspace/.gitignore"]) {
        expect(resolveTranscriptLocalFileDisposition({hostname,filePath,isProjectFile:true})).toBe("preview")
      }
    }
    expect(resolveTranscriptLocalFileDisposition({hostname:"localhost",filePath:"/outside/status.json",isProjectFile:false})).toBe("preview")
    expect(resolveTranscriptLocalFileDisposition({hostname:"stillon.example.com",filePath:"/outside/status.json",isProjectFile:false})).toBe("preview")
  })
  test("detects loopback access on macOS and Windows clients", () => {
    expect(canOpenTranscriptFilesOnHost("127.0.0.1")).toBe(true)
    expect(canOpenTranscriptFilesOnHost("localhost")).toBe(true)
    expect(canOpenTranscriptFilesOnHost("::1")).toBe(true)
    expect(canOpenTranscriptFilesOnHost("[::1]")).toBe(true)
  })

  test("treats public hosts and LAN addresses as remote access", () => {
    expect(canOpenTranscriptFilesOnHost("stillon.example.com")).toBe(false)
    expect(canOpenTranscriptFilesOnHost("192.168.1.20")).toBe(false)
  })

  test("previews HTML and Markdown identically during local and remote access", () => {
    for (const hostname of ["localhost", "stillon.example.com"]) {
      expect(resolveTranscriptLocalFileDisposition({ hostname, filePath: "/project/report.html", isProjectFile: true })).toBe("preview")
      expect(resolveTranscriptLocalFileDisposition({ hostname, filePath: "C:/project/README.md", isProjectFile: true })).toBe("preview")
    }
  })

  test("opens other files on the host only during loopback access", () => {
    expect(resolveTranscriptLocalFileDisposition({ hostname: "localhost", filePath: "/project/report.pdf", isProjectFile: true })).toBe("open_host")
    expect(resolveTranscriptLocalFileDisposition({ hostname: "127.0.0.1", filePath: "C:/project/report.xlsx", isProjectFile: true })).toBe("open_host")
  })

  test("routes project and authorized host-file downloads through the server during remote access", () => {
    expect(resolveTranscriptLocalFileDisposition({ hostname: "stillon.example.com", filePath: "/project/report.pdf", isProjectFile: true })).toBe("download")
    expect(resolveTranscriptLocalFileDisposition({ hostname: "stillon.example.com", filePath: "C:/temp/report.xlsx", isProjectFile: false })).toBe("download")
  })
})
