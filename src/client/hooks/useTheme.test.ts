import { afterEach, describe, expect, test } from "bun:test"
import { getAppleMobileWebAppStatusBarStyle, syncThemeMetadata } from "./useTheme"

const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
const originalGetComputedStyleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle")

function setGlobalProperty(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  })
}

function restoreGlobalProperty(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor)
  } else {
    Reflect.deleteProperty(globalThis, name)
  }
}

afterEach(() => {
  restoreGlobalProperty("document", originalDocumentDescriptor)
  restoreGlobalProperty("window", originalWindowDescriptor)
  restoreGlobalProperty("getComputedStyle", originalGetComputedStyleDescriptor)
})

function createFakeDocument() {
  const headChildren: Array<{ attributes: Map<string, string>; setAttribute: (name: string, value: string) => void; getAttribute: (name: string) => string | null }> = []

  const head = {
    querySelector(selector: string) {
      const nameMatch = selector.match(/meta\[name="(.+)"\]/)
      if (!nameMatch) return null
      return headChildren.find((child) => child.getAttribute("name") === nameMatch[1]) ?? null
    },
    appendChild(element: typeof headChildren[number]) {
      headChildren.push(element)
    },
  }

  return {
    head,
    body: {},
    documentElement: {
      style: {
        colorScheme: "",
      },
    },
    createElement() {
      const attributes = new Map<string, string>()
      return {
        attributes,
        setAttribute(name: string, value: string) {
          attributes.set(name, value)
        },
        getAttribute(name: string) {
          return attributes.get(name) ?? null
        },
      }
    },
  }
}

describe("getAppleMobileWebAppStatusBarStyle", () => {
  test("maps dark themes to a translucent dark status bar", () => {
    expect(getAppleMobileWebAppStatusBarStyle("dark")).toBe("black-translucent")
  })

  test("maps light themes to the default status bar", () => {
    expect(getAppleMobileWebAppStatusBarStyle("light")).toBe("default")
  })
})

describe("syncThemeMetadata", () => {
  test("updates theme-color and color-scheme from the active theme", () => {
    const fakeDocument = createFakeDocument()
    setGlobalProperty("document", fakeDocument as typeof document)
    setGlobalProperty("window", {} as typeof window)
    setGlobalProperty("getComputedStyle", (() => ({ backgroundColor: "rgb(34, 34, 34)" })) as typeof getComputedStyle)

    syncThemeMetadata("dark")

    const themeColorTag = fakeDocument.head.querySelector('meta[name="theme-color"]')
    const statusBarTag = fakeDocument.head.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')

    expect(themeColorTag?.getAttribute("content")).toBe("rgb(34, 34, 34)")
    expect(statusBarTag?.getAttribute("content")).toBe("black-translucent")
    expect(fakeDocument.documentElement.style.colorScheme).toBe("dark")
  })
})
