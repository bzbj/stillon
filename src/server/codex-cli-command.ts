export function getCodexCliCommand(platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? "codex.cmd" : "codex"
}
