import { describe, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { connectRawWebSocket, type RawWebSocketClient } from "../../scripts/websocket-compression/raw-websocket-client"
import {
  DEFAULT_WEBSOCKET_COMPRESSION_THRESHOLD_BYTES,
  getWebSocketSendPolicy,
  WEBSOCKET_PER_MESSAGE_DEFLATE,
} from "./websocket-compression"

interface FixtureClientData {
  connectionId: number
}

interface FixtureOptions {
  onMessage?: (
    ws: ServerWebSocket<FixtureClientData>,
    message: string | Buffer | ArrayBuffer | Uint8Array,
  ) => void
  payloadsOnOpen?: readonly string[]
}

function startCompressionFixture(options: FixtureOptions) {
  let nextConnectionId = 1
  return Bun.serve<FixtureClientData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/ws") return new Response("Not found", { status: 404 })
      const upgraded = server.upgrade(request, {
        data: { connectionId: nextConnectionId++ },
      })
      if (!upgraded) return new Response("Upgrade failed", { status: 400 })
    },
    websocket: {
      perMessageDeflate: WEBSOCKET_PER_MESSAGE_DEFLATE,
      open(ws) {
        for (const payload of options.payloadsOnOpen ?? []) {
          const { compress } = getWebSocketSendPolicy(payload)
          ws.send(payload, compress)
        }
      },
      message(ws, message) {
        options.onMessage?.(ws, message)
      },
    },
  })
}

function makeLargeSyntheticEnvelope() {
  return {
    type: "snapshot",
    subscriptionId: "synthetic-subscription",
    topic: "chat",
    data: {
      messages: Array.from({ length: 1_400 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        text: `Synthetic message ${index % 17}: deterministic content for compression. 你好 🙂`,
      })),
    },
  }
}

function messageText(message: string | Buffer | ArrayBuffer | Uint8Array) {
  if (typeof message === "string") return message
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString("utf8")
  return Buffer.from(message).toString("utf8")
}

function fixturePort(server: ReturnType<typeof startCompressionFixture>) {
  if (server.port === undefined) throw new Error("Compression fixture did not bind a port")
  return server.port
}

async function stopFixture(
  server: ReturnType<typeof startCompressionFixture>,
  clients: RawWebSocketClient[],
) {
  for (const client of clients) client.destroy()
  await server.stop(true)
}

describe("WebSocket per-message compression integration", () => {
  test("negotiates compression while keeping small frames uncompressed", async () => {
    const smallPayload = JSON.stringify({ type: "ack", commandId: "small", ok: true })
    const largeEnvelope = makeLargeSyntheticEnvelope()
    const largePayload = JSON.stringify(largeEnvelope)
    expect(Buffer.byteLength(smallPayload, "utf8")).toBeLessThan(
      DEFAULT_WEBSOCKET_COMPRESSION_THRESHOLD_BYTES,
    )
    expect(Buffer.byteLength(largePayload, "utf8")).toBeGreaterThanOrEqual(
      DEFAULT_WEBSOCKET_COMPRESSION_THRESHOLD_BYTES,
    )

    const server = startCompressionFixture({ payloadsOnOpen: [smallPayload, largePayload] })
    const clients: RawWebSocketClient[] = []
    try {
      const client = await connectRawWebSocket(fixturePort(server), { offerCompression: true })
      clients.push(client)
      expect(client.handshake.statusCode).toBe(101)
      expect(
        client.handshake.extensionNames.filter((name) => name === "permessage-deflate"),
      ).toHaveLength(1)
      const negotiatedExtensions = (
        client.handshake.headers.get("sec-websocket-extensions") ?? []
      ).join(",").toLowerCase()
      expect(negotiatedExtensions).toContain("server_no_context_takeover")
      expect(negotiatedExtensions).toContain("client_no_context_takeover")

      const smallMessage = await client.readMessage()
      expect(smallMessage.compressed).toBe(false)
      expect(smallMessage.text).toBe(smallPayload)

      const largeMessage = await client.readMessage()
      expect(largeMessage.compressed).toBe(true)
      expect(JSON.parse(largeMessage.text)).toEqual(largeEnvelope)
      expect(largeMessage.framePayloadBytes).toBeLessThan(Buffer.byteLength(largePayload, "utf8"))
    } finally {
      await stopFixture(server, clients)
    }
  })

  test("falls back to an uncompressed frame when the client omits the extension offer", async () => {
    const largeEnvelope = makeLargeSyntheticEnvelope()
    const largePayload = JSON.stringify(largeEnvelope)
    const server = startCompressionFixture({ payloadsOnOpen: [largePayload] })
    const clients: RawWebSocketClient[] = []
    try {
      const client = await connectRawWebSocket(fixturePort(server), { offerCompression: false })
      clients.push(client)
      expect(client.handshake.extensionNames).not.toContain("permessage-deflate")

      const message = await client.readMessage()
      expect(message.compressed).toBe(false)
      expect(message.text).toBe(largePayload)
      expect(message.framePayloadBytes).toBe(Buffer.byteLength(largePayload, "utf8"))
    } finally {
      await stopFixture(server, clients)
    }
  })

  test("renegotiates independently when a client reconnects without compression", async () => {
    const largePayload = JSON.stringify(makeLargeSyntheticEnvelope())
    const server = startCompressionFixture({ payloadsOnOpen: [largePayload] })
    const clients: RawWebSocketClient[] = []
    try {
      const negotiatedClient = await connectRawWebSocket(fixturePort(server), { offerCompression: true })
      clients.push(negotiatedClient)
      expect(negotiatedClient.negotiatedPerMessageDeflate).toBe(true)
      expect((await negotiatedClient.readMessage()).compressed).toBe(true)
      negotiatedClient.destroy()

      const fallbackClient = await connectRawWebSocket(fixturePort(server), { offerCompression: false })
      clients.push(fallbackClient)
      expect(fallbackClient.negotiatedPerMessageDeflate).toBe(false)
      const fallbackMessage = await fallbackClient.readMessage()
      expect(fallbackMessage.compressed).toBe(false)
      expect(fallbackMessage.text).toBe(largePayload)
    } finally {
      await stopFixture(server, clients)
    }
  })

  test("decodes a masked compressed client message after negotiation", async () => {
    const inboundEnvelope = {
      type: "command",
      commandId: "synthetic-inbound",
      command: {
        type: "synthetic.echo",
        value: "deterministic inbound payload ".repeat(1_000),
      },
    }
    const inboundPayload = JSON.stringify(inboundEnvelope)
    let receivedPayload = ""
    const server = startCompressionFixture({
      onMessage(ws, message) {
        receivedPayload = messageText(message)
        ws.send(JSON.stringify({ type: "ack", commandId: "synthetic-inbound", ok: true }), false)
      },
    })
    const clients: RawWebSocketClient[] = []
    try {
      const client = await connectRawWebSocket(fixturePort(server), { offerCompression: true })
      clients.push(client)
      expect(client.negotiatedPerMessageDeflate).toBe(true)

      client.sendText(inboundPayload, { compress: true })
      const acknowledgement = await client.readMessage()
      expect(acknowledgement.compressed).toBe(false)
      expect(JSON.parse(acknowledgement.text)).toEqual({
        type: "ack",
        commandId: "synthetic-inbound",
        ok: true,
      })
      expect(receivedPayload).toBe(inboundPayload)
    } finally {
      await stopFixture(server, clients)
    }
  })
})
