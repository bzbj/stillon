import { stat } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import type { ClientCommand } from "../shared/protocol"
import { resolveLocalPath } from "./paths"
import { canOpenMacApp, hasCommand, spawnDetached } from "./process-utils"

type OpenExternalCommand = Extract<ClientCommand, { type: "system.openExternal" }>

interface CommandSpec {
  command: string
  args: string[]
}

export async function openExternal(command: OpenExternalCommand, options: {
  platform?: NodeJS.Platform
  spawn?: typeof spawnDetached
  stat?: (file: string) => Promise<{ isDirectory(): boolean }>
} = {}) {
  const spawn = options.spawn ?? spawnDetached
  // Old clients may still send the retired editor/Preview actions. Never run a saved command.
  const action = command.action === "open_editor" || command.action === "open_preview" ? "open_default" : command.action
  const resolvedPath = resolveLocalPath(command.localPath)
  const platform = options.platform ?? process.platform
  const info = action === "open_finder" || action === "open_default"
    ? await (options.stat ?? stat)(resolvedPath).catch(() => null)
    : null

  if (platform === "darwin") {
    if (action === "open_default") {
      if (!info) {
        throw new Error(`Path not found: ${resolvedPath}`)
      }
      const defaultCommand = buildDefaultOpenCommand({ localPath: resolvedPath, platform })
      await spawn(defaultCommand.command, defaultCommand.args)
      return
    }
    if (action === "open_finder") {
      if (info?.isDirectory()) {
        await spawn("open", [resolvedPath])
      } else {
        await spawn("open", ["-R", resolvedPath])
      }
      return
    }
    if (action === "open_terminal") {
      if (!canOpenMacApp("Terminal")) {
        throw new Error("Terminal is not installed")
      }
      await spawn("open", ["-a", "Terminal", resolvedPath])
      return
    }
  }

  if (platform === "win32") {
    if (action === "open_default") {
      if (!info) {
        throw new Error(`Path not found: ${resolvedPath}`)
      }
      const defaultCommand = buildDefaultOpenCommand({ localPath: resolvedPath, platform })
      await spawn(defaultCommand.command, defaultCommand.args)
      return
    }
    if (action === "open_finder") {
      if (info?.isDirectory()) {
        await spawn("explorer", [resolvedPath])
      } else {
        await spawn("explorer", ["/select,", resolvedPath])
      }
      return
    }
    if (action === "open_terminal") {
      if (hasCommand("wt")) {
        await spawn("wt", ["-d", resolvedPath])
        return
      }
      await spawn("cmd.exe", ["/K"], { cwd: resolvedPath })
      return
    }
  }

  if (action === "open_default") {
    if (!info) {
      throw new Error(`Path not found: ${resolvedPath}`)
    }
    const defaultCommand = buildDefaultOpenCommand({ localPath: resolvedPath, platform })
    await spawn(defaultCommand.command, defaultCommand.args)
    return
  }

  if (action === "open_finder") {
    await spawn("xdg-open", [info?.isDirectory() ? resolvedPath : path.dirname(resolvedPath)])
    return
  }
  if (action === "open_terminal") {
    for (const terminalCommand of ["x-terminal-emulator", "gnome-terminal", "konsole"]) {
      if (!hasCommand(terminalCommand)) continue
      if (terminalCommand === "gnome-terminal") {
        await spawn(terminalCommand, ["--working-directory", resolvedPath])
      } else if (terminalCommand === "konsole") {
        await spawn(terminalCommand, ["--workdir", resolvedPath])
      } else {
        await spawn(terminalCommand, ["--working-directory", resolvedPath])
      }
      return
    }
    await spawn("xdg-open", [resolvedPath])
  }
}

export function buildDefaultOpenCommand(args: {
  localPath: string
  platform: NodeJS.Platform
}): CommandSpec {
  if (args.platform === "darwin") {
    return { command: "open", args: [args.localPath] }
  }
  if (args.platform === "win32") {
    return { command: "explorer.exe", args: [args.localPath] }
  }
  return { command: "xdg-open", args: [args.localPath] }
}
