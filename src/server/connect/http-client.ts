import { Agent, ProxyAgent, request } from "undici/index.js"

// Import the package entry explicitly: Bun substitutes its fetch-based shim for
// bare "undici", which would reintroduce ambient proxy routing.
/** A dedicated dispatcher prevents Bun/system proxy rules from changing routes. */
export async function connectRequest(url: URL, options: {
  method?: "GET" | "POST"; body?: string; proxy: string; signal: AbortSignal; ca?: string
}): Promise<Response> {
  const dispatcher = options.proxy
    ? new ProxyAgent({ uri: options.proxy, requestTls: { ca: options.ca, rejectUnauthorized: true } })
    : new Agent({ connect: { ca: options.ca, rejectUnauthorized: true } })
  try {
    const response = await request(url, {
      dispatcher, method: options.method ?? "GET", body: options.body, signal: options.signal,
      headers: options.body === undefined ? {} : { "Content-Type": "application/json" },
    })
    // Control-plane responses only; file/WS traffic stays in the adapter.
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const bytes of response.body) {
      size += bytes.length
      if (size > 1024 * 1024) throw new Error("Connect API response too large")
      chunks.push(bytes)
    }
    const headers = new Headers()
    for (const [key, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(key, item)
      else if (value !== undefined) headers.set(key, value)
    }
    return new Response([204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode, headers })
  } finally { await dispatcher.destroy() }
}
