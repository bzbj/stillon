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
  const manifest = addonManifestSchema.parse({ format: 1, id: "deepseek", name: "DeepSeek Harness", version: "0.2.0-preview.2", hostApi: 1,
    targets: ["win32-x64", "win32-arm64"], testedCliVersions: ["0.2.1-rc.5"],
    catalog: { id: "deepseek", label: "DeepSeek Harness", defaultModel: "deepseek-flash", defaultEffort: "high",
      models: [{ id: "deepseek-flash", label: "DeepSeek Flash", supportsEffort: true }, { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", supportsEffort: true }],
      efforts: ["off", "low", "high", "max"].map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })) },
    capabilities: { resume: true, fork: false, images: false, streaming: false, questions: true, permissions: ["request", "full"], modelManagement: true },
    sha256: createHash("sha256").update(code).digest("hex") })
  return { manifest, code }
}
export async function buildCodeBuddyAddon(): Promise<AddonPackage> {
  const build = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../addons/codebuddy/src/entry.ts")], target: "bun", format: "esm", packages: "bundle", minify: false })
  if (!build.success || build.outputs.length !== 1) throw new Error(`Add-on build failed: ${build.logs.join("\n")}`)
  const code = await build.outputs[0]!.text()
  const manifest = addonManifestSchema.parse({ format: 1, id: "codebuddy", name: "CodeBuddy CLI (Preview)", version: "0.1.0-preview.4", hostApi: 1,
    targets: ["win32-x64", "win32-arm64"], testedCliVersions: ["2.180.0"],
    catalog: { id: "codebuddy", label: "CodeBuddy", defaultModel: "default", defaultEffort: "default",
      models: [{ id: "default", label: "CLI default", supportsEffort: false }], efforts: [{ id: "default", label: "CLI default" }] },
    capabilities: { resume: true, fork: false, images: false, streaming: false, questions: true, permissions: ["request", "full"] },
    sha256: createHash("sha256").update(code).digest("hex") })
  return { manifest, code }
}
if (import.meta.main) {
  const provider = process.argv[2] ?? "deepseek"
  if (!["deepseek", "codebuddy"].includes(provider)) throw new Error("Usage: bun scripts/build-provider-addon.ts [deepseek|codebuddy]")
  const bundle = await (provider === "codebuddy" ? buildCodeBuddyAddon() : buildDeepSeekAddon())
  const directory = path.resolve(import.meta.dir, "../dist/addons")
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `${bundle.manifest.id}-${bundle.manifest.version}.stillon-addon`)
  await Bun.write(file, JSON.stringify(bundle))
  console.log(file)
}
