import { expect, test } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"
import { discoverCodexModels, resolveCodexDiscoveryHome } from "./codex-model-discovery"

test("discovery resolves home for Unix, Windows and service environments", () => {
  const root = path.join(homedir(), "example")
  expect(resolveCodexDiscoveryHome({ HOME: root })).toBe(path.join(root, ".codex"))
  expect(resolveCodexDiscoveryHome({ USERPROFILE: root })).toBe(path.join(root, ".codex"))
  expect(resolveCodexDiscoveryHome({ CODEX_HOME: root, HOME: "ignored", USERPROFILE: "ignored" })).toBe(root)
  expect(resolveCodexDiscoveryHome({})).toBe(path.join(homedir(), ".codex"))
})

const fake = `
import {createInterface} from "node:readline";
const methods=[];
createInterface({input:process.stdin}).on("line", line=>{
 const q=JSON.parse(line); methods.push(q.method);
 if(!["initialize","initialized","model/list"].includes(q.method) || (q.method==="model/list" && !methods.includes("initialized"))) {console.log(JSON.stringify({id:q.id,error:{code:-1}}));return;}
 if(q.method==="initialized") return;
 if(q.method==="initialize") {console.log(JSON.stringify({id:q.id,result:{userAgent:"codex_cli_rs/0.159.2",extra:true}}));return;}
 const mode=process.argv.at(-1);
 if(mode==="timeout") {process.on("SIGTERM",()=>{});setInterval(()=>{},1000);return;}
 if(mode==="error") {console.log(JSON.stringify({id:q.id,error:{code:-1,message:"private upstream details"}}));return;}
 if(mode==="invalid") {console.log("not json");return;}
 const model={id:q.params.cursor?"b":"a",model:q.params.cursor?"b":"a",displayName:"模型",hidden:false,supportedReasoningEfforts:[{reasoningEffort:"high",description:"test"}],isDefault:true};
 const data=mode==="empty"?[]:[model];
 if(mode==="schema") delete model.supportedReasoningEfforts;
 if(mode==="duplicate") data.push(model);
 if(mode==="partial"&&q.params.cursor) {console.log(JSON.stringify({id:q.id,error:{code:-1}}));return;}
 const nextCursor=mode==="cycle"?"same":(!q.params.cursor&&["pages","partial"].includes(mode)?"next":null);
 console.log(JSON.stringify({id:q.id,result:{data,nextCursor,methods}}));
});
`

function query(mode: string, timeoutMs = 3000) {
  let child: ChildProcessWithoutNullStreams | undefined
  const result = discoverCodexModels({ environment: process.env, timeoutMs,
    spawnProcess: () => { child = spawn(process.execPath, ["--no-env-file", "-e", fake, mode], { stdio: ["pipe", "pipe", "pipe"] }); return child } })
  return { result, child: () => child! }
}

test("isolated discovery initializes, pages and accepts additive fields without starting a thread", async () => {
  const probe = query("pages")
  const result = await probe.result
  expect(result.models.map((model) => model.model)).toEqual(["a", "b"])
  expect(result.models[0]!.displayName).toBe("模型")
  expect(result.cliVersion).toBe("0.159.2")
  expect(probe.child().exitCode !== null || probe.child().signalCode !== null).toBe(true)
})

for (const [mode, message] of [["empty", "empty catalog"], ["schema", "incompatible catalog"],
  ["duplicate", "duplicate model"], ["cycle", "pagination cursor"], ["partial", "rejected"],
  ["invalid", "invalid JSON"], ["error", "rejected"]]) {
  test(`discovery rejects ${mode} and closes its own child`, async () => {
    const probe = query(mode!)
    await expect(probe.result).rejects.toThrow(message)
    expect(probe.child().exitCode !== null || probe.child().signalCode !== null).toBe(true)
  })
}

test("timeout escalates cleanup for an unresponsive discovery process", async () => {
  const probe = query("timeout", 1500)
  await expect(probe.result).rejects.toThrow("timed out")
  if (process.platform !== "win32") expect(probe.child().signalCode).toBe("SIGKILL")
  else expect(probe.child().exitCode !== null || probe.child().signalCode !== null).toBe(true)
}, 5000)
