import type { ClientCommand } from "../../shared/protocol"
import type { QuickCommand } from "../../shared/quick-commands"
import type { ChatTurnPreferences } from "../../shared/types"

export type QuickCommandRequest = Extract<ClientCommand, { type: "chat.startQuickCommand" }>
export interface QuickCommandResult { chatId: string; error?: string; promptSaved?: boolean }
export interface QuickCommandReceipt {
  state: "pending" | "complete" | "unknown" | "not-received"
  response?: { type: string; result?: QuickCommandResult; message?: string } | null
}
export interface CompletedQuickCommand { projectId: string; command: QuickCommand; preferences: ChatTurnPreferences; result: QuickCommandResult }
interface Launch {
  id: string
  projectId: string
  command: QuickCommand
  preferences: ChatTurnPreferences
  promise?: Promise<CompletedQuickCommand>
}

/** A confirmed server rejection is different from a disconnected waiter. */
export class ConfirmedCommandError extends Error {}

export class QuickCommandDelivery {
  private readonly pending = new Map<string, Launch>()
  constructor(
    private readonly send: (request: QuickCommandRequest, id: string) => Promise<QuickCommandResult>,
    private readonly lookup?: (id: string) => Promise<QuickCommandReceipt>,
  ) {}

  start(projectId: string, command: QuickCommand, preferences: ChatTurnPreferences): Promise<CompletedQuickCommand> {
    const previous = this.pending.get(projectId)
    if (previous?.promise) return previous.promise
    const launch: Launch = previous ?? {
      id: `${Date.now()}-${crypto.randomUUID()}`,
      projectId,
      command: { ...command },
      preferences: { ...preferences, modelOptions: { ...preferences.modelOptions } } as ChatTurnPreferences,
    }
    this.pending.set(projectId, launch)
    launch.promise = Promise.resolve().then(async () => {
      let result: QuickCommandResult
      if (previous) result = await this.recover(launch)
      else {
        try {
          result = await this.send({ type: "chat.startQuickCommand", projectId, name: launch.command.name, content: launch.command.prompt, preferences: launch.preferences }, launch.id)
        } catch (error) {
          if (error instanceof ConfirmedCommandError) { this.pending.delete(projectId); throw error }
          result = await this.recover(launch)
        }
      }
      this.pending.delete(projectId)
      return { projectId: launch.projectId, command: launch.command, preferences: launch.preferences, result }
    }).finally(() => { launch.promise = undefined })
    return launch.promise
  }

  private async recover(launch: Launch): Promise<QuickCommandResult> {
    if (this.lookup) {
      let receipt: QuickCommandReceipt | undefined
      try { receipt = await this.lookup(launch.id) } catch { /* Keep the uncertain receipt; never resend. */ }
      if (receipt?.state === "complete" && receipt.response) {
        if (receipt.response.type === "ack" && receipt.response.result?.chatId) return receipt.response.result
        if (receipt.response.type === "error") { this.pending.delete(launch.projectId); throw new ConfirmedCommandError(receipt.response.message || "Unable to start the command.") }
      }
      // A missing receipt may race a delayed WebSocket request. It is not
      // proof that the original action can no longer arrive; keep it fenced.

    }
    throw new Error("The command's result is not confirmed. Check this workspace's new conversation before starting again. Selecting a command here will check the existing request; it will not resend it.")
  }
}
