import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ManagedUpgradePanel } from "./ManagedUpgradePanel"
import type { ManagedUpdateStatus } from "../../shared/protocol"

function render(status: ManagedUpdateStatus) {
  return renderToStaticMarkup(<ManagedUpgradePanel targetTag="v0.3.0" initialStatus={status}
    onRead={async () => status} onRequest={async () => status} />)
}

test("Windows ARM64 installations expose the upgrade and preparation actions", () => {
  const html = render({ enabled: true, platform: "win32", architecture: "arm64" })
  expect(html).toContain("Windows")
  expect(html).toContain("ARM64")
  expect(html).toContain("Upgrade to v0.3.0")
  expect(html).toContain("Prepare only")
})

test("a pending transaction disables duplicate requests and reports recovery", () => {
  const html = render({ enabled: true, busy: true, phase: "rolling-back" })
  expect(html).toContain("Restoring the previous version")
  expect(html.match(/disabled=""/g)).toHaveLength(2)
})

test("custom installations keep analysis available without offering an unsupported upgrade", () => {
  const html = render({ enabled: false, message: "Native service setup is required." })
  expect(html).toContain("stillon update setup")
  expect(html).toContain("Installation analysis remains available")
  expect(html).not.toContain("Upgrade to v0.3.0")
})
