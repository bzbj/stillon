import { describe, expect, test } from "bun:test"
import {
  getDataDir,
  getDataDirDisplay,
  getDataRootName,
  getKeybindingsFilePath,
  getKeybindingsFilePathDisplay,
  getReleaseEditionTooltip,
  getRuntimeProfile,
  RELEASE_EDITION,
  RELEASE_EDITION_DESCRIPTIONS,
  RELEASE_EDITION_SEQUENCE,
} from "./branding"

describe("runtime profile helpers", () => {
  test("defaults to the StillOn production paths", () => {
    expect(getRuntimeProfile({})).toBe("prod")
    expect(getDataRootName({})).toBe(".stillon")
    expect(getDataDir("/tmp/home", {})).toBe("/tmp/home/.stillon/data")
    expect(getDataDirDisplay({})).toBe("~/.stillon/data")
    expect(getKeybindingsFilePath("/tmp/home", {})).toBe("/tmp/home/.stillon/keybindings.json")
    expect(getKeybindingsFilePathDisplay({})).toBe("~/.stillon/keybindings.json")
  })

  test("switches to StillOn development paths", () => {
    const env = { STILLON_RUNTIME_PROFILE: "dev" }

    expect(getRuntimeProfile(env)).toBe("dev")
    expect(getDataRootName(env)).toBe(".stillon-dev")
    expect(getDataDir("/tmp/home", env)).toBe("/tmp/home/.stillon-dev/data")
    expect(getDataDirDisplay(env)).toBe("~/.stillon-dev/data")
    expect(getKeybindingsFilePath("/tmp/home", env)).toBe("/tmp/home/.stillon-dev/keybindings.json")
    expect(getKeybindingsFilePathDisplay(env)).toBe("~/.stillon-dev/keybindings.json")
  })

  test("ignores legacy runtime-profile variables", () => {
    expect(getRuntimeProfile({ HUSKY_RUNTIME_PROFILE: "dev" })).toBe("prod")
    expect(getRuntimeProfile({ KANNA_RUNTIME_PROFILE: "dev" })).toBe("prod")
  })
})

describe("StillOn release helpers", () => {
  test("keeps the working-dog release sequence and current edition", () => {
    expect(RELEASE_EDITION).toBe("Husky")
    expect(RELEASE_EDITION_SEQUENCE).toEqual([
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

  test("defines tooltip descriptions for every release", () => {
    expect(Object.keys(RELEASE_EDITION_DESCRIPTIONS)).toEqual([...RELEASE_EDITION_SEQUENCE])
    for (const edition of RELEASE_EDITION_SEQUENCE) {
      expect(getReleaseEditionTooltip(edition)).toBe(`Still On release: ${edition}.\n${RELEASE_EDITION_DESCRIPTIONS[edition]}`)
    }
  })
})
