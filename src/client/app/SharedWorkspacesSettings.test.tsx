import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SharedWorkspaceList } from "./SharedWorkspacesSettings"
import type { SharedWorkspaceEntry } from "../../shared/connect"
const entry: SharedWorkspaceEntry = { id: "member-a", hostId: "host-a", machineName: "Example computer", workspaceId: "project-a", workspaceName: "Example workspace", name: "Example computer - Example workspace", online: true, accepted: true, url: "https://w-example.connect.example.com", invitationUrl: "https://connect.example.com/invite?id=member-a" }
test("accepted workspaces switch through the existing authorization flow; current workspace has no switch link", () => {
  const html = renderToStaticMarkup(<SharedWorkspaceList workspaces={[entry]} currentOrigin="http://localhost:3000" />)
  expect(html).toContain(`${entry.url}/_connect/login`)
  expect(html).toContain('>Switch</a>')
  expect(html).toContain(entry.name)
  const current = renderToStaticMarkup(<SharedWorkspaceList workspaces={[entry]} currentOrigin={entry.url} />)
  expect(current).toContain("Current workspace")
  expect(current).not.toContain("href=")
})
test("pending invitations use acceptance flow and offline status is retained", () => {
  const html = renderToStaticMarkup(<SharedWorkspaceList workspaces={[{ ...entry, accepted: false, online: false }]} currentOrigin="http://localhost:3000" />)
  expect(html).toContain(entry.invitationUrl)
  expect(html).toContain("Accept invitation")
  expect(html).toContain("Offline")
  expect(html).not.toContain("/_connect/login")
})
test("empty list has an explicit empty state", () => {
  expect(renderToStaticMarkup(<SharedWorkspaceList workspaces={[]} currentOrigin="" />)).toContain("No workspaces shared with you.")
})
