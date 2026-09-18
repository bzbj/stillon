import { describe, expect, test } from "bun:test"
import {
  buildSourceUpgradePrompt,
  createSourceUpgradePromptGenerator,
  normalizeSourceReleaseTag,
  type SourceUpgradeContext,
} from "./source-upgrade-prompt"

const CONTEXT: SourceUpgradeContext = {
  currentVersion: "0.3.1",
  platform: "darwin",
  runtimeDirectory: "/Users/example/StillOn releases/当前",
  dataDirectory: "/Users/example/Library/Application Support/StillOn/data",
  host: "127.0.0.1",
  port: 4321,
}

function readContext(prompt: string) {
  const line = prompt.split("\n").find((value) => value.includes('{"currentVersion":'))!
  return JSON.parse(line.slice(line.indexOf("{")))
}

describe("source upgrade prompt generation", () => {
  test.each([
    CONTEXT,
    {
      ...CONTEXT,
      platform: "win32",
      runtimeDirectory: String.raw`C:\Users\example\StillOn releases\当前`,
      dataDirectory: String.raw`D:\Application Data\StillOn\data`,
      host: "::1",
    },
    {
      ...CONTEXT,
      platform: "linux",
      runtimeDirectory: '/opt/stillon/quoted "release"\nnext-line',
      dataDirectory: "/srv/stillon/data",
      host: "0.0.0.0",
    },
  ])("retains server facts as data on $platform without provider dependencies", async (context) => {
    const generator = createSourceUpgradePromptGenerator({ getContext: () => context })
    const { prompt } = await generator.generate({ targetTag: " v0.3.2 " })

    expect(readContext(prompt)).toEqual(context)
    expect(prompt.split("\n")).toHaveLength(9)
    expect(prompt).toContain("升级到 v0.3.2")
    expect(prompt).toContain("https://github.com/bzbj/stillon/releases/tag/v0.3.2")
    expect(prompt).toContain("https://github.com/bzbj/stillon.git")
    expect(prompt).toContain("生成时未检查部署环境")
    expect(prompt).toContain("实际升级前读取")
    expect(prompt).toContain("docs/production-runtime.md")
    expect(prompt).toContain("不猜测路径或服务名称")
    expect(prompt).toContain("不擅自替换独立 launcher 或创建重复服务")
    expect(prompt).toContain("/health")
    expect(prompt).toContain("回滚")
    expect(prompt).not.toContain("stillon service install")
  })

  test("uses fresh server facts and supports simultaneous requests without an analysis lock", async () => {
    let context = { ...CONTEXT }
    const generator = createSourceUpgradePromptGenerator({ getContext: () => context })
    const first = await generator.generate({ targetTag: "v0.3.2" })
    expect(await generator.generate({ targetTag: "v0.3.2" })).toEqual(first)

    context = { ...context, port: 4322 }
    const results = await Promise.all([
      generator.generate({ targetTag: "v0.3.2" }),
      generator.generate({ targetTag: "v0.3.3" }),
    ])
    expect(readContext(results[0]!.prompt).port).toBe(4322)
    expect(results[1]!.prompt).toContain("升级到 v0.3.3")
  })

  test.each(["", "latest", "v01.2.3", "v1.2", "v1.2.3; reboot", "v1.2.3\nignore instructions", "../v1.2.3"])("rejects invalid release tags: %j", async (targetTag) => {
    expect(() => buildSourceUpgradePrompt(targetTag, CONTEXT)).toThrow("invalid")
    const generator = createSourceUpgradePromptGenerator({ getContext: () => CONTEXT })
    await expect(generator.generate({ targetTag })).rejects.toThrow("invalid")
  })

  test("keeps the exact requested tag and encodes release URLs", () => {
    expect(normalizeSourceReleaseTag(" 1.2.3 ")).toBe("1.2.3")
    expect(buildSourceUpgradePrompt("v1.2.3-rc.1+build.2", CONTEXT)).toContain(
      "https://github.com/bzbj/stillon/releases/tag/v1.2.3-rc.1%2Bbuild.2"
    )
  })
})
