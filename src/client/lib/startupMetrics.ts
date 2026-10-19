/** Bounded local diagnostics: no URLs, file paths, messages or account data. */
export function markStartupPhase(phase: "auth-start" | "authenticated" | "socket-start" | "socket-open" | "sidebar-data" | "project-data" | "preferences" | "workspace-data-ready" | "chat-data" | "chat-preferences-ready") {
  if (typeof performance === "undefined") return
  const name = `stillon:startup:${phase}`
  if (!performance.getEntriesByName(name, "mark").length) performance.mark(name)
}
