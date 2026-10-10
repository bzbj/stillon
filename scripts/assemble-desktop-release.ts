import { readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import pkg from "../package.json"
import { RELEASE_FILE, selectArtifact, sha256, type ReleaseArtifact, type DesktopRelease } from "../src/server/distribution/bundle"

const directory = path.resolve(process.argv[2] ?? "dist/desktop/release")
const artifacts: ReleaseArtifact[] = []
for (const file of await readdir(directory)) {
  if (!/^artifact-(darwin|win32)-(x64|arm64)\.json$/.test(file)) continue
  const artifact = await Bun.file(path.join(directory, file)).json() as ReleaseArtifact
  const bytes = await Bun.file(path.join(directory, artifact.name)).bytes()
  if (bytes.byteLength !== artifact.size || sha256(bytes) !== artifact.sha256) throw new Error(`Artifact checksum mismatch: ${file}`)
  artifacts.push(artifact)
}
const release: DesktopRelease = { schema: 1, tag: `v${pkg.version}`, artifacts }
for (const platform of ["darwin", "win32"] as const) for (const architecture of ["x64", "arm64"] as const) selectArtifact(release, release.tag, { platform, architecture })
if (artifacts.length !== 4) throw new Error("A desktop release requires exactly four runtime packages")
await writeFile(path.join(directory, RELEASE_FILE), JSON.stringify(release, null, 2) + "\n")
console.log(`Validated four desktop targets; ${RELEASE_FILE} is ready to publish last.`)
