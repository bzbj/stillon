import { expect, test } from "bun:test"
import { SocketTransport, SOCKET_TRANSPORT_READY } from "./socket-transport"

test("large bidirectional envelopes preserve Unicode and order through the old 1 MiB relay budget", () => {
  const leftWire: string[] = [], rightWire: string[] = [], receivedLeft: string[] = [], receivedRight: string[] = []
  const failures: string[] = []
  const left = new SocketTransport({ enabled: true, write: frame => { leftWire.push(frame); return true }, fail: reason => failures.push(reason) })
  const right = new SocketTransport({ enabled: true, write: frame => { rightWire.push(frame); return true }, fail: reason => failures.push(reason) })
  const document = JSON.stringify({ text: '资料😀\\"\n'.repeat(650_000) })
  expect(Buffer.byteLength(document)).toBeGreaterThan(5 * 1024 * 1024)
  try {
    left.send(document)
    left.send("after-document")
    right.send(document)
    right.send("after-response")
    expect(leftWire.length).toBe(4)
    expect(rightWire.length).toBe(4)
    for (let steps = 0; (leftWire.length || rightWire.length) && steps < 10_000; steps++) {
      // A delayed ACK does not allow the sender to keep flooding the relay.
      expect(Buffer.byteLength(leftWire.join(""))).toBeLessThan(1024 * 1024)
      for (const frame of leftWire.splice(0)) { const message = right.receive(frame); if (message !== null) receivedRight.push(message) }
      for (const frame of rightWire.splice(0)) { const message = left.receive(frame); if (message !== null) receivedLeft.push(message) }
    }
    expect(receivedRight).toEqual([document, "after-document"])
    expect(receivedLeft).toEqual([document, "after-response"])
    expect(failures).toEqual([])
    expect(left.busy || right.busy).toBe(false)
  } finally { left.dispose(); right.dispose() }
})

test("negotiation holds an early large command, but preserves legacy protocol 1", () => {
  for (const modern of [false, true]) {
    const sent: string[] = [], errors: string[] = []
    let probes = 0
    const transport = new SocketTransport({ write: frame => { sent.push(frame); return true }, fail: reason => errors.push(reason), probe: () => probes++ })
    try {
      transport.send("subscribe")
      const command = JSON.stringify({ text: "x".repeat(200_000) })
      transport.send(command)
      expect(sent).toEqual(["subscribe"])
      expect(probes).toBe(1)
      transport.receive(modern ? SOCKET_TRANSPORT_READY : "legacy-snapshot")
      expect(modern ? sent[1]!.startsWith("~stillon/chunk/1 ") : sent[1] === command).toBe(true)
      expect(errors).toEqual([])
    } finally { transport.dispose() }
  }
})

test("a stalled receiver times out only after no ACK progress and partial commands never escape", async () => {
  const wire: string[] = [], errors: string[] = []
  const sender = new SocketTransport({ enabled: true, timeoutMs: 60, write: frame => { wire.push(frame); return true }, fail: reason => errors.push(reason) })
  const receiver = new SocketTransport({ enabled: true, write: () => true, fail: reason => errors.push(reason) })
  try {
    sender.send("x".repeat(500_000))
    expect(receiver.receive(wire[0]!)).toBeNull()
    await Bun.sleep(100)
    expect(errors).toEqual(["Transport stopped making progress"])
    receiver.dispose()
    expect(receiver.receive(wire[1]!)).toBeNull()
  } finally { sender.dispose(); receiver.dispose() }
})

test("a temporary sink rejection retries once without duplicating buffered frames or ACKs", async () => {
  let available = false
  const wire: string[] = [], errors: string[] = []
  const sender = new SocketTransport({ enabled: true, write: frame => { if (!available) return false; wire.push(frame); return true }, fail: reason => errors.push(reason) })
  try {
    sender.send("first")
    sender.send("second")
    expect(wire).toEqual([])
    available = true
    await Bun.sleep(60)
    expect(wire).toEqual(["first", "second"])
    expect(errors).toEqual([])
  } finally { sender.dispose() }
})

test("out-of-order chunks are rejected without a partial application message", () => {
  const errors: string[] = []
  const transport = new SocketTransport({ enabled: true, write: () => true, fail: reason => errors.push(reason) })
  expect(transport.receive('~stillon/chunk/1 {"id":1,"part":1,"last":true,"text":"partial"}')).toBeNull()
  expect(errors).toEqual(["Invalid transport frame"])
})
