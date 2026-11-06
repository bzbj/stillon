import { mkdir } from "node:fs/promises"
import path from "node:path"
import { buildDeepSeekAddon } from "./build-provider-addon"

// Build only StillOn adapters. Vendor CLIs, runtimes and credentials stay local.
export async function buildBundledIntegrations(directory = path.resolve(import.meta.dir, "../dist/integrations")) {
  await mkdir(directory, { recursive: true })
  for (const build of [buildDeepSeekAddon]) {
    const bundle = await build()
    await Bun.write(path.join(directory, `${bundle.manifest.id}.stillon-addon`), JSON.stringify(bundle))
  }
}

if (import.meta.main) await buildBundledIntegrations()
