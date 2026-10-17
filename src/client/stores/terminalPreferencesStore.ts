import { create } from "zustand"

export const DEFAULT_TERMINAL_SCROLLBACK = 1_000
export const MIN_TERMINAL_SCROLLBACK = 500
export const MAX_TERMINAL_SCROLLBACK = 5_000
export const DEFAULT_TERMINAL_MIN_COLUMN_WIDTH = 450
export const MIN_TERMINAL_MIN_COLUMN_WIDTH = 250
export const MAX_TERMINAL_MIN_COLUMN_WIDTH = 900
function clampScrollback(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_SCROLLBACK
  return Math.min(MAX_TERMINAL_SCROLLBACK, Math.max(MIN_TERMINAL_SCROLLBACK, Math.round(value)))
}

function clampMinColumnWidth(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_MIN_COLUMN_WIDTH
  return Math.min(MAX_TERMINAL_MIN_COLUMN_WIDTH, Math.max(MIN_TERMINAL_MIN_COLUMN_WIDTH, Math.round(value)))
}

interface TerminalPreferencesState {
  scrollbackLines: number
  minColumnWidth: number
  setScrollbackLines: (scrollbackLines: number) => void
  setMinColumnWidth: (minColumnWidth: number) => void
}

export const useTerminalPreferencesStore = create<TerminalPreferencesState>()(
  (set) => ({
    scrollbackLines: DEFAULT_TERMINAL_SCROLLBACK,
    minColumnWidth: DEFAULT_TERMINAL_MIN_COLUMN_WIDTH,
    setScrollbackLines: (scrollbackLines) => set({ scrollbackLines: clampScrollback(scrollbackLines) }),
    setMinColumnWidth: (minColumnWidth) => set({ minColumnWidth: clampMinColumnWidth(minColumnWidth) }),
  })
)
