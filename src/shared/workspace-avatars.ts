import { z } from "zod"

const color = z.string().regex(/^#[0-9a-f]{6}$/iu)
const vector = z.string().min(1).max(4096).regex(/^[MmLlHhVvCcSsQqTtAaZz0-9.,+\s-]+$/u)
const shape = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u), label: z.string().trim().min(1).max(40), body: vector, eyes: vector, eyeWidth: z.number().min(1).max(10) }).strict()
export const workspaceAvatarChoiceSchema = z.object({ shape: z.string().max(40), color }).strict()
export const workspaceAvatarsSchema = z.object({
  schemaVersion: z.literal(1),
  shapes: z.array(shape).min(1).max(32),
  palette: z.array(color).min(1).max(32),
  workspaces: z.record(z.string().min(1).max(256), workspaceAvatarChoiceSchema),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.shapes.map(item => item.id))
  if (ids.size !== value.shapes.length) context.addIssue({ code: "custom", message: "Avatar shape IDs must be unique." })
  if (Object.keys(value.workspaces).length > 4096) context.addIssue({ code: "custom", message: "Too many workspace avatars." })
  for (const choice of Object.values(value.workspaces)) if (!ids.has(choice.shape)) context.addIssue({ code: "custom", message: "Choose an existing avatar shape." })
})
export type WorkspaceAvatars = z.infer<typeof workspaceAvatarsSchema>
export type WorkspaceAvatarChoice = z.infer<typeof workspaceAvatarChoiceSchema>
export interface WorkspaceAvatarsSnapshot { config: WorkspaceAvatars; warning?: string }

export function defaultWorkspaceAvatars(): WorkspaceAvatars {
  const eyes = "M29 20l5 7M41 15l5 7"
  return {
    schemaVersion: 1,
    shapes: [
      { id: "round", label: "Round", body: "M32 4a28 28 0 1 1 0 56a28 28 0 1 1 0-56Z", eyes, eyeWidth: 5.5 },
      { id: "pebble", label: "Pebble", body: "M31 4C47 2 59 15 59 31C61 47 48 59 32 59C15 60 3 49 5 33C6 20 16 5 31 4Z", eyes, eyeWidth: 5.5 },
      { id: "drop", label: "Drop", body: "M16 5C24 1 33 12 45 20C55 27 64 31 59 40C54 50 24 64 13 60C4 57 7 43 8 31C9 18 9 8 16 5Z", eyes: "M23 23l4 7M35 23l4 7", eyeWidth: 5.5 },
      { id: "soft", label: "Soft", body: "M26 5C41 1 55 11 57 25C60 39 54 54 41 58C27 62 8 57 5 46C1 35 14 8 26 5Z", eyes, eyeWidth: 5.5 },
    ],
    palette: ["#4db6a3", "#f3a02d", "#685cf1", "#8a57f5", "#3d7ff5", "#f36d2b", "#d96292", "#566274"],
    workspaces: {},
  }
}

export function workspaceAvatarChoice(config: WorkspaceAvatars, workspaceId: string): WorkspaceAvatarChoice {
  const saved = config.workspaces[workspaceId]
  if (saved && config.shapes.some(shape => shape.id === saved.shape)) return saved
  let hash = 2166136261
  for (const character of workspaceId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  return { shape: config.shapes[hash % config.shapes.length]!.id, color: config.palette[(hash >>> 3) % config.palette.length]! }
}
