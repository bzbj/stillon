# 用编程 Agent 安装 StillOn

StillOn 面向已经在使用 Codex 或 Claude Code 的用户。复制下面的 Prompt 并粘贴给你的编程 Agent，它会从官方仓库协助你完成安装。

<!-- prompt:start -->
请从 StillOn 官方仓库安装 StillOn：
https://github.com/bzbj/stillon

目标：先在这台电脑上为本地使用配置 StillOn，不将它暴露给局域网或公网。只有新的 StillOn 实例完成首次可用性检查后，安装才算完成。

请按以下步骤执行：
1. 在做任何修改前，阅读仓库中的 README 和 SECURITY.md。
2. 检查这台电脑的操作系统、Shell、Bun 是否可用及其版本，以及是否已有 StillOn 安装。
3. 简要说明安装计划，再按照本平台的官方步骤执行。
4. 保留已有的用户数据和配置。未经询问，不要覆盖或移除已有安装。
5. 第一次启动 StillOn 前，先询问我希望这台实例显示什么名称。这是显示在 StillOn 左侧栏和浏览器标签中的 **Machine Name（机器名称）**。不要自行猜测或覆盖名称。得到我的回答后，在第一次启动前将 `STILLON_MACHINE_NAME` 写入 StillOn 专用配置。若已有 StillOn 设置文件且已有机器名称，必须保留原值，并告诉我可在 **Settings → General → Machine Name** 中修改。
6. 在本地构建并启动 StillOn，验证它的 health endpoint 和 localhost 上的浏览器应用。报告准确的本地访问地址、安装 revision/version、进程状态、日志位置、更新方式，以及回滚或卸载步骤。
7. 完成 Claude Code 的首次可用性检查：
   - 检测 `claude` 命令并报告版本，但不要修改它的配置。
   - 检查认证状态。若未安装或未认证，说明需要交互式执行 `claude login`，并在启动前询问我。不得索取、复制或输出任何凭据、浏览器验证码或会话 token。
   - 认证成功后，先征得同意，再运行一个不会改动项目的、最小的一次性 Claude Code 测试提示词。在浏览器交互可用时，也要在 StillOn 内新建 Claude 对话确认端到端连接。
   - 任一检查无法完成时，保持 StillOn 运行，准确说明失败的前置条件和安全的下一步；不得默认为安装成功。
8. 如果本次安装是替换 Kanna，在 StillOn 的健康检查和 Claude Code 检查均通过前，保留 Kanna 及其数据不动。仅在检查通过后，再单独说明切换或关停选项并征得确认；Kanna 绝不能成为 StillOn 的运行时依赖。
9. 仅在解释清楚影响之后，再提供可选的“按用户启动的后台服务”。

安全约束：
- 默认保持 StillOn 仅绑定 localhost。
- 除非我在后续指令中明确要求远程访问，否则不要使用 --remote、--share、--cloudflared，不要修改防火墙、DNS、Tailscale 或创建任何公网隧道。
- 不要在 Shell 历史、日志、源代码或聊天输出中泄露密钥。
- 在执行任何需要高权限、具有破坏性，或会修改已有服务的操作前，先说明影响并请求确认。
- 把 provider 测试提示词视为可能消耗额度或计费的操作；只有在我明确同意后才能执行。
<!-- prompt:end -->

远程访问应当单独设置。确认本地安装和 Claude Code 首次可用性检查均通过后，再从项目文档中选择私有网络或 Cloudflare Tunnel 方案。

## 这个 Prompt 对“完成”的定义

编程 Agent 是安装管家，安装完成后用户会在 StillOn 中工作。因此一次成功的运行必须有四个可观察结果：命名完成的 StillOn 实例、健康的本地服务、已验证的 Claude Code 登录，以及一次经用户同意的端到端 provider 检查。

后续可以在 StillOn 内提供持续显示的欢迎引导，并复用同一份清单；但必须遵守相同边界：先命名、默认仅本地、登录需要明确同意、provider 测试需要用户选择执行。
