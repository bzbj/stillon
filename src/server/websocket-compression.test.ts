import { describe, expect, test } from "bun:test"
import {
  DEFAULT_WEBSOCKET_COMPRESSION_THRESHOLD_BYTES,
  WEBSOCKET_PER_MESSAGE_DEFLATE,
  getWebSocketSendPolicy,
} from "./websocket-compression"

describe("WebSocket compression policy", () => {
  test("uses shared compressor and decompressor streams", () => {
    expect(WEBSOCKET_PER_MESSAGE_DEFLATE).toEqual({
      compress: "shared",
      decompress: "shared",
    })
  })

  test("compresses at the configured UTF-8 byte threshold", () => {
    const threshold = DEFAULT_WEBSOCKET_COMPRESSION_THRESHOLD_BYTES

    expect(getWebSocketSendPolicy("a".repeat(threshold - 1))).toEqual({
      payloadBytes: threshold - 1,
      compress: false,
    })
    expect(getWebSocketSendPolicy("a".repeat(threshold))).toEqual({
      payloadBytes: threshold,
      compress: true,
    })
    expect(getWebSocketSendPolicy("a".repeat(threshold + 1))).toEqual({
      payloadBytes: threshold + 1,
      compress: true,
    })
  })

  test("counts multibyte text by UTF-8 bytes instead of UTF-16 code units", () => {
    expect(getWebSocketSendPolicy("éééé", 8)).toEqual({
      payloadBytes: 8,
      compress: true,
    })
    expect(getWebSocketSendPolicy("éééé", 9)).toEqual({
      payloadBytes: 8,
      compress: false,
    })
  })
})
