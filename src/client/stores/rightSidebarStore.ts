import { create } from "zustand"
import { persist } from "zustand/middleware"
import { privateBrowserStorage } from "../lib/remoteSession"

export interface ProjectRightSidebarVisibilityState {
  rightPanel: "hidden" | "browser"
}

export interface ProjectBrowserPanelState {
  address: string
  history: string[]
  historyIndex: number
  zoom: number
}

interface RightSidebarState {
  syncBrowserAddress: (projectId: string, address: string, mode: "replace" | "pop") => void
  size: number
  projects: Record<string, ProjectRightSidebarVisibilityState>
  projectBrowser: Record<string, ProjectBrowserPanelState>
  togglePanel: (projectId: string, panel: Exclude<ProjectRightSidebarVisibilityState["rightPanel"], "hidden">) => void
  hidePanel: (projectId: string) => void
  setSize: (size: number) => void
  navigateBrowser: (projectId: string, address: string) => void
  goBrowserBack: (projectId: string) => void
  goBrowserForward: (projectId: string) => void
  setBrowserZoom: (projectId: string, zoom: number | ((current: number) => number)) => void
  clearProject: (projectId: string) => void
}

export const DEFAULT_RIGHT_SIDEBAR_SIZE = 420
export const RIGHT_SIDEBAR_MIN_WIDTH_PX = 370

function clampSize(size: number) {
  if (!Number.isFinite(size)) return DEFAULT_RIGHT_SIDEBAR_SIZE
  return Math.max(RIGHT_SIDEBAR_MIN_WIDTH_PX, size)
}

function createDefaultProjectVisibilityState(): ProjectRightSidebarVisibilityState {
  return {
    rightPanel: "hidden",
  }
}

function createDefaultProjectBrowserState(): ProjectBrowserPanelState {
  return {
    address: "",
    history: [],
    historyIndex: -1,
    zoom: 1,
  }
}

function normalizeBrowserAddress(address: string) {
  const trimmed = address.trim()
  if (!trimmed) return ""
  if (trimmed.startsWith("/")) return trimmed
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

function clampZoom(zoom: number) {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(2, Math.max(0.5, Math.round(zoom * 10) / 10))
}

function getProjectVisibilityState(
  projects: Record<string, ProjectRightSidebarVisibilityState>,
  projectId: string
): ProjectRightSidebarVisibilityState {
  return projects[projectId] ?? createDefaultProjectVisibilityState()
}

function getProjectBrowserState(
  projectBrowser: Record<string, ProjectBrowserPanelState>,
  projectId: string
): ProjectBrowserPanelState {
  return projectBrowser[projectId] ?? createDefaultProjectBrowserState()
}

export function migrateRightSidebarStore(persistedState: unknown, version = 0) {
  if (!persistedState || typeof persistedState !== "object") {
    return { size: DEFAULT_RIGHT_SIDEBAR_SIZE, projects: {}, projectBrowser: {} }
  }

  const state = persistedState as {
    size?: number
    projects?: Record<string, Partial<{ rightPanel: string }>>
    projectBrowser?: Record<string, Partial<ProjectBrowserPanelState>>
  }
  const projects = Object.fromEntries(
    Object.entries(state.projects ?? {}).map(([projectId, layout]) => [
      projectId,
      {
        rightPanel: layout.rightPanel === "browser" ? "browser" : "hidden",
      },
    ])
  )

  const projectBrowser = Object.fromEntries(
    Object.entries(state.projectBrowser ?? {}).map(([projectId, browserState]) => {
      const address = normalizeBrowserAddress(browserState.address ?? "")
      const history = (browserState.history ?? []).map(normalizeBrowserAddress).filter(Boolean)
      const historyIndex = Math.min(history.length - 1, Math.max(-1, browserState.historyIndex ?? (history.length - 1)))
      return [
        projectId,
        {
          address,
          history,
          historyIndex,
          zoom: clampZoom(browserState.zoom ?? 1),
        },
      ]
    })
  )

  const size = version >= 7 ? clampSize(state.size ?? DEFAULT_RIGHT_SIDEBAR_SIZE) : DEFAULT_RIGHT_SIDEBAR_SIZE
  return { size, projects, projectBrowser }
}

export const useRightSidebarStore = create<RightSidebarState>()(
  persist(
    (set) => ({
      size: DEFAULT_RIGHT_SIDEBAR_SIZE,
      projects: {},
      projectBrowser: {},
      togglePanel: (projectId, panel) =>
        set((state) => ({
          projects: {
            ...state.projects,
            [projectId]: {
              ...getProjectVisibilityState(state.projects, projectId),
              rightPanel: getProjectVisibilityState(state.projects, projectId).rightPanel === panel ? "hidden" : panel,
            },
          },
        })),
      hidePanel: (projectId) =>
        set((state) => ({
          projects: {
            ...state.projects,
            [projectId]: {
              ...getProjectVisibilityState(state.projects, projectId),
              rightPanel: "hidden",
            },
          },
        })),
      setSize: (size) => set({ size: clampSize(size) }),
      syncBrowserAddress: (projectId, address, mode) => set(state => {
        const current = getProjectBrowserState(state.projectBrowser, projectId)
        const nextAddress = normalizeBrowserAddress(address)
        if (!nextAddress || current.address === nextAddress) return state
        const history = [...current.history]
        let historyIndex = current.historyIndex
        if (mode === "pop" && history.includes(nextAddress)) historyIndex = history.lastIndexOf(nextAddress)
        else if (historyIndex >= 0) history[historyIndex] = nextAddress
        else { history.push(nextAddress); historyIndex = 0 }
        return { projectBrowser: { ...state.projectBrowser, [projectId]: { ...current, address: nextAddress, history, historyIndex } } }
      }),
      navigateBrowser: (projectId, address) => set((state) => {
        const current = getProjectBrowserState(state.projectBrowser, projectId)
        const nextAddress = normalizeBrowserAddress(address)
        if (!nextAddress) {
          return {
            projectBrowser: {
              ...state.projectBrowser,
              [projectId]: {
                ...current,
                address: "",
              },
            },
          }
        }

        if (current.address === nextAddress) return state

        const previousHistory = current.history.slice(0, current.historyIndex + 1)
        const history = previousHistory[previousHistory.length - 1] === nextAddress
          ? previousHistory
          : [...previousHistory, nextAddress]

        return {
          projectBrowser: {
            ...state.projectBrowser,
            [projectId]: {
              ...current,
              address: nextAddress,
              history,
              historyIndex: history.length - 1,
            },
          },
        }
      }),
      goBrowserBack: (projectId) => set((state) => {
        const current = getProjectBrowserState(state.projectBrowser, projectId)
        const historyIndex = Math.max(0, current.historyIndex - 1)
        if (historyIndex === current.historyIndex || !current.history[historyIndex]) return state
        return {
          projectBrowser: {
            ...state.projectBrowser,
            [projectId]: {
              ...current,
              address: current.history[historyIndex],
              historyIndex,
            },
          },
        }
      }),
      goBrowserForward: (projectId) => set((state) => {
        const current = getProjectBrowserState(state.projectBrowser, projectId)
        const historyIndex = Math.min(current.history.length - 1, current.historyIndex + 1)
        if (historyIndex === current.historyIndex || !current.history[historyIndex]) return state
        return {
          projectBrowser: {
            ...state.projectBrowser,
            [projectId]: {
              ...current,
              address: current.history[historyIndex],
              historyIndex,
            },
          },
        }
      }),
      setBrowserZoom: (projectId, zoom) => set((state) => {
        const current = getProjectBrowserState(state.projectBrowser, projectId)
        const nextZoom = clampZoom(typeof zoom === "function" ? zoom(current.zoom) : zoom)
        if (current.zoom === nextZoom) return state
        return {
          projectBrowser: {
            ...state.projectBrowser,
            [projectId]: {
              ...current,
              zoom: nextZoom,
            },
          },
        }
      }),
      clearProject: (projectId) =>
        set((state) => {
          const { [projectId]: _removedLayout, ...restProjects } = state.projects
          const { [projectId]: _removedBrowser, ...restProjectBrowser } = state.projectBrowser
          return { projects: restProjects, projectBrowser: restProjectBrowser }
        }),
    }),
    {
      name: "right-sidebar-layouts",
      storage: privateBrowserStorage,
      version: 8,
      migrate: migrateRightSidebarStore,
    }
  )
)

export const DEFAULT_RIGHT_SIDEBAR_VISIBILITY_STATE: ProjectRightSidebarVisibilityState = {
  rightPanel: "hidden",
}

export function getDefaultRightSidebarVisibilityState() {
  return {
    ...DEFAULT_RIGHT_SIDEBAR_VISIBILITY_STATE,
  }
}
