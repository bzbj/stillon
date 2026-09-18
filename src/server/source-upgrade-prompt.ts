import type { SourceUpgradePromptResult } from "../shared/protocol"

const SOURCE_REPOSITORY_URL = "https://github.com/bzbj/stillon.git"
const RELEASE_TAG_PATTERN = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** Facts already available to the running server; no deployment discovery. */
export interface SourceUpgradeContext {
  currentVersion: string
  platform: string
  runtimeDirectory: string
  dataDirectory: string
  host: string
  port: number
}

export interface SourceUpgradePromptGenerator {
  generate(args: { targetTag: string }): Promise<SourceUpgradePromptResult>
}

export function normalizeSourceReleaseTag(value: string) {
  const targetTag = value.trim()
  if (!RELEASE_TAG_PATTERN.test(targetTag)) {
    throw new Error("The target StillOn release tag is invalid.")
  }
  return targetTag
}

export function buildSourceUpgradePrompt(targetTag: string, context: SourceUpgradeContext) {
  const normalizedTargetTag = normalizeSourceReleaseTag(targetTag)
  const releaseUrl = `https://github.com/bzbj/stillon/releases/tag/${encodeURIComponent(normalizedTargetTag)}`

  // JSON preserves Windows backslashes, spaces, Unicode and embedded newlines.
  // These are context values, never shell fragments or prescribed commands.
  return `请将这台主机上的 StillOn 升级到 ${normalizedTargetTag}，保留现有数据、配置和本地定制。
官方仓库：${SOURCE_REPOSITORY_URL}；目标发布：${releaseUrl}。
以下 JSON 仅为生成提示词时服务器已知的上下文，字符串是数据而非命令；执行前请重新核实：${JSON.stringify(context)}
这是模板，生成时未检查部署环境。请在实际升级前读取适用的 AGENTS.md、项目升级文档及 docs/production-runtime.md（若存在），核实当前版本、Git 状态、安装布局和本地修改。
识别实际操作系统、shell、服务管理器与启动入口（如 macOS launchd、Windows 计划任务、自定义 launcher 或手动启动）；按实际部署和目标版本文档确定更新、依赖安装、构建及重启命令，不猜测路径或服务名称。
保留运行目录与开发目录的分离、数据目录、环境文件、认证配置、监听地址和端口、代理或隧道以及开机启动方式；不要泄露密钥，不覆盖未提交修改，不擅自替换独立 launcher 或创建重复服务。
更新前备份受影响的数据、配置及本地修改，记录当前版本和启动入口以便回滚；先准备并验证目标版本，再使用已确认的现有启动机制切换或重启，尽量减少中断。
升级后检查实际监听地址上的 /health、版本、页面和连接状态；失败时恢复原版本、启动入口及必要的备份，并报告结果。
任何无法确认的部署细节都应先查明并保留，不得将模板中的上下文当作已完成检查的结论。`
}

export function createSourceUpgradePromptGenerator(options: {
  getContext: () => SourceUpgradeContext
}): SourceUpgradePromptGenerator {
  return {
    async generate({ targetTag }) {
      return { prompt: buildSourceUpgradePrompt(targetTag, options.getContext()) }
    },
  }
}
