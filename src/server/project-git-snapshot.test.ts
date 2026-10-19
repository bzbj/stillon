import { expect, test } from "bun:test"
import { CONNECT_MAX_WS_BYTES } from "../shared/connect"
import type { ChatDiffSnapshot } from "../shared/types"
import { handleProjectGitSnapshotRequest, projectGitSnapshotForTransport } from "./project-git-snapshot"

const large: ChatDiffSnapshot = {
  status: "ready",
  files: Array.from({ length: 9_200 }, (_, index) => ({
    path: `workspace/vendor/${"example-".repeat(16)}/file-${index}.ts`, changeType: "added", isUntracked: true,
    additions: index, deletions: 0, patchDigest: "a".repeat(64),
  })),
}

test("large Git lists use a bounded negotiated descriptor without dropping files", async () => {
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(CONNECT_MAX_WS_BYTES)
  const deferred = projectGitSnapshotForTransport(large, true)
  expect(deferred && "deferred" in deferred && typeof deferred.revision === "string").toBe(true)
  expect(Buffer.byteLength(JSON.stringify(deferred))).toBeLessThan(1024)
  expect(projectGitSnapshotForTransport(large, true)).toEqual(deferred)
  expect(projectGitSnapshotForTransport({ ...large, branchName: "feature/example" }, true)).not.toEqual(deferred)
  const url = new URL("http://localhost/api/projects/example/git-snapshot")
  const response = handleProjectGitSnapshotRequest(new Request(url), url, id => id === "example" ? large : null)!
  expect(response.status).toBe(200)
  expect(response.headers.get("Cache-Control")).toBe("no-store")
  expect(await response.json()).toEqual(large)
})

test("small Git snapshots and unnegotiated clients retain the existing wire shape", () => {
  const small: ChatDiffSnapshot = { status: "ready", files: [] }
  expect(projectGitSnapshotForTransport(small, true)).toBe(small)
  expect(projectGitSnapshotForTransport(large)).toBe(large)
  expect(projectGitSnapshotForTransport(null, true)).toBeNull()
})

test("Git HTTP reads reject missing workspaces, malformed IDs and writes", () => {
  const read = (path: string, method = "GET") => {
    const url = new URL(path, "http://localhost")
    return handleProjectGitSnapshotRequest(new Request(url, { method }), url, () => null)
  }
  expect(read("/api/projects/missing/git-snapshot")?.status).toBe(404)
  expect(read("/api/projects/%ZZ/git-snapshot")?.status).toBe(400)
  expect(read("/api/projects/example/git-snapshot", "POST")?.status).toBe(405)
  expect(read("/api/other")).toBeNull()
})
