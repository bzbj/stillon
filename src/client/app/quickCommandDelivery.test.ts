import { describe, expect, test } from "bun:test"
import { ConfirmedCommandError, QuickCommandDelivery, type QuickCommandResult } from "./quickCommandDelivery"
import type { QuickCommand } from "../../shared/quick-commands"
import type { ChatTurnPreferences } from "../../shared/types"

const preferences: ChatTurnPreferences = { provider: "codex", model: "model", permissionMode: "request", modelOptions: { reasoningEffort: "medium", fastMode: false } }
const command: QuickCommand = { id: "brief", name: "Work Brief", prompt: "Prepare an HTML brief." }

describe("QuickCommandDelivery", () => {
  test("coalesces repeat clicks and keeps the clicked target and prompt snapshot", async () => {
    let release!: (result: QuickCommandResult) => void
    const sent: unknown[] = []
    const delivery = new QuickCommandDelivery(async request => { sent.push(request); return await new Promise(resolve => { release = resolve }) })
    const edited = { ...command }
    const first = delivery.start("workspace-one", edited, preferences)
    const repeated = delivery.start("workspace-one", { ...edited, prompt: "Another command" }, preferences)
    edited.prompt = "Changed after clicking"
    await Promise.resolve()
    expect(first).toBe(repeated)
    expect(sent).toEqual([expect.objectContaining({ projectId: "workspace-one", content: command.prompt })])
    release({ chatId: "new-conversation" })
    expect((await first).result.chatId).toBe("new-conversation")
  })

  test("recovers a disconnected acknowledgement from the durable receipt without sending again", async () => {
    let sends = 0
    const delivery = new QuickCommandDelivery(async () => { sends++; throw new Error("Disconnected") }, async () => ({ state: "complete", response: { type: "ack", result: { chatId: "already-created" } } }))
    expect((await delivery.start("one", command, preferences)).result.chatId).toBe("already-created")
    expect(sends).toBe(1)
  })

  test("an uncertain click checks the old request even when a different command is selected", async () => {
    let sends = 0
    let complete = false
    const delivery = new QuickCommandDelivery(async () => { sends++; throw new Error("Disconnected") }, async () => complete
      ? { state: "complete", response: { type: "ack", result: { chatId: "original" } } }
      : { state: "unknown" })
    await expect(delivery.start("one", command, preferences)).rejects.toThrow("not confirmed")
    await expect(delivery.start("one", { ...command, prompt: "Different" }, preferences)).rejects.toThrow("not confirmed")
    complete = true
    const recovered = await delivery.start("one", { ...command, prompt: "Different" }, preferences)
    expect(sends).toBe(1)
    expect(recovered.command.prompt).toBe(command.prompt)
  })

  test("a confirmed unsent rejection allows an explicit later attempt", async () => {
    let sends = 0
    const delivery = new QuickCommandDelivery(async () => { if (++sends === 1) throw new ConfirmedCommandError("Not sent"); return { chatId: "later" } })
    await expect(delivery.start("one", command, preferences)).rejects.toThrow("Not sent")
    expect((await delivery.start("one", command, preferences)).result.chatId).toBe("later")
  })
})


test("a missing receipt does not authorize replay of a potentially delayed request", async () => {
  let sends = 0
  const delivery = new QuickCommandDelivery(async () => { sends++; throw new Error("Disconnected") }, async () => ({ state: "not-received" }))
  await expect(delivery.start("one", command, preferences)).rejects.toThrow("not confirmed")
  await expect(delivery.start("one", command, preferences)).rejects.toThrow("not confirmed")
  expect(sends).toBe(1)
})
