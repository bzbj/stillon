import { describe, expect, test } from "bun:test"
import { fileActionItems } from "./open-external-menu"

describe("file actions", () => {
  test("offers local preview/open/show while hiding download", () => {
    expect(fileActionItems({local:true,isMac:true,preview:true,download:true}).map(item=>item.action))
      .toEqual(["preview","open_default","open_finder"])
  })
  test("offers only preview and download for a remote file", () => {
    expect(fileActionItems({local:false,isMac:false,preview:true,download:true}).map(item=>item.action))
      .toEqual(["preview","download"])
    expect(fileActionItems({local:false,isMac:false,preview:false,download:true}).map(item=>item.action)).toEqual(["download"])
    expect(fileActionItems({local:false,isMac:false,preview:false,download:false})).toEqual([])
  })
  test("uses the system folder label on Windows", () => {
    expect(fileActionItems({local:true,isMac:false,preview:false,download:false}).map(item=>item.label))
      .toEqual(["Open on this computer","Show in folder"])
  })
})
