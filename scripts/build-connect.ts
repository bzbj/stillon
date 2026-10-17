import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import pkg from "../package.json"
import { prepareConnectRuntime } from "./prepare-connect-runtime"

const destination = path.resolve("dist/connect-service")
await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
// Exact allowlist; no task outputs, env files, databases or desktop device keys.
for (const name of ["src/connect", "src/shared/connect.ts", "src/shared/connect-preview.ts", "src/shared/browser-preview-proxy.ts", "src/shared/project-file-urls.ts", "src/shared/preview-navigation.ts", "src/server/preview-resources.ts", "src/server/preview-navigation.ts", "src/server/connect/crypto.ts", "src/server/connect/relay.ts", "src/server/connect/stop-server.ts", "scripts/restore-connect.ts", "dist/connect", "public/stillon-mark.svg", "LICENSE", "packaging/connect"]) {
  await cp(path.resolve(name), path.join(destination, name), { recursive: true, filter: source => !/\.test\.tsx?$/.test(source) && !path.basename(source).startsWith(".env") && path.basename(source) !== "client" })
}
await writeFile(path.join(destination, "package.json"), JSON.stringify({ name: "stillon-connect-service", private: true, type: "module", version: pkg.version,
  dependencies: { "better-auth": pkg.dependencies["better-auth"], kysely: pkg.dependencies.kysely, zod: (await Bun.file("node_modules/zod/package.json").json()).version } }, null, 2) + "\n")
const install = Bun.spawn([process.execPath, "install", "--production", "--ignore-scripts"], { cwd: destination, stdout: "inherit", stderr: "inherit" })
if (await install.exited !== 0) throw new Error("Cloud dependency installation failed")
await prepareConnectRuntime(path.join(destination, "runtime/frp"), process.argv.find(arg => arg.startsWith("--target="))?.slice(9) ?? "linux_amd64", true)
await writeFile(path.join(destination, "README.md"), (await readFile("docs/connect-remote-access.md", "utf8")).replace("(connect-email-login.md)", "(docs/connect-email-login.md)").replace("(connect-dynamic-previews.md)", "(docs/connect-dynamic-previews.md)"))
await mkdir(path.join(destination, "docs"), { recursive: true })
await copyFile("docs/connect-email-login.md", path.join(destination, "docs/connect-email-login.md"))
await copyFile("docs/connect-remote-access.md", path.join(destination, "docs/connect-remote-access.md"))
await copyFile("docs/connect-dynamic-previews.md", path.join(destination, "docs/connect-dynamic-previews.md"))
await copyFile("src/connect/.env.example", path.join(destination, "connect.env.example"))
const files: Record<string, { sha256: string; bytes: number }> = {}
for await (const file of new Bun.Glob("**/*").scan({ cwd: destination, onlyFiles: true, dot: true })) {
  if (file.includes("/.bin/") || /(?:^|\/)(?:\.env|.*\.sqlite(?:-wal|-shm)?|device\.json|gateway-keys\.json)/.test(file)) throw new Error("Unexpected private/generated file in cloud package")
  const bytes = await readFile(path.join(destination, file))
  files[file] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }
}
await writeFile(path.join(destination, "manifest.json"), JSON.stringify({ version: pkg.version, protocol: 1, files }, null, 2) + "\n")
console.log(`Cloud package verified: ${Object.keys(files).length} files`)
