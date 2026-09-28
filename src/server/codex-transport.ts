import type { CodexTransport } from "../shared/types"
import { CodexAppServerManager, type StartCodexTurnArgs } from "./codex-app-server"
import { CodexExecManager, type StartCodexExecSessionArgs, type StartCodexExecTurnArgs } from "./codex-exec"
import type { EventStore } from "./event-store"

/**
 * A chat keeps its selected transport for the life of its Codex thread.
 * Existing chats without a recorded transport stay on exec.
 */
export class CodexTransportManager {
  private readonly exec: CodexExecManager
  private readonly appServer: CodexAppServerManager

  constructor(
    private readonly store: EventStore,
    private readonly getDefaultTransport: () => CodexTransport,
    getEnvironment: () => NodeJS.ProcessEnv,
    managers?: { exec?: CodexExecManager; appServer?: CodexAppServerManager },
  ) {
    this.exec = managers?.exec ?? new CodexExecManager({ getEnvironment })
    this.appServer = managers?.appServer ?? new CodexAppServerManager({ getEnvironment })
  }

  private transportFor(chatId: string): CodexTransport {
    const chat = this.store.requireChat(chatId)
    return chat.codexTransport
      ?? (chat.sessionToken || chat.pendingForkSessionToken ? "exec" : this.getDefaultTransport())
  }

  private managerFor(chatId: string) {
    return this.transportFor(chatId) === "app-server" ? this.appServer : this.exec
  }

  async startSession(args: StartCodexExecSessionArgs) {
    const transport = this.transportFor(args.chatId)
    await this.store.setCodexTransport(args.chatId, transport)
    return transport === "app-server"
      ? await this.appServer.startSession(args)
      : await this.exec.startSession(args)
  }

  async startTurn(args: StartCodexExecTurnArgs & Pick<StartCodexTurnArgs, "onApprovalRequest">) {
    return this.transportFor(args.chatId) === "app-server"
      ? await this.appServer.startTurn(args)
      : await this.exec.startTurn(args)
  }

  async generateStructured(args: Parameters<CodexExecManager["generateStructured"]>[0]) {
    return await this.exec.generateStructured(args)
  }

  supportsNativeSteerForChat(chatId: string) {
    return this.transportFor(chatId) === "app-server"
  }

  getActiveTurnId(chatId: string) {
    return this.managerFor(chatId).getActiveTurnId(chatId)
  }

  async steerTurn(args: Parameters<CodexAppServerManager["steerTurn"]>[0]) {
    if (!this.supportsNativeSteerForChat(args.chatId)) {
      throw new Error("Codex exec cannot steer an active turn")
    }
    return await this.appServer.steerTurn(args)
  }

  async stopSession(chatId: string) {
    await Promise.all([
      Promise.resolve(this.exec.stopSession(chatId)),
      Promise.resolve(this.appServer.stopSession(chatId)),
    ])
  }

  async stopAll() {
    await Promise.all([
      Promise.resolve(this.exec.stopAll()),
      Promise.resolve(this.appServer.stopAll()),
    ])
  }
}
