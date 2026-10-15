import { chmod, copyFile, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import pkg from "../package.json"
import { artifactName, BUNDLE_FILE, bundleFiles, bunRelativePath, sha256, validateBundle, type ReleaseArtifact, type RuntimeBundle } from "../src/server/distribution/bundle"
import { updateTarget } from "../src/server/updater/model"
import { prepareConnectRuntime } from "./prepare-connect-runtime"

const repository = path.resolve(import.meta.dir, "..")
const output = path.join(repository, "dist", "desktop")
const runtime = path.join(output, "payload")
const release = path.join(output, "release")
const target = updateTarget()

async function run(command: string[], cwd = repository) {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" })
  if (await child.exited !== 0) throw new Error(`Desktop build failed: ${command[0]}`)
}
async function capture(command: string[]) {
  const child = Bun.spawn(command, { cwd: repository, stdout: "pipe", stderr: "inherit" })
  const text = await new Response(child.stdout).text()
  if (await child.exited !== 0) throw new Error(`Desktop build failed: ${command[0]}`)
  return text.trim()
}

async function createDiskImage(command: string[]) {
  // macOS can temporarily lock newly staged app bundles while scanning them.
  // Retry only that error; never disable system security/indexing services.
  // https://github.com/actions/runner-images/issues/7522
  for (let attempt = 1; attempt <= 4; attempt++) {
    const child = Bun.spawn(command, { cwd: repository, stdin: "ignore", stdout: "inherit", stderr: "pipe" })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (stderr) process.stderr.write(stderr)
    if (code === 0) return
    if (attempt === 4 || !/Resource busy/i.test(stderr)) throw new Error(`Disk image creation failed (${code})`)
    console.log(`Disk image source is busy; retry ${attempt}/3 in ${attempt * 10} seconds…`)
    await Bun.sleep(attempt * 10_000)
  }
}

async function buildMacInstaller() {
  const app = path.join(output, "macos", "StillOn.app")
  const contents = path.join(app, "Contents")
  await mkdir(path.join(contents, "MacOS"), { recursive: true })
  await mkdir(path.join(contents, "Resources"), { recursive: true })
  const iconset = path.join(output, "StillOn.iconset")
  await mkdir(iconset, { recursive: true })
  for (const size of [16, 32, 128, 256, 512]) {
    await run(["/usr/bin/sips", "-z", String(size), String(size), "public/icon-512.png", "--out", path.join(iconset, `icon_${size}x${size}.png`)])
    if (size < 512) await run(["/usr/bin/sips", "-z", String(size * 2), String(size * 2), "public/icon-512.png", "--out", path.join(iconset, `icon_${size}x${size}@2x.png`)])
  }
  await run(["/usr/bin/iconutil", "-c", "icns", iconset, "-o", path.join(contents, "Resources", "StillOn.icns")])
  await cp(runtime, path.join(contents, "Resources", "payload"), { recursive: true })
  await run(["/usr/bin/clang", "-fobjc-arc", "-framework", "Cocoa", "-mmacosx-version-min=13.0", "packaging/macos/launcher.m", "-o", path.join(contents, "MacOS", "StillOn")])
  await writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>StillOn</string><key>CFBundleDisplayName</key><string>StillOn</string>
<key>CFBundleIdentifier</key><string>com.bzbj.stillon.desktop</string>
<key>CFBundleIconFile</key><string>StillOn.icns</string>
<key>CFBundleExecutable</key><string>StillOn</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${pkg.version.split(".").slice(0, 3).join(".")}</string>
<key>CFBundleVersion</key><string>${process.env.GITHUB_RUN_NUMBER ?? "1"}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string><key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
<key>NSHighResolutionCapable</key><true/></dict></plist>\n`)
  if (process.env.MACOS_SIGN_IDENTITY) {
    await run(["/usr/bin/codesign", "--force", "--options", "runtime", "--timestamp", "--sign", process.env.MACOS_SIGN_IDENTITY, app])
    await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app])
  } else if (process.env.STILLON_REQUIRE_SIGNING === "1") throw new Error("A public macOS installer requires MACOS_SIGN_IDENTITY")
  // Runtime bytes must not be changed by signing the app. Bun is signed in the
  // payload before its manifest is created; signing again must be avoided.
  await symlink("/Applications", path.join(output, "macos", "Applications"))
  await writeFile(path.join(output, "macos", "Read me.txt"), "Drag StillOn to Applications, then open it.\nOn first launch, confirm background setup.\nTo uninstall, hold Option while opening StillOn, choose Remove background services, then remove the app.\nChats, settings, themes and skins remain in your user directory.\n")
  const dmg = path.join(release, `StillOn-${pkg.version}-macos-${target.architecture}${process.env.MACOS_SIGN_IDENTITY ? "" : "-unsigned"}.dmg`)
  await createDiskImage(["/usr/bin/hdiutil", "create", "-volname", "StillOn", "-srcfolder", path.join(output, "macos"), "-ov", "-format", "UDZO", dmg])
  if (process.env.MACOS_SIGN_IDENTITY) {
    await run(["/usr/bin/codesign", "--timestamp", "--sign", process.env.MACOS_SIGN_IDENTITY, dmg])
    if (!process.env.MACOS_NOTARY_PROFILE) throw new Error("A signed public installer requires MACOS_NOTARY_PROFILE")
    await run(["/usr/bin/xcrun", "notarytool", "submit", dmg, "--keychain-profile", process.env.MACOS_NOTARY_PROFILE,
      ...(process.env.MACOS_NOTARY_KEYCHAIN ? ["--keychain", process.env.MACOS_NOTARY_KEYCHAIN] : []), "--wait"])
    await run(["/usr/bin/xcrun", "stapler", "staple", dmg])
    await run(["/usr/sbin/spctl", "--assess", "--type", "open", "--context", "context:primary-signature", dmg])
  }
}

async function buildWindowsInstaller() {
  const app = path.join(output, "windows")
  await mkdir(app, { recursive: true })
  await cp(runtime, path.join(app, "payload"), { recursive: true })
  const compiler = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
  await run([compiler, "/nologo", "/target:winexe", "/platform:anycpu", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", `/out:${path.join(app, "StillOn.exe")}`, path.join(repository, "packaging", "windows", "Launcher.cs")])
  const iscc = process.env.ISCC_PATH ?? "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe"
  const signing: string[] = []
  if (process.env.STILLON_REQUIRE_SIGNING === "1") {
    if (!process.env.WINDOWS_SIGN_SCRIPT) throw new Error("A public Windows installer requires WINDOWS_SIGN_SCRIPT")
    const script = path.resolve(process.env.WINDOWS_SIGN_SCRIPT)
    await run(["pwsh", "-NoProfile", "-NonInteractive", "-File", process.env.WINDOWS_SIGN_SCRIPT,
      path.join(app, "StillOn.exe")])
    signing.push("/DSignedRelease=1", `/Sstillon=pwsh -NoProfile -NonInteractive -File $q${script}$q $f`)
  }
  await run([iscc, ...signing, `/DAppVersion=${pkg.version}`, `/DAppArch=${target.architecture}`, `/DUnsignedSuffix=${process.env.STILLON_REQUIRE_SIGNING === "1" ? "" : "-unsigned"}`, `/DPayloadDir=${app}`, `/DOutputDir=${release}`, path.join(repository, "packaging", "windows", "stillon.iss")])
}

async function main() {
  console.time("desktop build")
  await rm(output, { recursive: true, force: true })
  await mkdir(runtime, { recursive: true })
  await mkdir(release, { recursive: true })
  // CI does all installation/build work. The distributed launcher never does it.
  await copyFile(path.join(repository, "package.json"), path.join(runtime, "package.json"))
  await copyFile(path.join(repository, "bun.lock"), path.join(runtime, "bun.lock"))
  console.log("Installing production dependencies in the build staging directory…")
  await run([process.execPath, "install", "--production", "--frozen-lockfile", "--ignore-scripts", "--linker=hoisted"], runtime)
  await rm(path.join(runtime, "node_modules", ".bin"), { recursive: true, force: true })
  // Hoisted packages are ordinary files. bundleFiles rejects any unexpected
  // package symlinks; never copy dependencies between OS/architecture targets.
  console.log("Assembling the server, clients and independent updater…")
  for (const name of ["bin", "src/server", "src/shared", "dist/client", "dist/export-viewer", "LICENSE", "README.md"]) {
    await cp(path.join(repository, name), path.join(runtime, name), { recursive: true,
      filter: (source) => !/\.test\.tsx?$/.test(source) })
  }
  await mkdir(path.join(runtime, "runtime"), { recursive: true })
  const connectOrigin = process.env.STILLON_CONNECT_ORIGIN
  if (connectOrigin) {
    const origin = new URL(connectOrigin)
    if (origin.protocol !== "https:" || origin.origin !== connectOrigin || origin.username || origin.password) throw new Error("Desktop Connect origin must be an HTTPS origin")
    await prepareConnectRuntime(path.join(runtime, "runtime/frp"))
    // Only public configuration enters the desktop artifact. Never copy an env file.
    await writeFile(path.join(runtime, "runtime/connect.json"), JSON.stringify({ origin: origin.origin }) + "\n")
  }
  await copyFile(process.execPath, path.join(runtime, bunRelativePath(target.platform)))
  await chmod(path.join(runtime, bunRelativePath(target.platform)), 0o755)
  const controller = await Bun.build({ entrypoints: [path.join(repository, "src/server/updater/entry.ts")], target: "bun", packages: "bundle", naming: "controller.js", outdir: path.join(runtime, "runtime") })
  if (!controller.success) throw new AggregateError(controller.logs, "Could not bundle the updater")
  if (target.platform === "darwin" && process.env.MACOS_SIGN_IDENTITY) {
    if (connectOrigin) {
      const frpc = path.join(runtime, "runtime/frp/frpc")
      await run(["/usr/bin/codesign", "--force", "--options", "runtime", "--timestamp", "--sign", process.env.MACOS_SIGN_IDENTITY, frpc])
      // Pin downloads before signing, then seal the signed installed bytes.
      const manifestFile = path.join(runtime, "runtime/frp/manifest.json")
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"))
      manifest.files.frpc = sha256(await readFile(frpc))
      await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n")
    }
    await run(["/usr/bin/codesign", "--force", "--options", "runtime", "--timestamp", "--entitlements", "packaging/macos/entitlements.plist", "--sign", process.env.MACOS_SIGN_IDENTITY,
      path.join(runtime, bunRelativePath("darwin"))])
    // Keep third-party Developer ID signatures intact, but reject unsigned or
    // damaged native helpers before the runtime manifest seals their bytes.
    const macho = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca])
    for await (const name of new Bun.Glob("**/*").scan({ cwd: runtime, onlyFiles: true, dot: true })) {
      const file = path.join(runtime, name)
      const prefix = Buffer.from(await Bun.file(file).slice(0, 4).arrayBuffer())
      if (prefix.length === 4 && macho.has(prefix.readUInt32BE())) await run(["/usr/bin/codesign", "--verify", "--strict", file])
    }
  }
  const revision = await capture(["git", "rev-parse", "HEAD"])
  const buildId = `${pkg.version}-${revision.slice(0, 12)}-${target.platform}-${target.architecture}`
  const bundle: RuntimeBundle = { schema: 1, version: pkg.version, buildId, revision, ...target,
    bunVersion: Bun.version, minimumUpdaterProtocol: 1, files: await bundleFiles(runtime) }
  validateBundle(bundle)
  await writeFile(path.join(runtime, BUNDLE_FILE), JSON.stringify(bundle, null, 2) + "\n")
  console.log(`Packing ${Object.keys(bundle.files).length} verified runtime files…`)
  const inputs: Record<string, Blob> = Object.create(null)
  for (const name of [BUNDLE_FILE, ...Object.keys(bundle.files)]) inputs[name] = new Blob([await Bun.file(path.join(runtime, name)).bytes()])
  const archive = path.join(release, artifactName(pkg.version, target.platform, target.architecture))
  // Bun 1.3.x's direct Bun.write(Archive) path does not preserve compression.
  // Materialize the explicitly compressed bytes, as exercised by unpack tests.
  await Bun.write(archive, await new Bun.Archive(inputs, { compress: "gzip" }).bytes())
  const bytes = await Bun.file(archive).bytes()
  const artifact: ReleaseArtifact = { ...target, buildId, name: path.basename(archive), size: bytes.byteLength, sha256: sha256(bytes) }
  await writeFile(path.join(release, `artifact-${target.platform}-${target.architecture}.json`), JSON.stringify(artifact, null, 2) + "\n")
  if (process.argv.includes("--runtime-only")) return
  if (target.platform === "darwin") await buildMacInstaller()
  else await buildWindowsInstaller()
  console.timeEnd("desktop build")
  console.log(`Desktop artifacts: ${release}`)
  console.log(`Signing: ${process.env.STILLON_REQUIRE_SIGNING === "1" ? "required" : "development artifacts; not a signed public release"}`)
  console.log((await readdir(release)).join("\n"))
}

await main()
