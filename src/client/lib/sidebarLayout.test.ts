import { expect, test } from "bun:test"
import { readSidebarLayout, writeSidebarLayout } from "./sidebarLayout"

test("layout restores per browser user/host scope without changing other scopes", () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  writeSidebarLayout("account-a/host-a", { collapsed: true, width: 420 }, storage)
  expect(readSidebarLayout("account-a/host-a", storage)).toEqual({ collapsed: true, width: 420 })
  expect(readSidebarLayout("account-b/host-a", storage)).toEqual({ collapsed: false, width: 275 })
  expect(readSidebarLayout("account-a/host-b", storage)).toEqual({ collapsed: false, width: 275 })
  values.set("kanna:sidebar-width", "400")
  expect(readSidebarLayout("legacy", storage)).toEqual({ collapsed: false, width: 400 })
})

test("blocked and malformed browser storage preserves usable defaults", () => {
  expect(readSidebarLayout("a", { getItem: () => { throw new Error("blocked") }, setItem() {} })).toEqual({ collapsed: false, width: 275 })
  expect(readSidebarLayout("a", { getItem: () => "null", setItem() {} })).toEqual({ collapsed: false, width: 275 })
  expect(() => writeSidebarLayout("a", { collapsed: true, width: 900 }, { getItem: () => null, setItem: () => { throw new Error("blocked") } })).not.toThrow()
})

test("an old tab's collapse action preserves another tab's newer width, and vice versa", () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  writeSidebarLayout("browser", { collapsed: false, width: 275 }, storage)
  const oldWindow = readSidebarLayout("browser", storage)
  writeSidebarLayout("browser", { width: 520 }, storage)
  writeSidebarLayout("browser", { collapsed: true }, storage)
  expect(readSidebarLayout("browser", storage)).toEqual({ collapsed: true, width: 520 })
  expect(oldWindow).toEqual({ collapsed: false, width: 275 })
  writeSidebarLayout("browser", { width: 300 }, storage)
  expect(readSidebarLayout("browser", storage)).toEqual({ collapsed: true, width: 300 })
})
