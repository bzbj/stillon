import { createHash, randomUUID } from "node:crypto"
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import { APPEARANCE_API, BACKGROUND_ASSET_PATTERN, defaultAppearance, normalizeAppearance, type AppearanceSettings, type SkinPackage } from "../shared/appearance"

export const MAX_BACKGROUND_BYTES = 2 * 1024 * 1024
export const MAX_SKIN_BYTES = 3 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 4096
const MAX_IMAGE_PIXELS = 12_000_000
const mimeByExtension = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const
class AppearanceError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

async function boundedBody(request: Request, limit: number) {
  if (Number(request.headers.get("content-length")) > limit) throw new AppearanceError("File is too large.", 413)
  const reader = request.body?.getReader()
  if (!reader) throw new AppearanceError("Choose a file first.")
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) { await reader.cancel(); throw new AppearanceError("File is too large.", 413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, total)
}

function imageDimensions(bytes: Buffer, extension: "png" | "jpg" | "webp"): [number, number] {
  if (extension === "png") {
    if (bytes.length < 33 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new AppearanceError("Invalid PNG image.")
    let offset = 8, ended = false
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset)
      if (offset + size + 12 > bytes.length) throw new AppearanceError("Invalid PNG image.")
      const type = bytes.toString("ascii", offset + 4, offset + 8)
      if (type === "acTL") throw new AppearanceError("Choose a still image for the background.")
      offset += size + 12
      if (type === "IEND") { ended = true; break }
    }
    if (!ended) throw new AppearanceError("Invalid PNG image.")
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  }
  if (extension === "webp") {
    if (bytes.length < 30 || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new AppearanceError("Invalid WebP image.")
    const type = bytes.toString("ascii", 12, 16)
    if (type === "VP8X") {
      if (bytes[20]! & 2) throw new AppearanceError("Choose a still image for the background.")
      return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1]
    }
    if (type === "VP8 ") {
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) throw new AppearanceError("Invalid WebP image.")
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff]
    }
    if (type === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21)
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
    }
    throw new AppearanceError("Invalid WebP image.")
  }
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new AppearanceError("Invalid JPEG image.")
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]!
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
    if (offset + 2 > bytes.length) break
    const size = bytes.readUInt16BE(offset)
    if (size < 2 || offset + size > bytes.length) break
    if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)]
    offset += size
  }
  throw new AppearanceError("Invalid JPEG image.")
}

export async function validateBackground(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_BACKGROUND_BYTES) throw new AppearanceError("Background images must be 2 MB or smaller.", 413)
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined)
  const extension = detected?.ext
  if (extension !== "png" && extension !== "jpg" && extension !== "webp") throw new AppearanceError("Choose a PNG, JPEG or WebP image.")
  const [width, height] = imageDimensions(bytes, extension)
  if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw new AppearanceError("Background images must be at most 4096 px per side and 12 megapixels.")
  }
  return { extension, mimeType: mimeByExtension[extension], width, height }
}

async function appearanceDirectory(dataDir: string, leaf: "assets" | "skins", create = false) {
  let directory = path.resolve(dataDir)
  const parts = [directory, "customizations", "appearance", leaf]
  for (let i = 0; i < parts.length; i++) {
    if (i) directory = path.join(directory, parts[i]!)
    if (create) await mkdir(directory, { recursive: false }).catch((error) => { if (error.code !== "EEXIST") throw error })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AppearanceError("The appearance folder must be a local directory.")
  }
  return directory
}

async function readImmutable(directory: string, filename: string) {
  const filenamePath = path.join(directory, filename)
  const info = await lstat(filenamePath)
  if (!info.isFile() || info.isSymbolicLink()) throw new AppearanceError("Invalid appearance file.")
  if (info.size > MAX_SKIN_BYTES) throw new AppearanceError("Invalid appearance file.")
  const bytes = await readFile(filenamePath)
  if (createHash("sha256").update(bytes).digest("hex") !== filename.split(".")[0]) throw new AppearanceError("Appearance file is damaged.")
  return bytes
}

async function storeImmutable(dataDir: string, leaf: "assets" | "skins", bytes: Buffer, extension: string) {
  const directory = await appearanceDirectory(dataDir, leaf, true)
  const id = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`
  const temporary = path.join(directory, `.upload-${randomUUID()}`)
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
  try {
    await link(temporary, path.join(directory, id)).catch((error) => { if (error.code !== "EEXIST") throw error })
    await readImmutable(directory, id)
  } finally { await unlink(temporary).catch(() => {}) }
  return id
}

export async function saveBackground(dataDir: string, bytes: Buffer) {
  const metadata = await validateBackground(bytes)
  return { asset: await storeImmutable(dataDir, "assets", bytes, metadata.extension), ...metadata }
}

function validateSkinValues(value: Record<string, unknown>) {
  const normalized = normalizeAppearance(value)
  const allowed = Object.keys(defaultAppearance()).filter((key) => key !== "backgroundAsset" && key !== "skinName")
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.includes(key)) throw new AppearanceError(`Unsupported skin setting: ${key.slice(0, 40)}.`)
    if (JSON.stringify(raw) !== JSON.stringify(normalized[key as keyof AppearanceSettings]) && !(typeof raw === "string" && raw.toLowerCase() === normalized[key as keyof AppearanceSettings])) {
      throw new AppearanceError(`Invalid skin setting: ${key}.`)
    }
  }
  return normalized
}

export async function importSkin(dataDir: string, bytes: Buffer) {
  if (bytes.length > MAX_SKIN_BYTES) throw new AppearanceError("Skin files must be 3 MB or smaller.", 413)
  let raw: Record<string, unknown>
  try { raw = JSON.parse(bytes.toString("utf8")) } catch { throw new AppearanceError("This is not a valid skin JSON file.") }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.format !== "stillon-skin") throw new AppearanceError("Choose a StillOn skin file.")
  if (raw.themeApi !== APPEARANCE_API || raw.uiApi !== APPEARANCE_API) {
    await storeImmutable(dataDir, "skins", bytes, "json")
    throw new AppearanceError("This skin uses an unsupported version. Its file was kept; your appearance has not changed.", 422)
  }
  if (Object.keys(raw).some((key) => !["format", "themeApi", "uiApi", "name", "appearance", "background"].includes(key))) throw new AppearanceError("This skin contains unsupported fields.")
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 80) throw new AppearanceError("Skin names must be 1–80 characters.")
  if (!raw.appearance || typeof raw.appearance !== "object" || Array.isArray(raw.appearance)) throw new AppearanceError("This skin has no appearance settings.")
  const appearance = validateSkinValues(raw.appearance as Record<string, unknown>)
  if (raw.background !== undefined) {
    const background = raw.background as Record<string, unknown>
    if (!background || Object.keys(background).some((key) => !["base64", "mimeType"].includes(key)) || typeof background.base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(background.base64) || background.base64.length % 4) throw new AppearanceError("Invalid skin background image.")
    const content = Buffer.from(background.base64, "base64")
    const metadata = await validateBackground(content)
    if (background.mimeType !== metadata.mimeType) throw new AppearanceError("The background image format does not match the file.")
    appearance.backgroundAsset = (await saveBackground(dataDir, content)).asset
  }
  appearance.skinName = raw.name.trim()
  const id = await storeImmutable(dataDir, "skins", bytes, "json")
  return { id, appearance }
}

export async function exportSkin(dataDir: string, settings: AppearanceSettings): Promise<SkinPackage> {
  const { backgroundAsset, skinName, ...appearance } = normalizeAppearance(settings)
  const skin: SkinPackage = { format: "stillon-skin", themeApi: 1, uiApi: 1, name: skinName ?? "My StillOn skin", appearance }
  if (backgroundAsset) {
    const bytes = await readImmutable(await appearanceDirectory(dataDir, "assets"), backgroundAsset)
    const metadata = await validateBackground(bytes)
    skin.background = { mimeType: metadata.mimeType, base64: bytes.toString("base64") }
  }
  return skin
}

export async function handleAppearanceRequest(req: Request, url: URL, options: {
  dataDir: string
  getAppearance: () => AppearanceSettings
  validateOrigin: (req: Request) => boolean
}): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/appearance/")) return null
  const asset = url.pathname.match(/^\/api\/appearance\/assets\/([a-f0-9]{64}\.(?:png|jpg|webp))$/)?.[1]
  const importing = url.pathname === "/api/appearance/skins/import"
  const uploading = url.pathname === "/api/appearance/background"
  const exporting = url.pathname === "/api/appearance/skin/export"
  if (!asset && !importing && !uploading && !exporting) return new Response("Not found", { status: 404 })
  const method = importing || uploading ? "POST" : "GET"
  if (req.method !== method) return new Response(null, { status: 405, headers: { Allow: method } })
  if (method === "POST" && !options.validateOrigin(req)) return new Response("Forbidden", { status: 403 })
  try {
    if (asset && BACKGROUND_ASSET_PATTERN.test(asset)) {
      const bytes = await readImmutable(await appearanceDirectory(options.dataDir, "assets"), asset)
      return new Response(bytes, { headers: {
        "Content-Type": mimeByExtension[asset.split(".")[1] as keyof typeof mimeByExtension],
        "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      } })
    }
    if (exporting) {
      const skin = await exportSkin(options.dataDir, options.getAppearance())
      return Response.json(skin, { headers: { "Cache-Control": "no-store", "Content-Disposition": 'attachment; filename="stillon-skin.json"' } })
    }
    const bytes = await boundedBody(req, importing ? MAX_SKIN_BYTES : MAX_BACKGROUND_BYTES)
    const result = importing ? await importSkin(options.dataDir, bytes) : await saveBackground(options.dataDir, bytes)
    return Response.json(result, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Response("Not found", { status: 404 })
    return Response.json({ error: error instanceof AppearanceError ? error.message : "Unable to read or save this appearance file." }, { status: error instanceof AppearanceError ? error.status : 400 })
  }
}
