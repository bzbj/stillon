import { expect, test } from "bun:test"
import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { LocalDev } from "./LocalDev"

const props: ComponentProps<typeof LocalDev> = {
  connectionStatus: "connected", ready: true, sidebarReady: true,
  projectGroups: [], selectedProjectId: null, defaultProjectId: null,
  onSelectedProjectChange: () => {}, onDefaultProjectChange: () => {},
  onSend: async () => {}, availableProviders: [], preferencesReady: true,
  codexTransport: "app-server", commandError: null, newProjectOpen: false,
  onNewProjectOpenChange: () => {}, onCreateProject: async () => {},
  onListDirectories: async () => { throw new Error("unused") },
  onResolveLocalPath: async () => { throw new Error("unused") },
}

test("starting a new conversation preserves the home heading and has no intermediate transcript", () => {
  for (const isStartingConversation of [false, true]) {
    const html = renderToStaticMarkup(createElement(LocalDev, { ...props, isStartingConversation }))
    expect(html).toContain("What would you like to build?")
    expect(html).not.toContain("Starting conversation…")
    expect(html).not.toContain('aria-label="Starting conversation"')
    expect(html).toContain(`aria-busy="${isStartingConversation}"`)
  }
})
