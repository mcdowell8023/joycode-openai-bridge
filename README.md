# JoyCode → OpenAI-compatible Bridge

把 **JoyCode 桌面客户端**里那条没公开的本地代理，变成任何 OpenAI 兼容工具（opencode / DSH / Paseo / Cline / Continue）都能直接调用的模型端点。

不用逆向签名算法，不用碰登录凭据的加密，也不用改写客户端的网络层——直接复用客户端自己已经建好的那条通道。

## 这个仓库解决什么问题

JoyCode（京东的编码助手）的官方 API 网关对本账号返回：

```json
{"error":{"code":"AI_GRAY_ACCESS_DENIED","message":"访问受限，请联系管理员开通"}}
```

但同一个客户端界面上，聊天是正常的。也就是说：**限制卡在 API 网关这一层，客户端自己那条路是通的**。

2026-11 之前，社区的做法是用 IDE 版的编辑器扩展桥接（`joycode-dispatch.mjs` 那类），单轮、无工具调用、必须开着 IDE。现在 JoyCode 有了独立的 CLI/GUI 客户端（`JoyCode.app`，`CFBundleIdentifier = com.joycode.cli`），它自己会起一个本地 HTTP 代理，能力比 IDE 桥接强得多：

| 能力 | IDE 桥接（旧） | CLI 本地代理（本仓库） |
| --- | --- | --- |
| 单轮文本 | ✅ | ✅ |
| 多轮上下文 | ❌ | ✅ |
| 流式输出 | ❌ | ✅ |
| Function calling / tools | ❌ | ✅ |
| 需要开着 IDE | ✅ 必需 | ❌ 不需要（只要 JoyCode.app 在跑） |
| 需要额外扩展 | ✅ 必需 | ❌ 不需要 |

## 它是怎么找到那条通道的

三步取证，全部只用 `lsof` / `grep` / `curl`：

**1. 找出客户端起了哪些本地端口**

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -i joycode
```

得到 `127.0.0.1:19888`（CDP 调试口）、`127.0.0.1:<随机>`（pro responses proxy）、`127.0.0.1:54812`（模型目录）。

**2. 从日志里确认代理地址**

```bash
grep "pro responses proxy ready" ~/.joycode/logs/joycode-app.log | tail -1
# [daemon] pro responses proxy ready: http://127.0.0.1:58870/api/saas/openai/v1
```

**端口每次启动都会变**——`dist/main.js` 里是 `server.listen(0, "127.0.0.1")`，由内核分配。所以日志行是唯一持久的发现手段，本仓库的 shim 就靠它自动跟随。

**3. 摸清鉴权头和端点形状**

| 路径 | 鉴权头 | 结果 |
| --- | --- | --- |
| `GET {proxy}/models` | 任意 | 200，返回 5 个模型的完整 `base_instructions` |
| `POST {proxy}/chat/completions` | `Authorization: Bearer <token>` | **401 `账号未登录`** |
| `POST {proxy}/chat/completions` | `X-Model-Token: <token>` | **401 `账号未登录`** |
| `POST {proxy}/chat/completions` | **`ptKey: <token>`** | **200，正常出 token** |
| `POST {proxy}/responses` | 不需要 | 200，但必须 `stream: true` |

`ptKey` 就是 `~/.joycode/auth.json` 里的 `tokens.access_token`（和 `~/.joycode/config.toml` 的 `[model_providers.jdcloud.http_headers].ptKey` 完全一致）。

## 三个必须知道的坑

这三条是踩出来的，不写下来一定会重踩：

**① `stream: false` 会被灰名单拒**

```
stream: false  →  AI_GRAY_ACCESS_DENIED  /  upstream_empty_stream
stream: true   →  正常 SSE 流
```

`/responses` 端点尤其如此。本仓库的 shim 走的是 `/chat/completions`，非流式正常，所以不受这条约束；但如果你直接打 `/responses`，必须开流式。

**② 模型名必须用 `/v1/models` 返回的原始 slug**

```
GLM-5.3        →  {"error":"请求模型不在当前 JoyCode 模型目录中"}   # 裸 display 名
GLM-5.3-agent  →  正常
```

本仓库的 shim 做了双向映射，`GLM-5.3` 和 `GLM-5.3-agent` 都能传。

**③ 代理只绑 `127.0.0.1`**

跨机用不了。想让局域网 / Tailscale 上的另一台机器用，必须有 shim 中转并绑 `0.0.0.0`——这就是本仓库存在的主要理由。

## 快速开始

前置：装好 `JoyCode.app`（不是 `JoyCode IDE.app`）并登录一次。之后它会自己维护 `~/.joycode/auth.json`。

```bash
# 1. 启动 shim（前台跑，先确认能通）
JOYCODE_SHIM_TOKEN=your-secret node scripts/joycode-openai-shim.mjs

# 2. 看健康状态
curl -s -H "Authorization: Bearer your-secret" http://127.0.0.1:18888/health
# {"ok":true,"mode":"cli-proxy","proxy":"http://127.0.0.1:58870","models":[...],"error":null}

# 3. 出一次 token
curl -s -X POST http://127.0.0.1:18888/v1/chat/completions \
  -H "Authorization: Bearer your-secret" -H "Content-Type: application/json" \
  -d '{"model":"GLM-5.3","messages":[{"role":"user","content":"只回复两个字：可用"}]}'
# {"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"可用"}}],...}
```

### 常驻

```bash
./install.sh              # 装两个 launchd agent：JoyCode.app 自启 + shim 常驻
./install.sh --shim-only  # 只装 shim
./install.sh --uninstall  # 卸载两个 agent
```

脚本从 `launchd/*.plist.template` 渲染出真正的 plist（自动填 node 路径、脚本路径、日志目录），token 没给就随机生成一个并打印出来。

`KeepAlive` 用的是 `{SuccessfulExit: false}`——正常退出不重启，崩溃才拉起。

JoyCode.app 自己没有开机自启，脚本一并补上这一环（用 `open -g` 后台启动，不抢焦点）。

## 接入各种客户端

### opencode

`~/.config/opencode/opencode.json`：

```json
{
  "provider": {
    "joycode": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "JoyCode (local CLI proxy)",
      "options": {
        "baseURL": "http://127.0.0.1:18888/v1",
        "apiKey": "your-secret"
      },
      "models": {
        "GLM-5.3": { "name": "GLM-5.3", "limit": { "context": 200000, "output": 32768 } },
        "Kimi-K2.6": { "name": "Kimi-K2.6", "limit": { "context": 200000, "output": 32768 } },
        "MiniMax-M3": { "name": "MiniMax-M3", "limit": { "context": 200000, "output": 32768 } },
        "Doubao-Seed-2.0-pro": { "name": "Doubao-Seed-2.0-pro", "limit": { "context": 200000, "output": 32768 } },
        "JoyAI-Code-1.6": { "name": "JoyAI-Code-1.6", "limit": { "context": 200000, "output": 32768 } }
      }
    }
  }
}
```

验证：

```bash
opencode models | grep joycode
opencode run --model joycode/GLM-5.3 "只回复两个字：可用"
opencode run --model joycode/GLM-5.3 "用 bash 工具执行 echo hello，然后贴出输出"
```

### Paseo

在 `~/.paseo/config.json` 的 `daemon.agentProfiles` 里加：

```json
{
  "id": "agent_profile_joycode_glm53",
  "name": "GLM-5.3 · JoyCode",
  "provider": "opencode",
  "model": "joycode/GLM-5.3",
  "modeId": "build",
  "featureValues": { "auto_accept": true }
}
```

之后 `paseo run --provider opencode --model joycode/GLM-5.3` 就能用；Paseo 的 MCP 会自动把它暴露给上层 agent。

### 其他

任何认 OpenAI `/v1/chat/completions` 的工具，把 baseURL 指向 `http://<host>:18888/v1`、API key 填 `JOYCODE_SHIM_TOKEN` 即可。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JOYCODE_SHIM_HOST` | `0.0.0.0` | 监听地址；只想本机用改成 `127.0.0.1` |
| `JOYCODE_SHIM_PORT` | `18888` | 监听端口 |
| `JOYCODE_SHIM_TOKEN` | 空 | 下游要带的 Bearer token；空则不校验 |
| `JOYCODE_PROXY_URL` | 自动发现 | 手动钉死上游代理地址 |
| `JOYCODE_APP_LOG` | `~/.joycode/logs/joycode-app.log` | 端口发现来源 |
| `JOYCODE_AUTH_FILE` | `~/.joycode/auth.json` | `ptKey` 来源 |
| `JOYCODE_SHIM_TIMEOUT_MS` | `600000` | 单请求超时 |
| `JOYCODE_APP_PATH` | `/Applications/JoyCode.app` | 懒启动要拉起的 App |
| `JOYCODE_SHIM_AUTOSTART` | `1` | 端口不通时是否自动拉起 JoyCode.app；`0` 关闭 |
| `JOYCODE_SHIM_LAUNCH_WAIT_MS` | `60000` | 拉起后等新端口的超时 |
| `JOYCODE_SHIM_LAUNCH_COOLDOWN_MS` | `30000` | 两次拉起的冷却，防崩溃循环 |

## 模型目录

| slug（上游） | display（可传入） | 上下文 | 备注 |
| --- | --- | --- | --- |
| `JoyAI-Code-1.6` | `JoyAI-Code-1.6` | 200K | 首轮偶发空文本，重试即可 |
| `GLM-5.3-agent` | `GLM-5.3` | 200K | 支持 `reasoning`（high/max） |
| `Kimi-K2.6-agent` | `Kimi-K2.6` | 200K | 视觉 |
| `MiniMax-M3-agent` | `MiniMax-M3` | 200K | 视觉；输出带 `<think>` 前缀 |
| `Doubao-Seed-2.0-pro-agent` | `Doubao-Seed-2.0-pro` | 200K | 视觉 |

## 已知限制

- **JoyCode.app 会自行退出**，端口随之消失。shim 收到请求时若发现端口不通，会懒启动把它拉起来再重试（`JOYCODE_SHIM_AUTOSTART=0` 可关掉）。不是轮询，只在请求到来时动作。
- **依赖 token 自动续期**。`ptKey` 由 JoyCode.app 自己刷新（`~/.joycode/auth.json` 的 `last_refresh`）。token 过期后重启客户端即可。
- **MiniMax-M3 输出带 `<think>` 前缀**，需要下游自己剥。
- **不保证长期有效**。这是利用客户端自身通道，厂商随时可能改协议或收紧策略。协议变了先看 `~/.joycode/logs/joycode-app.log` 的 `[pro-daemon]` 行。

## 排障

| 现象 | 查什么 |
| --- | --- |
| `/health` 报 `proxy: null` | JoyCode.app 没在跑，或日志里没有 `pro responses proxy ready` |
| `/health` 返回 `proxyListening: false` 且 503 | 端口已失效；发一次请求即触发懒启动 |
| `502 joycode_proxy_failed` | 懒启动被 `JOYCODE_SHIM_AUTOSTART=0` 关掉，或拉起后 60s 内仍无新端口 |
| `401 账号未登录` | 请求没带 `ptKey` 头，或 token 过期 |
| `AI_GRAY_ACCESS_DENIED` | 走了 `/responses` 且 `stream: false` |
| `请求模型不在当前 JoyCode 模型目录中` | 模型名不是 slug，且不带 `-agent` |

## 法律与边界

本仓库不包含、不破解、不分发任何 JoyCode 的凭据或密钥。它只是把**本机已登录客户端自己开的本地端口**转发出去，凭据始终由客户端自己管理。使用前请确认符合你所在组织对第三方模型服务的使用规定。

## License

MIT
