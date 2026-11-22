import type { ClientCommand } from "../../shared/protocol"
import { ConfirmedCommandError } from "./quickCommandDelivery"
import type { StillOnSocket } from "./socket"

export class InterruptedOperation extends Error {
  constructor(readonly operationId: string) {
    super(`连接中断，结果尚未确认。请先查看任务状态，勿重复提交。（操作 ${operationId}）`)
  }
}

type MessageCommand = Extract<ClientCommand, { type: "chat.send" | "message.enqueue" }>

// Only reconcile the original operation. A missing receipt can race a delayed write.
export async function deliverMessage<TResult>(socket: Pick<StillOnSocket, "command" | "onStatus">, command: MessageCommand): Promise<TResult> {
  try {
    return await socket.command<TResult>(command)
  } catch (error) {
    if (!(error instanceof InterruptedOperation)) throw error
    const signal = AbortSignal.timeout(15_000)
    let unsubscribe: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(error), { once: true })
        unsubscribe = socket.onStatus(status => { if (status === "connected") resolve() })
      })
      const response = await fetch(`/api/connect-operations/${encodeURIComponent(error.operationId)}`, { cache: "no-store", signal })
      if (!response.ok) throw error
      const receipt = await response.json()
      const reply = receipt.response
      if (receipt.state !== "complete" || reply?.id !== error.operationId) throw error
      if (reply.type === "ack") return reply.result as TResult
      if (reply.type === "error") throw new ConfirmedCommandError(reply.message)
    } catch (failure) {
      if (failure instanceof ConfirmedCommandError) throw failure
    } finally {
      unsubscribe?.()
    }
    throw error
  }
}
