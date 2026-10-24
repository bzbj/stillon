import { expect, test } from "bun:test"
import { DESKTOP_WAIT_MS, openDesktopBrowser, waitForDesktopTransition } from "./desktop-progress"

test("Explorer exit 1 is a successful shell handoff and does not open a second tab", async () => {
  const calls: string[] = [], warnings: string[] = []
  await openDesktopBrowser(3210, { platform: "win32", run: async (command, args) => {
    calls.push(command, ...args); return { code: 1, signal: null, stdout: "", stderr: "" }
  }, warn: message => { warnings.push(message) } })
  expect(calls).toEqual(["explorer.exe", "http://127.0.0.1:3210"])
  expect(warnings).toEqual([])
})

test("browser failures on either desktop platform preserve startup success and provide the URL", async () => {
  for (const platform of ["win32", "darwin"] as const) {
    for (const throws of [false, true]) {
      const warnings: string[] = []
      await openDesktopBrowser(3210, { platform, run: async () => {
        if (throws) throw new Error("private installer output")
        return { code: 2, signal: null, stdout: "private installer output", stderr: "" }
      }, warn: message => { warnings.push(message) } })
      expect(warnings).toEqual(["StillOn is ready. Open http://127.0.0.1:3210 in your browser."])
    }
  }
})

test("a slow independent upgrade can take more than three minutes and reports phase progress", async () => {
  let elapsed = 0
  const messages: string[] = []
  await waitForDesktopTransition("unused", { now: () => elapsed, sleep: async () => { elapsed += 60_000 },
    read: async () => ({ phase: elapsed >= 4 * 60_000 ? "succeeded" : elapsed ? "switching" : "queued" }),
    progress: message => { messages.push(message) } })
  expect(elapsed).toBe(240_000)
  expect(messages).toHaveLength(3)
  expect(messages.at(-1)).toContain("ready")
})

test("upgrade failures are immediate, and a pending timeout explains that the worker continues", async () => {
  for (const phase of ["failed", "rolled-back", "recovery-required"] as const) {
    await expect(waitForDesktopTransition("unused", { read: async () => ({ phase, error: "Recovery required" }) })).rejects.toThrow("Recovery required")
  }
  let elapsed = 0
  await expect(waitForDesktopTransition("unused", { now: () => elapsed, sleep: async () => { elapsed += DESKTOP_WAIT_MS },
    read: async () => ({ phase: "switching" }), progress: () => {} })).rejects.toThrow("still updating in the background")
})
