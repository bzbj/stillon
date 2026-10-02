import { describe, expect, test } from "bun:test"
import { AsyncQuestionDelivery } from "./asyncQuestionDelivery"
import type { AsyncQuestionAnswerResult } from "../../shared/protocol"

const response: AsyncQuestionAnswerResult = {
  questionKey: "question", submissionId: "submission", answers: [{ index: 0, value: "synthetic" }], status: "delivery_unknown",
}
function client(command: () => Promise<unknown>) {
  return new AsyncQuestionDelivery({ command, onStatus: (listener: (status: string) => void) => {
    listener("connected"); return () => {}
  } } as never)
}

describe("async answer query races", () => {
  test("a passive unresolved snapshot retains failed-query feedback", async () => {
    const delivery = client(() => Promise.reject(new Error("synthetic transport error")))
    delivery.observe("chat", response)
    await delivery.check("chat", "question")
    const error = delivery.get("chat", "question")?.error
    expect(error).toBe("暂时无法核对，请恢复连接后重试核对。")
    delivery.observe("chat", { ...response })
    expect(delivery.get("chat", "question")?.error).toBe(error)
    expect(delivery.get("chat", "question")?.checking).toBe(false)
  })
  test("an unresolved snapshot cannot unlock a query still in flight", async () => {
    let resolve!: (value: unknown) => void
    const delivery = client(() => new Promise((done) => { resolve = done }))
    delivery.observe("chat", response)
    const query = delivery.check("chat", "question")
    delivery.observe("chat", { ...response })
    expect(delivery.get("chat", "question")?.checking).toBe(true)
    resolve(response)
    await query
    expect(delivery.get("chat", "question")?.checking).toBe(false)
  })
  test("a late query error cannot display failure after durable acceptance", async () => {
    let reject!: (error: Error) => void
    const delivery = client(() => new Promise((_, fail) => { reject = fail }))
    delivery.observe("chat", response)
    const query = delivery.check("chat", "question")
    delivery.observe("chat", { ...response, status: "accepted" })
    reject(new Error("synthetic transport error"))
    await query
    expect(delivery.get("chat", "question")?.status).toBe("accepted")
    expect(delivery.get("chat", "question")?.error).toBeNull()
  })
})
