import { beforeEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_RIGHT_SIDEBAR_SIZE,
  getDefaultRightSidebarVisibilityState,
  migrateRightSidebarStore,
  RIGHT_SIDEBAR_MIN_WIDTH_PX,
  useRightSidebarStore,
} from "./rightSidebarStore"

const PROJECT_ID = "project-1"

describe("rightSidebarStore", () => {
  beforeEach(() => {
    useRightSidebarStore.setState({ size: DEFAULT_RIGHT_SIDEBAR_SIZE, projects: {}, projectBrowser: {} })
  })

  test("defaults to a closed drawer", () => {
    const visibility = useRightSidebarStore.getState().projects[PROJECT_ID] ?? getDefaultRightSidebarVisibilityState()
    expect(visibility.rightPanel).toBe("hidden")
    expect(useRightSidebarStore.getState().size).toBe(DEFAULT_RIGHT_SIDEBAR_SIZE)
  })
  test("SPA replace and pop navigation update the current history without appending duplicates", () => {
    const store = useRightSidebarStore.getState()
    store.navigateBrowser(PROJECT_ID, "http://localhost:5173/one")
    store.navigateBrowser(PROJECT_ID, "http://localhost:5173/two")
    store.syncBrowserAddress(PROJECT_ID, "http://localhost:5173/two?tab=active", "replace")
    expect(useRightSidebarStore.getState().projectBrowser[PROJECT_ID]?.history).toEqual(["http://localhost:5173/one", "http://localhost:5173/two?tab=active"])
    store.syncBrowserAddress(PROJECT_ID, "http://localhost:5173/one", "pop")
    expect(useRightSidebarStore.getState().projectBrowser[PROJECT_ID]?.historyIndex).toBe(0)
  })

  test("exports the expected pixel min width", () => {
    expect(RIGHT_SIDEBAR_MIN_WIDTH_PX).toBe(370)
  })

  test("keeps visibility isolated per project while sharing width", () => {
    useRightSidebarStore.getState().togglePanel(PROJECT_ID, "browser")
    useRightSidebarStore.getState().setSize(430)
    useRightSidebarStore.getState().togglePanel("project-2", "browser")

    expect(useRightSidebarStore.getState().projects[PROJECT_ID]).toEqual({
      rightPanel: "browser",
    })
    expect(useRightSidebarStore.getState().projects["project-2"]).toEqual({
      rightPanel: "browser",
    })
    expect(useRightSidebarStore.getState().size).toBe(430)
  })

  test("clamps resized widths", () => {
    useRightSidebarStore.getState().setSize(100)
    expect(useRightSidebarStore.getState().size).toBe(RIGHT_SIDEBAR_MIN_WIDTH_PX)

    useRightSidebarStore.getState().setSize(560)
    expect(useRightSidebarStore.getState().size).toBe(560)
  })

  test("toggles the browser drawer without affecting another project", () => {
    const store = useRightSidebarStore.getState()
    store.togglePanel(PROJECT_ID, "browser")
    store.togglePanel("project-2", "browser")
    store.togglePanel(PROJECT_ID, "browser")
    expect(useRightSidebarStore.getState().projects[PROJECT_ID]?.rightPanel).toBe("hidden")
    expect(useRightSidebarStore.getState().projects["project-2"]?.rightPanel).toBe("browser")
  })

  test("discards retired Git state while preserving browser navigation", () => {
    const browser = { address: "/api/projects/project-2/preview/report.html", history: ["http://localhost:3000", "/api/projects/project-2/preview/report.html"], historyIndex: 1, zoom: 1.3 }
    const migrated = migrateRightSidebarStore({
      size: 600,
      projects: { [PROJECT_ID]: { rightPanel: "git" }, "project-2": { rightPanel: "browser" } },
      projectUi: { [PROJECT_ID]: { viewMode: "changes", summary: "old draft", collapsedPaths: { "report.md": false } } },
      projectBrowser: { "project-2": browser },
    }, 7)
    expect(migrated).toEqual({
      size: 600,
      projects: { [PROJECT_ID]: { rightPanel: "hidden" }, "project-2": { rightPanel: "browser" } },
      projectBrowser: { "project-2": browser },
    })
  })

  test("clearing a project removes its saved drawer state without resetting global width", () => {
    useRightSidebarStore.getState().togglePanel(PROJECT_ID, "browser")
    useRightSidebarStore.getState().setSize(440)
    useRightSidebarStore.getState().navigateBrowser(PROJECT_ID, "localhost:3000")
    useRightSidebarStore.getState().clearProject(PROJECT_ID)

    const visibility = useRightSidebarStore.getState().projects[PROJECT_ID] ?? getDefaultRightSidebarVisibilityState()
    expect(visibility.rightPanel).toBe("hidden")
    expect(useRightSidebarStore.getState().size).toBe(440)
    expect(useRightSidebarStore.getState().projectBrowser[PROJECT_ID]).toBeUndefined()
  })

  test("migration closes retired drawers and resets width to the pixel default", async () => {
    const migrated = await migrateRightSidebarStore({
        projects: {
          [PROJECT_ID]: {
            isVisible: true,
            size: 34,
          },
          "project-2": {
            isVisible: false,
            size: 26,
          },
        },
      })

    expect(migrated).toEqual({
      size: DEFAULT_RIGHT_SIDEBAR_SIZE,
      projects: {
        [PROJECT_ID]: {
          rightPanel: "hidden",
        },
        "project-2": {
          rightPanel: "hidden",
        },
      },
      projectBrowser: {},
    })
  })

  test("migration preserves persisted right panel choices", async () => {
    const migrated = await migrateRightSidebarStore({
      projects: {
        [PROJECT_ID]: {
          rightPanel: "browser",
        },
      },
    })

    expect(migrated).toEqual({
      size: DEFAULT_RIGHT_SIDEBAR_SIZE,
      projects: {
        [PROJECT_ID]: {
          rightPanel: "browser",
        },
      },
      projectBrowser: {},
    })
  })

  test("keeps browser state isolated per project", () => {
    useRightSidebarStore.getState().navigateBrowser(PROJECT_ID, "localhost:3000")
    useRightSidebarStore.getState().navigateBrowser(PROJECT_ID, "http://localhost:3001")
    useRightSidebarStore.getState().setBrowserZoom(PROJECT_ID, 1.25)
    useRightSidebarStore.getState().goBrowserBack(PROJECT_ID)

    useRightSidebarStore.getState().navigateBrowser("project-2", "localhost:4000")

    expect(useRightSidebarStore.getState().projectBrowser[PROJECT_ID]).toEqual({
      address: "http://localhost:3000",
      history: ["http://localhost:3000", "http://localhost:3001"],
      historyIndex: 0,
      zoom: 1.3,
    })
    expect(useRightSidebarStore.getState().projectBrowser["project-2"]).toEqual({
      address: "http://localhost:4000",
      history: ["http://localhost:4000"],
      historyIndex: 0,
      zoom: 1,
    })
  })

  test("keeps same-origin browser preview addresses relative", () => {
    useRightSidebarStore.getState().navigateBrowser(PROJECT_ID, "/api/projects/project-1/preview/output/index.html")

    expect(useRightSidebarStore.getState().projectBrowser[PROJECT_ID]).toEqual({
      address: "/api/projects/project-1/preview/output/index.html",
      history: ["/api/projects/project-1/preview/output/index.html"],
      historyIndex: 0,
      zoom: 1,
    })
  })
})
