import { createServer } from "node:http"
import { connect } from "node:net"

export async function proxyServer(targetPort: number) {
  const connections = new Set<import("node:net").Socket>()
  const seen: { authority: string; authorization?: string }[] = []
  const server = createServer((_request, response) => { response.writeHead(502).end() })
  server.on("connection", socket => { connections.add(socket); socket.on("close", () => connections.delete(socket)) })
  server.on("connect", (request, client, head) => {
    seen.push({ authority: request.url!, authorization: request.headers["proxy-authorization"] })
    const upstream = connect(targetPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      client.pipe(upstream); upstream.pipe(client)
    })
    upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy())
    client.on("close", () => upstream.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  return { url: `http://user:secret@127.0.0.1:${port}`, seen, async stop() {
    for (const socket of connections) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}

