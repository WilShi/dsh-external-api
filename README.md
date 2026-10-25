# DSH External API

DSH Desktop 的可选外部 HTTP API。服务默认关闭；启用后绑定 `0.0.0.0`（所有 IPv4 网络接口），并使用用户指定的端口和 Bearer Token 鉴权。

完整的启用说明、请求与响应结构、SSE 重连、错误码和多语言调用示例见[《DSH 外部 HTTP API v1》](../../docs/external-api.md)。本 README 仅保留快速参考。

## 快速开始

1. 打开 DSH Desktop 的“设置 → API 服务”。
2. 填写端口（默认 `47831`）并启用服务。
3. 为调用方创建独立 Token；如需显式选择工作区或 Agent Preset，勾选对应资源授权，然后立即保存只显示一次的明文。
4. 本机调用可直接复制状态卡片中的“本机访问 URL”；局域网设备将其中的 `127.0.0.1` 换成 DSH 主机的局域网 IPv4。

下面演示 DSH 主机本机访问，因此地址为 `http://127.0.0.1:47831`。局域网设备应把 `127.0.0.1` 替换为 DSH 主机的局域网 IPv4；不要使用只用于监听的 `0.0.0.0`。Token 已写入环境变量 `DSH_API_TOKEN`。

```powershell
curl.exe http://127.0.0.1:47831/api/v1/capabilities `
  -H "Authorization: Bearer $env:DSH_API_TOKEN"
```

最省事的调用方式是创建临时会话并立即发起一次 Run：

```powershell
$body = @{ input = '请概括当前项目的结构' } | ConvertTo-Json -Compress
Invoke-RestMethod `
  -Method Post `
  -Uri 'http://127.0.0.1:47831/api/v1/responses' `
  -Headers @{ Authorization = "Bearer $env:DSH_API_TOKEN" } `
  -ContentType 'application/json' `
  -Body $body
```

响应状态为 `202`，其中包含 `session`、`run` 和 `eventsUrl`。用返回的 Run ID 读取实时事件：

```powershell
curl.exe -N http://127.0.0.1:47831/api/v1/runs/RUN_ID/events `
  -H "Authorization: Bearer $env:DSH_API_TOKEN"
```

## API

除健康检查和 CORS 预检外，所有接口都要求 `Authorization: Bearer <token>`。

| 方法 | 路径 | 作用 | 所需 Scope |
| --- | --- | --- | --- |
| `GET` / `HEAD` | `/api/v1/health` | Listener 健康检查 | 无 |
| `GET` | `/api/v1/capabilities` | 能力、限制和当前 Token 权限 | `capabilities:read` |
| `GET` | `/api/v1/workspaces` | Token 可使用的工作区 | `capabilities:read` |
| `GET` | `/api/v1/agents` | Token 可使用的 Agent Preset | `capabilities:read` |
| `GET` | `/api/v1/models?sessionId=...` | 会话可用模型 | `capabilities:read` |
| `GET` | `/api/v1/skills?sessionId=...` | 会话可用技能 | `capabilities:read` |
| `GET` | `/api/v1/sessions` | 列出当前 Token 创建的会话 | `sessions:read` |
| `POST` | `/api/v1/sessions` | 创建会话 | `sessions:write` |
| `GET` | `/api/v1/sessions/:id/messages` | 获取脱敏后的消息历史 | `sessions:read` |
| `POST` | `/api/v1/sessions/:id/messages` | 发起 Run | `runs:write` |
| `POST` | `/api/v1/sessions/:id/runs` | 发起 Run（语义等同上一项） | `runs:write` |
| `POST` | `/api/v1/responses` | 创建会话并发起 Run | `sessions:write`、`runs:write` |
| `GET` | `/api/v1/runs/:id` | 查询 Run 状态 | `runs:read` |
| `GET` | `/api/v1/runs/:id/events` | 订阅 Run 的 SSE 事件 | `runs:read` |
| `POST` | `/api/v1/runs/:id/cancel` | 取消 Run | `runs:write` |

创建会话时可选传入白名单中的 `workspaceId` 和 `agentPreset`：

```json
{
  "workspaceId": "workspace-id",
  "agentPreset": "agent-preset-id"
}
```

发起 Run 的请求体：

```json
{
  "input": "分析这个问题",
  "clientTimeZone": "Asia/Shanghai"
}
```

SSE 支持 `Last-Event-ID` 断线续传。事件类型包括 `run.queued`、`run.started`、`run.cancelling`、`message.delta`、`message.completed`、`tool.started`、`tool.completed`、`run.completed`、`run.cancelled` 和 `run.failed`。

浏览器的原生 `EventSource` 不能设置 Bearer Header，请改用 `fetch` 流。浏览器还必须位于服务允许的 Origin 白名单中；当前设置页尚未开放此配置，普通网页默认会被拒绝。下面代码只适用于已经由发行版或受控配置启用对应 Origin 的环境：

```js
const response = await fetch(`${baseUrl}/api/v1/runs/${runId}/events`, {
  headers: { Authorization: `Bearer ${token}` },
})
if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
for (;;) {
  const { value, done } = await reader.read()
  if (done) break
  console.log(value) // 正式客户端应按 SSE 帧解析，而不是假定一次读取就是一个事件
}
```

## 安全边界

- Listener 固定绑定 `0.0.0.0`，可从本机和局域网访问；它不复用也不转发 DSH 主站的 `/api` 路由。
- Token 明文只在创建时返回一次；持久化配置仅保存 SHA-256 摘要。
- 每个 Token 只能访问自己创建的 Session、Run 和 SSE 流。
- 工作区与 Agent Preset 默认均不允许调用方自行指定，需显式加入 Token 白名单。
- Slash Command、任意内部 RPC、工具参数、工具结果正文、系统提示和推理内容均不会对外开放。
- Host 必须与客户端实际访问的 IPv4 和端口一致；Origin、Fetch Metadata、请求体大小、请求速率、并发 Run 和 SSE 连接数也均有限制。
- 活动 Run 默认上限为每 Token 10 个、全局 20 个；旧版精确的 `2/4` 默认组合会在启动时自动升级，其他自定义组合不变。
- 设置管理接口只挂在 DSH 自身的随机回环端口，并校验同源浏览器请求；它用于防止网页跨站调用，不把同一系统账户下的恶意本机进程视为可隔离的安全边界。
- 外部 API 是明文 HTTP。仅在受信任的专用网络中启用，并使用系统防火墙把入站来源限制到所需私网；不要把端口直接映射或暴露到公网。跨不受信任网络接入时，应使用 VPN 或受信任的 TLS 反向代理并限制来源网络。

Token 撤销会立即断开它的 SSE 连接、尝试取消活动 Run，并删除其会话归属记录。

## 错误格式

外部接口使用稳定的 JSON 错误结构，不回传内部异常或宿主错误详情：

```json
{
  "error": {
    "code": "AUTH_INVALID",
    "message": "The bearer token is invalid.",
    "requestId": "..."
  }
}
```

客户端应以 HTTP 状态码和 `error.code` 作为程序判断依据。
