import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSpinDetector, recordSpinRestart, spinRestartAllowed, type CpuSample } from "./spin-watchdog"

function fakeClock(cpuPerSecond: () => number) {
  const current: CpuSample = { cpuMicros: 0, wallMs: 0 }
  return {
    sample: () => ({ ...current }),
    advance(seconds: number) {
      for (let i = 0; i < seconds; i++) {
        current.wallMs += 1_000
        current.cpuMicros += cpuPerSecond() * 1_000_000
      }
    },
  }
}

test("reports a spin only after consecutive busy windows", () => {
  let load = 0.95
  const clock = fakeClock(() => load)
  const detector = createSpinDetector({ windowMs: 10_000, windows: 3, threshold: 0.5, sample: clock.sample })
  for (let window = 1; window <= 2; window++) {
    clock.advance(10)
    expect(detector.observe()).toBe(false)
  }
  clock.advance(5)
  expect(detector.observe()).toBe(false)
  clock.advance(5)
  expect(detector.observe()).toBe(true)
  expect(detector.ratio).toBeCloseTo(0.95)
  // A quiet window clears the condition.
  load = 0.01
  clock.advance(10)
  expect(detector.observe()).toBe(false)
})

test("ordinary controller activity is not a spin", () => {
  let tick = 0
  // Short bursts (a process-table scan) inside an otherwise idle minute.
  const clock = fakeClock(() => (++tick % 30 === 0 ? 0.8 : 0.01))
  const detector = createSpinDetector({ sample: clock.sample })
  for (let minute = 0; minute < 30; minute++) {
    clock.advance(60)
    expect(detector.observe()).toBe(false)
  }
})

test("automatic restarts respect the cooldown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-spin-"))
  try {
    const now = Date.parse("2026-11-13T12:00:00Z")
    expect(await spinRestartAllowed(root, now)).toBe(true)
    await recordSpinRestart(root, 0.93, now)
    expect(await spinRestartAllowed(root, now + 60 * 60 * 1000)).toBe(false)
    expect(await spinRestartAllowed(root, now + 7 * 60 * 60 * 1000)).toBe(true)
    // A clock moved backwards must not block recovery forever.
    expect(await spinRestartAllowed(root, now - 60_000)).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
