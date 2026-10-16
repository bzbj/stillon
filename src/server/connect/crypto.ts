import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto"
import { CONNECT_LEASE_MS, CONNECT_PROTOCOL, type AccessLease, type DeviceProof } from "../../shared/connect"

export const randomId = () => randomBytes(16).toString("hex")
export const randomToken = () => randomBytes(32).toString("base64url")
export const hashToken = (value: string) => createHash("sha256").update(value).digest("hex")
export const pkceChallenge = (value: string) => createHash("sha256").update(value).digest("base64url")

export function newDeviceKeys() {
  const keys = generateKeyPairSync("ed25519")
  return {
    publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  }
}
export function publicKey(value: string): KeyObject {
  if (!/^[\w-]{59}$/.test(value)) throw new Error("Invalid device key")
  const key = createPublicKey({ key: Buffer.from(value, "base64url"), type: "spki", format: "der" })
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Invalid device key type")
  return key
}
export function privateKey(value: string): KeyObject {
  if (!/^[\w-]{64}$/.test(value)) throw new Error("Invalid private key")
  const key = createPrivateKey({ key: Buffer.from(value, "base64url"), type: "pkcs8", format: "der" })
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Invalid private key type")
  return key
}
export function validateDeviceKeys(keys: ReturnType<typeof newDeviceKeys>) {
  const message = Buffer.from("stillon-connect-key-pair-v1")
  if (!verify(null, message, publicKey(keys.publicKey), sign(null, message, privateKey(keys.privateKey)))) throw new Error("Mismatched device key pair")
}
function proofBytes(proof: Omit<DeviceProof, "signature">) {
  return Buffer.from(JSON.stringify([CONNECT_PROTOCOL, proof.subject, proof.challenge, proof.action, proof.payload]))
}
export function signProof(proof: Omit<DeviceProof, "signature">, key: string): DeviceProof {
  return { ...proof, signature: sign(null, proofBytes(proof), privateKey(key)).toString("base64url") }
}
export function verifyProof(proof: DeviceProof, key: string) {
  try { return /^[\w-]{86}$/.test(proof.signature) && verify(null, proofBytes(proof), publicKey(key), Buffer.from(proof.signature, "base64url")) }
  catch { return false }
}
export function signLease(lease: AccessLease, key: string) {
  const data = Buffer.from(JSON.stringify(lease)).toString("base64url")
  return `${data}.${sign(null, Buffer.from(data), privateKey(key)).toString("base64url")}`
}
export function verifyLease(token: string, key: string, now = Date.now()): AccessLease | null {
  try {
    if (token.length > 16_384) return null
    const [data, signature, extra] = token.split(".")
    if (!data || !signature || extra || !/^[\w-]{86}$/.test(signature)) return null
    if (!verify(null, Buffer.from(data), publicKey(key), Buffer.from(signature, "base64url"))) return null
    const lease = JSON.parse(Buffer.from(data, "base64url").toString()) as AccessLease
    if (lease.v !== 1 || ![lease.id, lease.hostId, lease.sessionId, lease.parentId, lease.ownerId].every(v => typeof v === "string" && v.length > 0 && v.length < 256)
      || !Number.isSafeInteger(lease.generation) || !Number.isSafeInteger(lease.epoch)
      || !Number.isSafeInteger(lease.issuedAt) || !Number.isSafeInteger(lease.expiresAt)
      || lease.issuedAt > now + 5_000 || lease.expiresAt <= now
      || lease.expiresAt - lease.issuedAt > CONNECT_LEASE_MS || lease.expiresAt <= lease.issuedAt
      || typeof lease.method !== "string" || typeof lease.path !== "string" || !lease.path.startsWith("/")) return null
    return lease
  } catch { return null }
}
export function safeRelativePath(value: unknown) {
  if (typeof value !== "string" || value.length > 4_096 || !value.startsWith("/") || value.startsWith("//")
    || /[\\\u0000-\u0020]/.test(value) || value.startsWith("/_connect/")) return "/"
  try {
    const decoded = decodeURIComponent(value)
    if (decoded.startsWith("//") || /[\\\u0000-\u0020]/.test(decoded)) return "/"
    return value
  } catch { return "/" }
}
