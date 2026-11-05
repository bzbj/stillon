import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DeepSeekRpc } from "./deepseek-harness"
import { spawnDeepSeek } from "./deepseek-cli"

declare const STILLON_DSH_CONTROL_SOURCE: string

export async function modelControl(executable: string, environment: NodeJS.ProcessEnv, method: string, params?: unknown) {
  const directory = await mkdtemp(path.join(tmpdir(), "stillon-dsh-models-"))
  let rpc: DeepSeekRpc | undefined
  try {
    const plugin = path.join(directory, "control.mjs"), patch = path.join(directory, "control.json")
    await writeFile(plugin, STILLON_DSH_CONTROL_SOURCE, { mode: 0o600 })
    await writeFile(patch, JSON.stringify([{ id: "sdk-jsonrpc-server", disabled: true },
      { insert: [{ id: "stillon-model-control", name: plugin }] }]), { mode: 0o600 })
    rpc = new DeepSeekRpc(spawnDeepSeek(executable, directory, environment, ["--patch", patch]))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Harness model configuration did not become ready.")), 60_000)
      rpc!.onNotification = frame => { if (frame.method === "stillon/ready") { clearTimeout(timer); resolve() } }
      rpc!.onFailure = error => { clearTimeout(timer); reject(error) }
    })
    return await rpc.request(method, params, 60_000)
  } finally {
    // The SDK app's EOF handler performs the vendor's normal shutdown.
    if (rpc) await rpc.close()
    await rm(directory, { recursive: true, force: true })
  }
}
