import { describe, expect, test } from "bun:test"
import {
  consumeHistoryAutoLoadGate,
  updateHistoryAutoLoadGate,
  type HistoryAutoLoadGate,
} from "./ChatTranscriptViewport"

function emptyGate(): HistoryAutoLoadGate {
  return {
    previousScrollTop: null,
    armed: false,
  }
}

describe("history auto-load gate", () => {
  test("does not load from a mount or layout start-reached callback", () => {
    const result = consumeHistoryAutoLoadGate(
      updateHistoryAutoLoadGate(emptyGate(), 0),
      { hasOlderHistory: true, isHistoryLoading: false },
    )

    expect(result.shouldLoad).toBe(false)
  })

  test("arms only after movement toward older history and is one-shot", () => {
    const atBottom = updateHistoryAutoLoadGate(emptyGate(), 500)
    const movingDown = updateHistoryAutoLoadGate(atBottom, 520)
    expect(movingDown.armed).toBe(false)

    const movingUp = updateHistoryAutoLoadGate(movingDown, 400)
    expect(movingUp.armed).toBe(true)

    const first = consumeHistoryAutoLoadGate(movingUp, {
      hasOlderHistory: true,
      isHistoryLoading: false,
    })
    const second = consumeHistoryAutoLoadGate(first.gate, {
      hasOlderHistory: true,
      isHistoryLoading: false,
    })

    expect(first.shouldLoad).toBe(true)
    expect(second.shouldLoad).toBe(false)
  })

  test("keeps the gate armed while loading or when there is no older history", () => {
    const armed = updateHistoryAutoLoadGate(
      updateHistoryAutoLoadGate(emptyGate(), 200),
      100,
    )

    const loading = consumeHistoryAutoLoadGate(armed, {
      hasOlderHistory: true,
      isHistoryLoading: true,
    })
    const unavailable = consumeHistoryAutoLoadGate(loading.gate, {
      hasOlderHistory: false,
      isHistoryLoading: false,
    })

    expect(loading.shouldLoad).toBe(false)
    expect(unavailable.shouldLoad).toBe(false)
    expect(unavailable.gate.armed).toBe(true)
  })

  test("does not arm from scroll-position changes while a page is loading", () => {
    const atTop = updateHistoryAutoLoadGate(
      updateHistoryAutoLoadGate(emptyGate(), 400),
      200,
      false,
    )
    const afterLoad = consumeHistoryAutoLoadGate(atTop, {
      hasOlderHistory: true,
      isHistoryLoading: false,
    })

    expect(atTop.armed).toBe(false)
    expect(afterLoad.shouldLoad).toBe(false)
  })
})
