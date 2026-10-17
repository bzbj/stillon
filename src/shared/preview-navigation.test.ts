import { expect, test } from "bun:test"
import { PREVIEW_NAVIGATION_MESSAGE, projectPreviewNavigationAddress } from "./preview-navigation"

test("sandbox link navigation stays in the current workspace preview folder", () => {
  const current = "/api/projects/workspace/preview/reports/index.html"
  const message = (address: string) => ({ type: PREVIEW_NAVIGATION_MESSAGE, address })
  expect(projectPreviewNavigationAddress(message("/api/projects/workspace/preview/reports/chart.png"), current))
    .toBe("/api/projects/workspace/preview/reports/chart.png")
  expect(projectPreviewNavigationAddress(message("/api/projects/workspace/preview/reports/next%20report.html#details"), current))
    .toBe("/api/projects/workspace/preview/reports/next%20report.html#details")
  for (const address of [
    "/api/projects/other/preview/reports/chart.png", "/api/projects/workspace/preview/private.json",
    "/api/projects/workspace/preview/reports-other/chart.png", "/api/projects/workspace/preview/reports/.env",
    "/api/projects/workspace/preview/reports/%2e%2e%2fprivate.json", "/api/projects/workspace/preview/reports/hidden%5c.env",
    "/auth/logout", "/api/projects/workspace/files/reports%2Fchart.png/content", "//other.example/chart.png",
    "https://other.example/chart.png", "javascript:alert(1)", "data:text/html,content",
  ]) expect(projectPreviewNavigationAddress(message(address), current)).toBeNull()
  expect(projectPreviewNavigationAddress(message("/api/projects/workspace/preview/reports/chart.png"), "/api/projects/workspace/preview/reports/chart.png")).toBeNull()
  for (const data of [null, {}, { type: PREVIEW_NAVIGATION_MESSAGE }, { type: "other", address: current }]) {
    expect(projectPreviewNavigationAddress(data, current)).toBeNull()
  }
})
