# 外部入口

StillOn 是 local-first，而不是 local-only。默认监听 `127.0.0.1`；操作者可以让
这一本地服务从其他设备访问。StillOn 负责本机 origin 以及 HTTP/WebSocket 行为，
不负责创建隧道、配置 DNS/TLS，也不管理 Cloudflare、VPN 或其他边缘服务。

## 选择入口方式

若反向代理或隧道运行在同一台机器上，保持默认的 loopback 监听：

```bash
stillon --trust-proxy
```

只有在 StillOn 自身必须监听网络接口时，才使用 `--host <address>` 或
`--remote`：

```bash
stillon --remote --password '<optional-password>'
```

`--share` 与 `--cloudflared` 已不再内置。请独立运行 Cloudflare Tunnel、其他
隧道或反向代理，再把它指向 StillOn。

## 可信代理约定

对于同机代理或隧道，将流量转发到：

```text
http://127.0.0.1:3210
```

代理必须：

- 保留或设置公网使用的 `Host` 请求头；
- 为 `/ws` 转发 WebSocket upgrade；
- 设置 `X-Forwarded-Proto` 为浏览器侧协议（通常公网部署为 `https`）；
- 如需按真实用户进行登录限流，转发 `X-Forwarded-For`。

只有当该代理是访问 StillOn 的唯一途径时，才启用 `--trust-proxy`。该模式下
StillOn 会信任 `X-Forwarded-Proto` 来处理 HTTPS 跳转、Origin 校验和 Secure
Cookie；它刻意不信任 `X-Forwarded-Host`，公网域名应通过普通 `Host` 请求头传入。

若用 `--trust-proxy` 同时让 StillOn 监听非 loopback 地址，必须用防火墙或网络
规则保证直连客户端无法访问该端口，否则客户端可以伪造转发请求头。

## 认证

`--password` 是可选的，任意非空值都可使用。它适合作为本机便利性门槛，而不是
完整的公网访问边界。对外访问时，除通常的网络控制外，还应在入口处配置适当的
认证与授权策略。

原生后台服务不会持久化 `--password`，但可以持久化监听与可信代理约定：

```bash
stillon service install --trust-proxy --env-file /absolute/path/to/stillon.env
```

也可以在该环境文件中设置 `STILLON_TRUST_PROXY=1`。

## 开发环境

开发模式默认也只监听 loopback。通过独立管理的代理或隧道测试时，运行：

```bash
bun run dev -- --trust-proxy
```

Vite 会接受代理传来的公网 `Host`，但开发服务器和 StillOn 后端仍保持在
`127.0.0.1`。`/ws` 代理支持 WebSocket upgrade。
