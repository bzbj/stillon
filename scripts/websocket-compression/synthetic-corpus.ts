import { createHash } from "node:crypto"

export type SyntheticCorpusClass = "chat-like" | "mixed" | "high-entropy"

export interface SyntheticCorpusOptions {
  clientIndex?: number
  corpusClass: SyntheticCorpusClass
  seed?: number
  targetBytes: number
}

export interface SyntheticCorpus {
  actualBytes: number
  corpusClass: SyntheticCorpusClass
  payload: string
  seed: number
  sha256: string
  targetBytes: number
}

export const DEFAULT_SYNTHETIC_CORPUS_SEED = 69_001
export const SYNTHETIC_CORPUS_CLASSES: readonly SyntheticCorpusClass[] = [
  "chat-like",
  "mixed",
  "high-entropy",
]

const CHAT_PATTERN =
  "user message alpha assistant response beta tool call read file result success " +
  "status running command synthetic project source line update complete "
const RANDOM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

function createXorshift32(seed: number) {
  let state = seed >>> 0
  if (state === 0) state = 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}

function buildAsciiContent(
  corpusClass: SyntheticCorpusClass,
  byteLength: number,
  seed: number,
) {
  if (corpusClass === "chat-like") {
    return CHAT_PATTERN.repeat(Math.ceil(byteLength / CHAT_PATTERN.length)).slice(0, byteLength)
  }

  const random = createXorshift32(seed)
  const chunks: string[] = []
  let generated = 0
  while (generated < byteLength) {
    const chunkLength = Math.min(8_192, byteLength - generated)
    const characters = new Array<string>(chunkLength)
    for (let index = 0; index < chunkLength; index++) {
      if (corpusClass === "mixed" && (generated + index) % 4 !== 3) {
        characters[index] = CHAT_PATTERN[(generated + index) % CHAT_PATTERN.length]!
      } else {
        characters[index] = RANDOM_ALPHABET[random() % RANDOM_ALPHABET.length]!
      }
    }
    chunks.push(characters.join(""))
    generated += chunkLength
  }
  return chunks.join("")
}

export function createSyntheticCorpus(options: SyntheticCorpusOptions): SyntheticCorpus {
  const seed = options.seed ?? DEFAULT_SYNTHETIC_CORPUS_SEED
  const clientIndex = options.clientIndex ?? 0
  if (!Number.isSafeInteger(options.targetBytes) || options.targetBytes <= 0) {
    throw new RangeError(`targetBytes must be a positive safe integer, received ${options.targetBytes}`)
  }
  if (!Number.isSafeInteger(clientIndex) || clientIndex < 0) {
    throw new RangeError(`clientIndex must be a non-negative safe integer, received ${clientIndex}`)
  }

  const envelope = {
    type: "snapshot",
    subscriptionId: `benchmark-${clientIndex}`,
    topic: "chat",
    data: {
      synthetic: true,
      corpusClass: options.corpusClass,
      seed,
      languageSample: "你好世界🙂",
      content: "",
    },
  }
  const emptyPayload = JSON.stringify(envelope)
  const fixedBytes = Buffer.byteLength(emptyPayload, "utf8")
  const contentBytes = options.targetBytes - fixedBytes
  if (contentBytes < 0) {
    throw new RangeError(
      `targetBytes ${options.targetBytes} is smaller than the ${fixedBytes}-byte synthetic envelope`,
    )
  }

  envelope.data.content = buildAsciiContent(options.corpusClass, contentBytes, seed + clientIndex)
  const payload = JSON.stringify(envelope)
  const actualBytes = Buffer.byteLength(payload, "utf8")
  if (actualBytes !== options.targetBytes) {
    throw new Error(
      `Synthetic corpus size mismatch: expected ${options.targetBytes}, generated ${actualBytes}`,
    )
  }

  return {
    actualBytes,
    corpusClass: options.corpusClass,
    payload,
    seed,
    sha256: createHash("sha256").update(payload).digest("hex"),
    targetBytes: options.targetBytes,
  }
}
