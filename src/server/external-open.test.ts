import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { buildDefaultOpenCommand, openExternal } from "./external-open"

describe("native file opening", () => {
  test.each([["darwin","open"],["linux","xdg-open"],["win32","explorer.exe"]] as const)("uses the system application on %s", (platform,command) => {
    const localPath=platform==="win32" ? "C:\\Users\\example\\中文 folder\\status.json" : "/tmp/中文 folder/status.json"
    expect(buildDefaultOpenCommand({localPath,platform})).toEqual({command,args:[localPath]})
  })
  test.each(["open_editor","open_preview","open_default"] as const)("neutralizes retired commands and saved editor settings for %s", async action => {
    const calls:any[]=[]
    const localPath=path.join(tmpdir(),"sample folder","status.json")
    await openExternal({type:"system.openExternal",action,localPath,line:12,
      editor:{preset:"cursor",commandTemplate:"cursor --goto {path}; touch /tmp/should-never-run"}} as never,{
      platform:"darwin",stat:async()=>({isDirectory:()=>false}),
      spawn:async(command,args)=>{calls.push({command,args})},
    })
    expect(calls).toEqual([{command:"open",args:[localPath]}])
  })
  test("does not launch anything when a file is missing", async () => {
    let spawned=false
    await expect(openExternal({type:"system.openExternal",action:"open_default",localPath:"/missing/file.json"},{
      stat:async()=>{throw new Error("missing")},spawn:async()=>{spawned=true},
    })).rejects.toThrow("Path not found")
    expect(spawned).toBe(false)
  })
})
