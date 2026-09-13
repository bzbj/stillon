import { createHash } from "node:crypto"
import path from "node:path"
import { getMacosServicePaths } from "../service/macos"
import { getWindowsServicePaths } from "../service/windows"
import type { ServiceLaunchSpec } from "../service/types"
import { atomicJson } from "./files"
import { updateRoot } from "./model"

export interface ServiceRegistration {
  schema: 1
  platform: "darwin" | "win32"
  launch: ServiceLaunchSpec
  serviceFile: string
  serviceHash: string
}

export async function hashServiceFile(file: string) {
  return createHash("sha256").update(Buffer.from(await Bun.file(file).arrayBuffer())).digest("hex")
}

export async function recordServiceRegistration(platform: NodeJS.Platform, launch: ServiceLaunchSpec) {
  if (platform !== "darwin" && platform !== "win32") return
  const serviceFile = platform === "win32" ? getWindowsServicePaths(launch).taskXml : getMacosServicePaths(launch.homeDirectory).plistPath
  const record: ServiceRegistration = { schema: 1, platform, launch, serviceFile, serviceHash: await hashServiceFile(serviceFile) }
  await atomicJson(path.join(updateRoot(platform, launch.homeDirectory, launch.localAppDataDirectory), "service-registration.json"), record)
}
