import { expect, test } from "bun:test"
import { startWorkspaceSharingRefresh } from "./workspaceSharingRefresh"
import { SHARING_REFRESH_MS as TTL } from "../../shared/sharing-cache"

test("visible pages refresh slowly, hidden pages stop, focus coalesces, and cleanup cancels timers", async () => {
  const document = Object.assign(new EventTarget(), { hidden: false }), window = new EventTarget()
  const timers = new Map<number, { callback: () => void; delay: number }>()
  let next = 0, calls = 0, finish!: () => void
  const stop = startWorkspaceSharingRefresh({ reload: async () => { calls++; await new Promise<void>(r => { finish = r }) } }, {
    document, window, random: () => 0,
    setTimeout: (callback, delay) => { const id = ++next; timers.set(id, { callback, delay }); return id as unknown as ReturnType<typeof setTimeout> },
    clearTimeout: timer => { timers.delete(timer as unknown as number) },
  })
  expect(calls).toBe(1)
  window.dispatchEvent(new Event("focus")); expect(calls).toBe(1)
  finish(); await Promise.resolve(); await Promise.resolve()
  expect([...timers.values()].map(t => t.delay)).toEqual([TTL])
  document.hidden = true; document.dispatchEvent(new Event("visibilitychange")); expect(timers.size).toBe(0)
  window.dispatchEvent(new Event("focus")); expect(calls).toBe(1)
  document.hidden = false; document.dispatchEvent(new Event("visibilitychange")); expect(calls).toBe(2)
  stop(); finish(); await Promise.resolve(); await Promise.resolve()
  expect(timers.size).toBe(0)
  window.dispatchEvent(new Event("focus")); expect(calls).toBe(2)
})

test("automatic failures retry after five, ten, then twenty minutes without a retry storm", async () => {
  const document = Object.assign(new EventTarget(), { hidden: false }), window = new EventTarget()
  let callback!: () => void, delay = 0
  const stop = startWorkspaceSharingRefresh({ reload: async () => { throw Error("offline") } }, {
    document, window, random: () => 0,
    setTimeout: (fn, ms) => { callback = fn; delay = ms; return 1 as unknown as ReturnType<typeof setTimeout> },
    clearTimeout: () => {},
  })
  for (const expected of [TTL, TTL * 2, TTL * 4, TTL * 4]) {
    await Promise.resolve(); await Promise.resolve()
    expect(delay).toBe(expected)
    callback()
  }
  stop()
})
