import { expect, test, spyOn } from "bun:test"
import { deliverMessage, InterruptedOperation } from "./messageDelivery"
import type { SocketStatus } from "./socket"

for (const state of ["complete", "not-received"]) {
  test(`lost message acknowledgement checks the original receipt once: ${state}`, async () => {
    const id = "original-operation"
    let status: ((value: SocketStatus) => void) | undefined
    let sends = 0
    const socket = {
      command: async () => { sends++; throw new InterruptedOperation(id) },
      onStatus(listener: (value: SocketStatus) => void) { status = listener; return () => { status = undefined } },
    }
    const lookup = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      state, response: state === "complete" ? { type: "ack", id, result: { chatId: "created" } } : null,
    }))
    try {
      const delivery = deliverMessage(socket, { type: "chat.send", projectId: "project", content: "message" })
      await Promise.resolve()
      expect(lookup).not.toHaveBeenCalled()
      status!("connected")
      if (state === "complete") expect(await delivery).toEqual({ chatId: "created" })
      else await expect(delivery).rejects.toBeInstanceOf(InterruptedOperation)
      expect(lookup.mock.calls[0]?.[0]).toBe("/api/connect-operations/original-operation")
      expect(sends).toBe(1)
      expect(status).toBeUndefined()
    } finally { lookup.mockRestore() }
  })
}
