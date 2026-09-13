import { createHash } from "node:crypto"
import path from "node:path"
import { getMacosServicePaths } from "../service/macos"
import { getWindowsServicePaths } from "../service/windows"
import type { ServiceLaunchSpec } from "../service/types"
import { assertCommandSucceeded, type ServiceCommandRunner } from "../service/types"
import { runServiceCommand } from "../service"
import { atomicJson } from "./files"
import { updateRoot } from "./model"

export interface ServiceRegistration {
  schema: 1
  platform: "darwin" | "win32"
  launch: ServiceLaunchSpec
  serviceFile: string
  serviceHash: string
  nativeHash?: string
  windowsCommand?: string
}

export async function hashServiceFile(file: string) {
  return createHash("sha256").update(Buffer.from(await Bun.file(file).arrayBuffer())).digest("hex")
}

export async function windowsServiceHash(run: ServiceCommandRunner = runServiceCommand) {
  const result = await run("schtasks.exe", ["/Query", "/TN", "StillOn", "/XML"])
  assertCommandSucceeded("Read registered Windows service definition", result)
  if (!result.stdout.includes("<Task")) throw new Error("Cannot verify the registered Windows service definition")
  return createHash("sha256").update(result.stdout.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim()).digest("hex")
}

export async function windowsServiceCommand(file: string) {
  const bytes = Buffer.from(await Bun.file(file).arrayBuffer())
  const xml = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? "utf16le" : "utf8")
  const commands = [...xml.matchAll(/-EncodedCommand ([A-Za-z0-9+/=]+)/g)]
  if (commands.length !== 1) throw new Error("Cannot identify the original native watchdog command")
  return commands[0][1]
}

export async function verifyServiceRegistration(registration: ServiceRegistration, run: ServiceCommandRunner = runServiceCommand) {
  if (registration.serviceHash !== await hashServiceFile(registration.serviceFile)
    || (registration.platform === "win32" && (!registration.nativeHash || registration.nativeHash !== await windowsServiceHash(run)))) {
    throw new Error("The installed service definition changed or lacks a verified native fingerprint; refusing to replace custom service settings.")
  }
}

export async function recordServiceRegistration(platform: NodeJS.Platform, launch: ServiceLaunchSpec) {
  if (platform !== "darwin" && platform !== "win32") return
  const serviceFile = platform === "win32" ? getWindowsServicePaths(launch).taskXml : getMacosServicePaths(launch.homeDirectory).plistPath
  const record: ServiceRegistration = { schema: 1, platform, launch, serviceFile, serviceHash: await hashServiceFile(serviceFile),
    ...(platform === "win32" ? { nativeHash: await windowsServiceHash(), windowsCommand: await windowsServiceCommand(serviceFile) } : {}) }
  await atomicJson(path.join(updateRoot(platform, launch.homeDirectory, launch.localAppDataDirectory), "service-registration.json"), record)
}
