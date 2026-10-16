import { expect, test } from "bun:test"
import { createResendSender } from "./mail"

test("Resend adapter sends only a fixed login template to the selected recipient", async () => {
  let sent: { url: string; init?: RequestInit } | undefined
  const sender = createResendSender({ apiKey: "test-key", from: "StillOn <login@mail.example.com>", fetch: (async (url, init) => {
    sent = { url: String(url), init }
    return Response.json({ id: "test-message" })
  }) })
  await sender.send({ email: "person@example.com", code: "123456", expiresInMinutes: 5 })
  expect(sent?.url).toBe("https://api.resend.com/emails")
  const body = JSON.parse(String(sent?.init?.body))
  expect(body.to).toEqual(["person@example.com"])
  expect(body.text).toContain("123456")
  expect(body.text).toContain("5 minutes")
  expect(new Headers(sent?.init?.headers).get("Idempotency-Key")).toBeTruthy()
})

test("Resend errors are opaque and a missing acknowledgment is a failure", async () => {
  for (const response of [Response.json({ message: "private sender details" }, { status: 422 }), Response.json({})]) {
    const sender = createResendSender({ apiKey: "test-key", from: "login@mail.example.com", fetch: async () => response })
    let message = ""
    try { await sender.send({ email: "person@example.com", code: "123456", expiresInMinutes: 5 }) } catch (error) { message = (error as Error).message }
    expect(message).toBeTruthy()
    expect(message).not.toContain("private sender details")
  }
})
