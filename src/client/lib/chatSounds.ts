import type { ChatSoundId, ChatSoundPreference } from "../stores/chatSoundPreferencesStore"

const CHAT_SOUND_SRC: Record<ChatSoundId, string> = {
  blow: "/chat-sounds/Blow.mp3",
  bottle: "/chat-sounds/Bottle.mp3",
  frog: "/chat-sounds/Frog.mp3",
  funk: "/chat-sounds/Funk.mp3",
  glass: "/chat-sounds/Glass.mp3",
  ping: "/chat-sounds/Ping.mp3",
  pop: "/chat-sounds/Pop.mp3",
  purr: "/chat-sounds/Purr.mp3",
  tink: "/chat-sounds/Tink.mp3",
}

export function isBrowserUnfocused(doc: Pick<Document, "visibilityState" | "hasFocus"> = document) {
  return doc.visibilityState !== "visible" || !doc.hasFocus()
}

function playSingleChatSound(soundId: ChatSoundId) {
  const audio = new Audio(CHAT_SOUND_SRC[soundId])
  audio.preload = "auto"
  return audio.play()
}

export async function playChatNotificationSound(soundId: ChatSoundId, count: number) {
  if (count <= 0) {
    return
  }

  const tasks = Array.from({ length: count }, (_, index) => new Promise<void>((resolve) => {
    window.setTimeout(() => {
      void playSingleChatSound(soundId).catch(() => undefined).finally(() => resolve())
    }, index * 90)
  }))

  await Promise.all(tasks)
}

export function shouldPlayChatSound(
  preference: ChatSoundPreference,
  doc: Pick<Document, "visibilityState" | "hasFocus"> = document
) {
  if (preference === "never") return false
  if (preference === "always") return true
  return isBrowserUnfocused(doc)
}
