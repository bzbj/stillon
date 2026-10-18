import { afterAll, beforeAll, expect, test } from "bun:test"
import { probeWindowsHttpPorts } from "./windows-http-probe"
import { probeLoopbackHttp } from "./loopback-http-probe"

// A native Node server also detects accidentally routing Bun's probes through
// its HTTP/fetch implementation. Keep the fixture outside Bun's TCP server shim.
let fixture: Bun.Subprocess<"ignore", "pipe", "inherit">
let apps: { hostname: "127.0.0.1" | "::1"; port: number }[]
beforeAll(async () => {
  fixture = Bun.spawn(["node", "-e", `
    const net=require('node:net'); let connections=0;
    const apps=['127.0.0.1','::1','127.0.0.1','127.0.0.1','127.0.0.1'].map((hostname,index)=>{
      const server=net.createServer(socket=>{
        connections++;socket.on('close',()=>connections--);socket.on('error',()=>{});
        socket.once('data',request=>{
          const text=request.toString();
          if(index===3 || text.startsWith('GET /stall'))return;
          if(index===4 || text.startsWith('GET /large')){socket.write('HTTP/1.1 200 OK\\r\\nX-Large: '+'x'.repeat(17*1024));return}
          if(index===2 || text.startsWith('GET /chunked')){
            socket.write('HTTP/1.1 200 OK\\r\\nContent-Type: text/html\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n9\\r\\n<title>Ch\\r\\n');
            setTimeout(()=>{if(!socket.destroyed)socket.write('b;sample=yes\\r\\nunked</titl\\r\\n2\\r\\ne>\\r\\n')},10);return;
          }
          const body=text.startsWith('GET /count')?String(connections):'<title>'+hostname+'</title>';
          const status=text.includes('Host: localhost:'+server.address().port+'\\r\\n')?200:400;
          socket.end('HTTP/1.0 '+status+' OK\\r\\nContent-Type: text/html\\r\\nContent-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body);
        });
      });return {server,hostname};
    });
    Promise.all(apps.map(app=>new Promise(resolve=>app.server.listen(0,app.hostname,resolve)))).then(()=>console.log(JSON.stringify(apps.map(app=>({hostname:app.hostname,port:app.server.address().port})))));
  `], { stdin: "ignore", stdout: "pipe", stderr: "inherit" })
  const reader = fixture.stdout.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    apps = await Promise.race([(async () => {
      let value = ""
      while (!value.includes("\n")) { const chunk = await reader.read(); if (chunk.done) throw new Error("HTTP fixture exited"); value += Buffer.from(chunk.value).toString() }
      return JSON.parse(value)
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("HTTP fixture timed out")), 5_000) })])
  } finally { clearTimeout(timer); reader.releaseLock() }
})
afterAll(async () => { if (fixture) { fixture.kill(); await fixture.exited } })
async function probe(url: URL, host: "127.0.0.1" | "::1", timeout = 1_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try { return await probeLoopbackHttp(url, host, controller.signal) }
  finally { clearTimeout(timer) }
}
const url = (app = apps[0]!, pathname = "/") => new URL(`http://localhost:${app.port}${pathname}`)

test.skipIf(process.platform === "win32")("dials only the selected loopback family and preserves localhost Host", async () => {
  for (const app of apps.slice(0, 2)) {
    expect(await (await probe(url(app), app.hostname)).text()).toBe(`<title>${app.hostname}</title>`)
    await expect(probe(url(app), app.hostname === "::1" ? "127.0.0.1" : "::1", 200)).rejects.toThrow()
  }
})

test.skipIf(process.platform === "win32")("decodes fragmented chunked metadata and closes a streaming page once its title arrives", async () => {
  const result = await probe(url(apps[0], "/chunked"), "127.0.0.1")
  expect(await result.text()).toBe("<title>Chunked</title>")
})

test.skipIf(process.platform === "win32")("abort destroys a stalled physical socket and excessive headers are rejected", async () => {
  await expect(probe(url(apps[0], "/stall"), "127.0.0.1", 50)).rejects.toThrow("timed out")
  await expect(probe(url(apps[0], "/large"), "127.0.0.1")).rejects.toThrow("headers exceed")
  await Bun.sleep(30)
  expect(await (await probe(url(apps[0], "/count"), "127.0.0.1")).text()).toBe("1")
})

test.skipIf(process.platform !== "win32")("Windows native batch handles both families, streaming chunks, stalls and oversized headers", async () => {
  const results = await probeWindowsHttpPorts(apps.map(app => app.port))
  expect(await results.get(apps[0]!.port)?.text()).toBe("<title>127.0.0.1</title>")
  expect(await results.get(apps[1]!.port)?.text()).toBe("<title>::1</title>")
  expect(await results.get(apps[2]!.port)?.text()).toBe("<title>Chunked</title>")
  expect(results.has(apps[3]!.port)).toBe(false)
  expect(results.has(apps[4]!.port)).toBe(false)
}, 20_000)
