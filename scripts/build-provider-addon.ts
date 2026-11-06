import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { addonManifestSchema, type AddonPackage } from "../src/shared/provider-addons"

export async function buildDeepSeekAddon(): Promise<AddonPackage> {
  const control = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../addons/deepseek/src/model-control-plugin.ts")], target: "node", format: "esm", packages: "bundle" })
  if (!control.success || control.outputs.length !== 1) throw new Error("Unable to build Harness model control plugin.")
  const build = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../addons/deepseek/src/entry.ts")], target: "bun", format: "esm", packages: "bundle", minify: false,
    define: { STILLON_DSH_CONTROL_SOURCE: JSON.stringify(await control.outputs[0]!.text()) } })
  if (!build.success || build.outputs.length !== 1) throw new Error(`Add-on build failed: ${build.logs.join("\n")}`)
  const code = await build.outputs[0]!.text()
  const manifest = addonManifestSchema.parse({ format: 1, id: "deepseek", name: "DeepSeek Harness", version: "0.2.0-preview.3", hostApi: 1,
    targets: ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64"], testedCliVersions: ["0.2.1-rc.5", "0.2.2-rc.1"],
    catalog: { id: "deepseek", label: "DeepSeek Harness", defaultModel: "deepseek-flash", defaultEffort: "high",
      models: [{ id: "deepseek-flash", label: "DeepSeek Flash", supportsEffort: true }, { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", supportsEffort: true }],
      efforts: ["off", "low", "high", "max"].map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })) },
    capabilities: { resume: true, fork: false, images: false, streaming: false, questions: true, permissions: ["request", "full"], modelManagement: true },
    sha256: createHash("sha256").update(code).digest("hex") })
  return { manifest, code }
}
if (import.meta.main) {
  const provider = process.argv[2] ?? "deepseek"
  if (provider !== "deepseek") throw new Error("Usage: bun scripts/build-provider-addon.ts [deepseek]")
  const bundle = await buildDeepSeekAddon()
  const directory = path.resolve(import.meta.dir, "../dist/addons")
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `${bundle.manifest.id}-${bundle.manifest.version}.stillon-addon`)
  await Bun.write(file, JSON.stringify(bundle))
  console.log(file)
}
