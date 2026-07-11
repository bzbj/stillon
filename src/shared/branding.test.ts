import { describe, expect, test } from "bun:test"
import {
  getDataDir,
  getDataDirDisplay,
  getDataRootName,
  getKeybindingsFilePath,
  getKeybindingsFilePathDisplay,
  getLinjunkaiEditionTooltip,
  getRuntimeProfile,
  LINJUNKAI_EDITION,
  LINJUNKAI_EDITION_DESCRIPTIONS,
  LINJUNKAI_EDITION_SEQUENCE,
} from "./branding"

describe("runtime profile helpers", () => {
  test("defaults to the prod profile when unset", () => {
    expect(getRuntimeProfile({})).toBe("prod")
    expect(getDataRootName({})).toBe(".kanna")
    expect(getDataDir("/tmp/home", {})).toBe("/tmp/home/.kanna/data")
    expect(getDataDirDisplay({})).toBe("~/.kanna/data")
    expect(getKeybindingsFilePath("/tmp/home", {})).toBe("/tmp/home/.kanna/keybindings.json")
    expect(getKeybindingsFilePathDisplay({})).toBe("~/.kanna/keybindings.json")
  })

  test("switches to dev paths for the dev profile", () => {
    const env = { KANNA_RUNTIME_PROFILE: "dev" }

    expect(getRuntimeProfile(env)).toBe("dev")
    expect(getDataRootName(env)).toBe(".kanna-dev")
    expect(getDataDir("/tmp/home", env)).toBe("/tmp/home/.kanna-dev/data")
    expect(getDataDirDisplay(env)).toBe("~/.kanna-dev/data")
    expect(getKeybindingsFilePath("/tmp/home", env)).toBe("/tmp/home/.kanna-dev/keybindings.json")
    expect(getKeybindingsFilePathDisplay(env)).toBe("~/.kanna-dev/keybindings.json")
  })
})

describe("linjunkAI edition helpers", () => {
  test("keeps the local edition sequence and current edition", () => {
    expect(LINJUNKAI_EDITION).toBe("Husky")
    expect(LINJUNKAI_EDITION_SEQUENCE).toEqual([
      "Pup",
      "Husky",
      "Corgi",
      "Samoyed",
      "Shiba",
      "Labrador",
      "Golden",
      "Shepherd",
      "Collie",
      "Border",
    ])
  })

  test("defines tooltip descriptions for every local edition", () => {
    expect(Object.keys(LINJUNKAI_EDITION_DESCRIPTIONS)).toEqual([...LINJUNKAI_EDITION_SEQUENCE])
    for (const edition of LINJUNKAI_EDITION_SEQUENCE) {
      expect(getLinjunkaiEditionTooltip(edition)).toBe(`Software Edition: ${edition}.\n${LINJUNKAI_EDITION_DESCRIPTIONS[edition]}`)
    }
  })

  test("keeps the Pup tooltip anchored to the newborn puppy meaning", () => {
    expect(getLinjunkaiEditionTooltip("Pup")).toBe(
      "Software Edition: Pup.\nA newborn puppy: small, fresh, and just starting out."
    )
  })

  test("keeps the Husky tooltip anchored to the young sled dog meaning", () => {
    expect(getLinjunkaiEditionTooltip("Husky")).toBe(
      "Software Edition: Husky.\nA loud young sled dog: energetic, curious, and not fully disciplined yet."
    )
  })
})
