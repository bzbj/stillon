import { Buffer } from "node:buffer"

/**
 * Small control messages cost more CPU to compress than they save on the wire.
 * Keep this value aligned with the reproducible benchmark in
 * scripts/websocket-compression/.
 */
export const DEFAULT_WEBSOCKET_COMPRESSION_THRESHOLD_BYTES = 32 * 1024

/**
 * Shared streams keep compression memory bounded as browser connections grow.
 * Bun resets shared streams between messages and negotiates no-context-takeover.
 */
export const WEBSOCKET_PER_MESSAGE_DEFLATE = {
  compress: "shared",
  decompress: "shared",
} as const

export function getWebSocketSendPolicy(
  payload: string,
  thresholdBytes = DEFAULT_WEBSOCKET_COMPRESSION_THRESHOLD_BYTES,
) {
  const payloadBytes = Buffer.byteLength(payload, "utf8")
  return {
    payloadBytes,
    compress: payloadBytes >= thresholdBytes,
  }
}
