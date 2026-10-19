import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { findBuildModuleProbe } from "../../scripts/build-module-probe"

test("transport integrity probe follows the generated graph after download code is merged", async () => {
  const directory = path.resolve("dist/client")
  const probe = await findBuildModuleProbe(directory)
  const manifest = JSON.parse(await readFile(path.join(directory, ".vite/manifest.json"), "utf8"))
  const entry = Object.values(manifest).find((entry: any) => "/" + entry.file === probe) as any
  expect(entry).toBeDefined()
  expect(entry.isEntry).not.toBe(true)
  expect(entry.isDynamicEntry).not.toBe(true)
  expect(entry.imports?.length ?? 0).toBe(0)
  expect(entry.dynamicImports?.length ?? 0).toBe(0)
  // Exercise native ESM parsing, rather than accepting an arbitrary .js file.
  for (let attempt = 0; attempt < 20; attempt++) await import(path.join(directory, probe.slice(1)) + `?integrity-unit=${attempt}`)
})
