import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { RemoteOperations } from "./operations"
import { randomId } from "./crypto"

test("remote commands are durable, scoped, conflict checked and never replayed after a crash", async () => {
  await mkdir("test-artifacts/connect", { recursive: true })
  const directory = await mkdtemp(path.resolve("test-artifacts/connect/operations-"))
  let now = Date.now()
  let store = new RemoteOperations(directory, () => now)
  try {
    const id = `${now}-${randomId()}`, command = { type: "chat.rename", chatId: "example", title: "Title" } as const
    expect(store.begin("owner-a", id, command)).toBeNull()
    expect(store.begin("owner-a", id, command)).toMatchObject({ type: "error", message: expect.stringContaining("RESULT_PENDING") })
    expect(() => store.begin("owner-a", id, { ...command, chatId: "other" })).toThrow("OPERATION_CONFLICT")
    expect(store.get("owner-b", id)).toBeNull()
    store.close(); store = new RemoteOperations(directory, () => now)
    expect(store.begin("owner-a", id, command)).toMatchObject({ type: "error", message: expect.stringContaining("RESULT_UNKNOWN") })
    const complete = `${now}-${randomId()}`
    expect(store.begin("owner-a", complete, command)).toBeNull()
    const ack = { v: 1, type: "ack", id: complete } as const
    store.finish("owner-a", ack)
    expect(store.begin("owner-a", complete, command)).toEqual(ack)
    store.close(); store = new RemoteOperations(directory, () => now)
    expect(store.begin("owner-a", complete, command)).toEqual(ack)
    now += 24 * 60 * 60_000
    expect(() => store.begin("owner-a", complete, command)).toThrow("OPERATION_EXPIRED")
  } finally { store.close(); await rm(directory, { recursive: true, force: true }) }
})
