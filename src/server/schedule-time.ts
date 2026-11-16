import type { ScheduleTrigger } from "../shared/schedules"

const formats = new Map<string, Intl.DateTimeFormat>()
function parts(at: number, zone: string) {
  let format = formats.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    if (formats.size >= 100) formats.clear()
    formats.set(zone, format)
  }
  return Object.fromEntries(format.formatToParts(new Date(at)).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)])) as Record<string, number>
}
export function validateTimeZone(zone: string) { parts(Date.now(), zone) }
/** Wall-clock recurrence: skip nonexistent times, use only the first instant of a fold. */
export function nextScheduleTime(trigger: ScheduleTrigger, after: number): number | null {
  if (trigger.kind === "once") return trigger.at > after ? trigger.at : null
  const today = parts(after, trigger.timeZone)
  const [hour, minute] = trigger.timeOfDay.split(":").map(Number)
  for (let day = 0; day <= 8; day++) {
    const date = new Date(Date.UTC(today.year!, today.month! - 1, today.day! + day))
    if (!trigger.weekdays.includes(date.getUTCDay())) continue
    const wall = date.getTime() + hour! * 3_600_000 + minute! * 60_000
    const offsets = new Set<number>()
    for (let h = -36; h <= 36; h += 6) {
      const sample = wall + h * 3_600_000, p = parts(sample, trigger.timeZone)
      offsets.add(Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - sample)
    }
    const matches = [...offsets].map(offset => wall - offset).filter(at => {
      const p = parts(at, trigger.timeZone)
      return p.year === date.getUTCFullYear() && p.month === date.getUTCMonth() + 1 && p.day === date.getUTCDate() && p.hour === hour && p.minute === minute
    }).sort((a, b) => a - b)
    if (matches[0] !== undefined && matches[0] > after) return matches[0]
  }
  return null
}
