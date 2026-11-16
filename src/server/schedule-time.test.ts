import { expect, test } from "bun:test"
import { nextScheduleTime, validateTimeZone } from "./schedule-time"
const t = (value: string) => Date.parse(value)
test("one-time tasks are consumed once", () => {
  expect(nextScheduleTime({ kind: "once", at: 100 }, 99)).toBe(100)
  expect(nextScheduleTime({ kind: "once", at: 100 }, 100)).toBeNull()
})
test("workdays follow the stored zone, not the machine's zone", () => {
  const trigger = { kind: "weekly" as const, weekdays: [1, 2, 3, 4, 5], timeOfDay: "09:00", timeZone: "Asia/Singapore" }
  expect(nextScheduleTime(trigger, t("2026-11-13T01:00:00Z"))).toBe(t("2026-11-16T01:00:00Z"))
})
test("DST nonexistent time skips the day", () => {
  const trigger = { kind: "weekly" as const, weekdays: [0], timeOfDay: "02:30", timeZone: "America/New_York" }
  expect(nextScheduleTime(trigger, t("2026-03-08T00:00:00Z"))).toBe(t("2026-03-15T06:30:00Z"))
})
test("DST repeated time uses the first occurrence only", () => {
  const trigger = { kind: "weekly" as const, weekdays: [0], timeOfDay: "01:30", timeZone: "America/New_York" }
  expect(nextScheduleTime(trigger, t("2026-11-01T00:00:00Z"))).toBe(t("2026-11-01T05:30:00Z"))
  expect(nextScheduleTime(trigger, t("2026-11-01T05:45:00Z"))).toBe(t("2026-11-08T06:30:00Z"))
})
test("non-hour offsets and invalid zone", () => {
  expect(nextScheduleTime({ kind: "weekly", weekdays: [1], timeOfDay: "09:00", timeZone: "Asia/Kathmandu" }, t("2026-11-16T00:00:00Z"))).toBe(t("2026-11-16T03:15:00Z"))
  expect(() => validateTimeZone("not-a-zone")).toThrow()
})
