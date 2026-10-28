import { expect, test } from "bun:test"
import { ProofQueue } from "./proof-queue"

test("heartbeats pass queued display reads without interrupting a challenge/request pair", async () => {
  const queue = new ProofQueue(), order: string[] = []
  let finish!: () => void
  const active = queue.run(async () => { order.push("active-start"); await new Promise<void>(r => { finish = r }); order.push("active-end") }, 2)
  await Promise.resolve()
  const background = queue.run(async () => { order.push("background") }, 2)
  const mutation = queue.run(async () => { order.push("mutation") })
  const heartbeat = queue.run(async () => { order.push("heartbeat") }, 0)
  finish(); await Promise.all([active, background, mutation, heartbeat])
  expect(order).toEqual(["active-start", "active-end", "heartbeat", "mutation", "background"])
  await expect(queue.run(async () => { throw Error("failure") })).rejects.toThrow("failure")
  expect(await queue.run(async () => "recovered")).toBe("recovered")
})
