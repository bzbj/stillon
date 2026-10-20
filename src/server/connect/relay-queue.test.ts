import { expect, test } from "bun:test"
import { RelayQueue } from "./relay-queue"

test("transient congestion preserves frame order and never retries an accepted buffered frame", async () => {
  let buffered = 0, writable = false, failed = false
  const received: string[] = []
  const queue = new RelayQueue({ highWaterMark: 10, stallMs: 200,
    buffered: () => buffered,
    write: message => { if (!writable) return false; received.push(String(message)); buffered += String(message).length; return true },
    fail: () => { failed = true },
  })
  try {
    queue.push("1234567890")
    queue.push("next")
    writable = true
    await Bun.sleep(40)
    expect(received).toEqual(["1234567890"])
    expect(failed).toBe(false)
    buffered = 0
    queue.flush()
    expect(received).toEqual(["1234567890", "next"])
    buffered = 0
    queue.flush()
    expect(failed).toBe(false)
  } finally { queue.dispose() }
})

test("repeated full-size messages are permitted; actual stalled backlog expires", async () => {
  let received = 0, failed = false, buffered = 0
  const queue = new RelayQueue({ highWaterMark: 10 * 1024 * 1024, stallMs: 60,
    buffered: () => buffered, write: () => { received++; return true }, fail: () => { failed = true },
  })
  try {
    const message = new ArrayBuffer(5 * 1024 * 1024)
    for (let i = 0; i < 20; i++) queue.push(message)
    expect(received).toBe(20)
    expect(failed).toBe(false)
    buffered = 10 * 1024 * 1024
    queue.push(message)
    await Bun.sleep(110)
    expect(received).toBe(20)
    expect(failed).toBe(true)
  } finally { queue.dispose() }
})
