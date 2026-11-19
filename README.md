# JoyCode → OpenAI-compatible Bridge

把 **JoyCode**（京东的编码助手）变成任何 OpenAI 兼容工具（opencode / DSH / Paseo / Cline / Continue）都能直接调用的模型端点——**不需要 JoyCode 桌面客户端在跑，甚至不需要安装它**。

当前架构（v3，2026-11-19）：shim 直接对 JoyCode 官方 API 网关发起**签名请求**（从桌面客户端反解出的 HMAC 签名 + `ptKey` 头），凭据来自 `~/.joycode/auth.json`。桌面客户端只剩一个用途：**登录拿凭据**——而 `scripts/joycode-login.mjs` 用浏览器复刻了同样的登录回调流程，所以客户端可以整个卸掉。

> 历史架构（v1 IDE 扩展桥接 → v2 客户端本地代理转发）的取证过程保留在 `docs/METHOD.md`；v2 依赖「app 必须在跑、端口随机漂移、懒启动拉起 app」，这正是 2026-11-16/18 两次「app 一退出链路就断」故障的根源，v3 把这三层全部去掉。

## 这个仓库解决什么问题

JoyCode 的 API 准入是**按账号白名单**的：

```json
{"error":{"code":"AI_GRAY_ACCESS_DENIED","message":"访问受限，请联系管理员开通"}}
```

2026-11-15 的判断是「网关层一律拒绝，只能走客户端内部通道」——这个结论**只对当时那个账号成立**：换用团队内另一个账号后，同一网关、同一签名直连完全放行（含流式与 tools）。所以本仓库的最终形态就是直连：`AI_GRAY_ACCESS_DENIED` 与否取决于账号资格，不取决于是否经过客户端。

| 能力 | IDE 桥接（v1） | 客户端本地代理（v2） | 直连签名（v3，当前） |
| --- | --- | --- | --- |
| 单轮文本 | ✅ | ✅ | ✅ |
| 多轮上下文 | ❌ | ✅ | ✅ |
| 流式输出 | ❌ | ✅ | ✅ |
| Function calling / tools | ❌ | ✅ | ✅ |
| 需要开着客户端 | ✅ 必需 | ✅ 必需（退出即断链） | ❌ 完全不需要 |
| 需要安装客户端 | ✅ 必需 | ✅ 必需 | ❌ 只在登录时需要（或用 joycode-login.mjs） |

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

## 三个必须知道的坑（v2 客户端代理时代踩出；v3 直连下仍要留意①③）

这三条是 v2（客户端本地代理转发）时代踩出来的，不写下来一定会重踩：

**① `stream: false` 会被灰名单拒**

```
stream: false  →  AI_GRAY_ACCESS_DENIED  /  upstream_empty_stream
stream: true   →  正常 SSE 流
```

`/responses` 端点尤其如此。本仓库的 shim 走的是 `/chat/completions`，非流式正常，所以不受这条约束；但如果你直接打 `/responses`，必须开流式。

**② 模型名必须用 `/v1/models` 返回的原始 slug**

```
Kimi-K2.6        →  {"error":"请求模型不在当前 JoyCode 模型目录中"}   # 裸 display 名
Kimi-K2.6-agent  →  正常
```

本仓库的 shim 做了双向映射，`Kimi-K2.6` 和 `Kimi-K2.6-agent` 都能传。

**③ 网关只认签名，不认标准头**

v2 时代客户端本地代理只绑 `127.0.0.1`，跨机必须经 shim；v3 直连后这条变成「官方网关 `api-ai.jd.com` 只接受 HMAC 签名 + `ptKey` 头，不接受任何标准 OpenAI 头」——所以 shim 的翻译层（OpenAI 入参 ↔ 签名直连）仍然是必需的，这也是本仓库存在的主要理由。

## 快速开始

前置：一份有效的 JoyCode 凭据（`~/.joycode/auth.json`）。两条路拿到它：

```bash
# 路 A：装过 JoyCode.app 的，登录一次即可（客户端自己维护 auth.json）
# 路 B：不装客户端，用浏览器复刻官方登录回调：
node scripts/joycode-login.mjs            # 打开浏览器 → 登录 → 自动写 auth.json
node scripts/joycode-login.mjs --status   # 看当前账号 / tenant / token 指纹
```

```bash
# 1. 启动 shim（前台跑，先确认能通）
JOYCODE_SHIM_TOKEN=your-secret node scripts/joycode-openai-shim.mjs

# 2. 看健康状态
curl -s -H "Authorization: Bearer your-secret" http://127.0.0.1:18888/health
# {"ok":true,"mode":"direct-upstream","upstream":"https://api-ai.jd.com/api","user":"...","models":[...],"error":null}

# 3. 出一次 token
curl -s -X POST http://127.0.0.1:18888/v1/chat/completions \
  -H "Authorization: Bearer your-secret" -H "Content-Type: application/json" \
  -d '{"model":"JoyAI-Code-1.6","messages":[{"role":"user","content":"只回复两个字：可用"}]}'
# {"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"可用"}}],...}
```

### 常驻

```bash
./install.sh              # 装 shim 常驻（v3 不再需要 JoyCode.app 自启）
./install.sh --uninstall  # 卸载
```

脚本从 `launchd/*.plist.template` 渲染出真正的 plist（自动填 node 路径、脚本路径、日志目录），token 没给就随机生成一个并打印出来。

`KeepAlive` 用的是 `{SuccessfulExit: false}`——正常退出不重启，崩溃才拉起。

v2 时代这里还要补装 JoyCode.app 自启；v3 直连后客户端已卸载，`launchd/app.plist.template` 仅为留档保留。

## 接入各种客户端

### opencode

`~/.config/opencode/opencode.json`：

```json
{
  "provider": {
    "joycode": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "JoyCode (direct signed gateway)",
      "options": {
        "baseURL": "http://127.0.0.1:18888/v1",
        "apiKey": "your-secret"
      },
      "models": {
        "JoyAI-Code-1.6": { "name": "JoyAI-Code-1.6", "limit": { "context": 200000, "output": 32768 } },
        "Kimi-K2.6": { "name": "Kimi-K2.6", "limit": { "context": 200000, "output": 32768 } },
        "MiniMax-M3": { "name": "MiniMax-M3", "limit": { "context": 200000, "output": 32768 } },
        "Doubao-Seed-2.0-pro": { "name": "Doubao-Seed-2.0-pro", "limit": { "context": 200000, "output": 32768 } }
      }
    }
  }
}
```

验证：

```bash
opencode models | grep joycode
opencode run --model joycode/JoyAI-Code-1.6 "只回复两个字：可用"
opencode run --model joycode/JoyAI-Code-1.6 "用 bash 工具执行 echo hello，然后贴出输出"
```

### Paseo

在 `~/.paseo/config.json` 的 `daemon.agentProfiles` 里加：

```json
{
  "id": "agent_profile_joycode_joyai",
  "name": "JoyAI-Code-1.6 · JoyCode",
  "provider": "opencode",
  "model": "joycode/JoyAI-Code-1.6",
  "modeId": "build",
  "featureValues": { "auto_accept": true }
}
```

之后 `paseo run --provider opencode --model joycode/JoyAI-Code-1.6` 就能用；Paseo 的 MCP 会自动把它暴露给上层 agent。

### 跨机部署（一台 Mac 跑客户端，另一台机器用 Paseo 调）

凭据与 shim 跑在同一台机器（登录一次即可，不需要客户端常驻），shim 监听 `0.0.0.0`，别的机器直接连过来。2026-11 在一台 Windows（wb-hub）上落地时踩到四件事，全部是 Paseo + opencode 侧的，跟 shim 无关：

1. **PATH 上的 `opencode` 必须是 2.x**。npm 上的 `opencode-ai` 是 1.x 线，而 2.x 用的是另一套库 schema；两者混用时 1.x 会报 `Database is not empty and has no session table`（连 `opencode db` 只读查询都进不去）。2.x 的包名是 `@opencode/cli`：
   ```powershell
   npm uninstall -g opencode-ai
   npm install -g @opencode/cli@2.3.0
   opencode --version   # 必须是 v2.x
   ```
2. **`provider` 单数映射，不要用 `providers` 复数**。写进 `providers`（复数）的条目拿不到 `npm` 包，Paseo 生成的模型定义缺 package，调用时报 `Unsupported package for joycode/<model>`。joycode 必须放在 `provider` 里。
3. **加顶层 `enabled_providers: ["joycode"]`**。Paseo 的模型目录来自它拉起的 opencode ACP server 的 `provider.list`；不加这个，`minimax-cn` 之类的凭据型 provider（`opencode auth` 存的，不在配置文件里）会排在前面，抢占默认模型。
4. **Paseo 的「默认模型」= 模型目录第一项**。源码 `@getpaseo/server` 的 `resolveDefaultModelId` 是 `catalog.models.find(m => m.isDefault) ?? catalog.models[0]`，而 opencode provider 从不给模型设 `isDefault`，所以不指定模型时永远取列表首项。把 joycode 排到首项，新建会话就会自动落到 `joycode/*`。

改完 `paseo reload`。注意 Paseo 会缓存 ACP server 的模型目录：`provider models opencode` 有时要等 ACP server 重建（或手动结束那个 `opencode` 子进程）才刷新，期间 `provider diagnostic` 可能短暂显示 `Status: Error: Transport`。

已验证的最终形态（wb-hub）：`provider models opencode` 只列 5 条 joycode 模型，`opencode models` 同样 5 条，不指定模型起 agent 落到 `joycode/JoyAI-Code-1.6` 并正常出 token。

跨机还有一条前提：shim 那边要能被对端访问到（Tailscale / 局域网都行），并且 `JOYCODE_SHIM_TOKEN` 不要留空。

### 其他

任何认 OpenAI `/v1/chat/completions` 的工具，把 baseURL 指向 `http://<host>:18888/v1`、API key 填 `JOYCODE_SHIM_TOKEN` 即可。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JOYCODE_SHIM_HOST` | `0.0.0.0` | 监听地址；只想本机用改成 `127.0.0.1` |
| `JOYCODE_SHIM_PORT` | `18888` | 监听端口 |
| `JOYCODE_SHIM_TOKEN` | 空 | 下游要带的 Bearer token；空则不校验 |
| `JOYCODE_SHIM_DISABLED_MODELS` | `GLM-5.3` | 逗号分隔、大小写不敏感；命中的模型从 `/v1/models` 隐藏且请求返 `400 model_disabled`。设空串恢复全部 |

## 凭据与换号

shim 每个请求都重读 `JOYCODE_AUTH_FILE` 的 `tokens.access_token` 与 `tenant`。默认值 `~/.joycode/auth.json` 就是唯一凭据真源——**v3 已经没有「客户端登录态」与「shim 用的凭据」两个来源了**，读哪个文件就是哪个身份。

2026-11-16 的换号事故（换号后整条链路 406）在 v3 下对应的操作很简单：换号后 `node scripts/joycode-login.mjs` 重新走一遍浏览器登录，`auth.json` 就更新了，shim 不用重启。

诊断顺序：

```bash
# 1. 当前凭据属于哪个账号
node scripts/joycode-login.mjs --status
# 2. shim 眼里的健康状态（user 字段即当前身份）
curl -s -H "Authorization: Bearer your-secret" http://127.0.0.1:18888/health
```

要固定身份（例如多账号切换），把目标账号快照落成独立文件，再让 LaunchAgent 指过去：

```bash
cp ~/.joycode/auth.json ~/.joycode/auth-<账号>.json
chmod 600 ~/.joycode/auth-<账号>.json
# plist 的 EnvironmentVariables 加 JOYCODE_AUTH_FILE 指向该文件
# 改完必须 bootout + bootstrap（kickstart -k 不会重读 plist 的 env）
```

### ⚠️ pin 是个陷阱（v2 时代事故，教训仍成立）

v2 时代 shim 的凭据可能 pin 在快照文件上，而客户端登录的是另一个账号——「客户端自己能用」和「shim 能用」是两件事。2026-11-18 实例：用户在 JoyCode.app 里重新登录了 `zhanghong1991217`，客户端一切正常，但下游一直 406，因为 shim 还 pin 在过期旧快照上。当时靠「同一份 token 绕过 shim 直连」的对照法定位：**经 shim 全红、直连全绿 ⇒ 身份不一致**，别在端口、日志、代理上浪费时间。

v3 里 `JOYCODE_AUTH_FILE` 就是唯一身份源，这条对照法仍然成立（直连验证脚本见 `docs/METHOD.md`）。


## 模型目录

| slug（上游） | display（可传入） | 上下文 | 计费 | 备注 |
| --- | --- | --- | --- | --- |
| `JoyAI-Code-1.6` | `JoyAI-Code-1.6` | 200K | **0x（免费）** | 首轮偶发空文本，重试即可 |
| `Kimi-K2.6-agent` | `Kimi-K2.6` | 200K | 0.5x | 视觉 |
| `MiniMax-M3-agent` | `MiniMax-M3` | 200K | 0.4x | 视觉；输出带 `<think>` 前缀 |
| `Doubao-Seed-2.0-pro-agent` | `Doubao-Seed-2.0-pro` | 200K | 0.4x | 视觉 |
| `GLM-5.3-agent` | `GLM-5.3` | 200K | 0.6x | **默认禁用**（见下） |

**怎么确认哪档免费（配额耗尽判别法）**：读积分计数器的「请求前后差值」不可信 —— 它有异步结算延迟，几秒后才跳变，还会跨到下一次测量里。改用不受延迟干扰的判据：**当配额已经耗尽（`remain <= 0`）时，还能出 token 的就是不扣积分的**。2026-11-16 在 `remain=-20` 下实测：`JoyAI-Code-1.6` 连跑 3 次全部正常出 token 且积分 Δ=0，其余四个全部 `insufficient_quota`。积分可通过直连签名接口 `functionId=get_newpoint_ide` 读取（见 `docs/METHOD.md`）。

**`GLM-5.3` 默认禁用**：它是四个付费档里最贵的一档（0.6x），本仓库默认把它挡在外面 —— `JOYCODE_SHIM_DISABLED_MODELS` 默认值就是 `GLM-5.3`，命中的模型既不出现在 `/v1/models`，直接请求也返 `400 model_disabled`。要放开就把它从环境变量里去掉（或设空串）。

## 已知限制

- **依赖 `~/.joycode/auth.json` 的有效性**。客户端卸载后没有进程替你续期；签名失效时用 `node scripts/joycode-login.mjs` 重新登录。
- **网关行为怪癖**：带 `accept: text/event-stream` 打非流式会被网关转发成 `COLOR_FORWARD_EXCEPTION`（`HttpStatus=406`）——shim 已按需删 accept 头；非流式回纯 JSON、流式回 SSE，shim 已分别适配。
- **签名算法是反解出来的**，HMAC key 硬编码在 shim 里；厂商换 key 或换签名参数就失效。
- **MiniMax-M3 输出带 `<think>` 前缀**，直连非流式的 `content` 里还会混 `</think>` 残渣（shim 已剥）。
- **套餐积分会耗尽**。除 `JoyAI-Code-1.6` 外的模型都扣月积分；耗尽后它们一律返 `insufficient_quota`，而 1.6 仍可用（见上面「配额耗尽判别法」）。
- **不保证长期有效**。这是从客户端反解的私有协议，厂商随时可能改。

## 排障

| 现象 | 查什么 |
| --- | --- |
| `/health` 返回 503 | `auth.json` 缺失/无效；`node scripts/joycode-login.mjs` 重新登录 |
| `401 账号未登录`（上游） | `ptKey` 头缺失或 token 失效；`--status` 看凭据，过期就重登 |
| `AI_GRAY_ACCESS_DENIED` | 账号无该模型资格（白名单按账号）；换有资格的账号 |
| `COLOR_FORWARD_EXCEPTION / HttpStatus=406` | 请求带了 `accept: text/event-stream` 又是非流式（shim 已处理，直接 curl 上游才会踩） |
| `请求模型不在当前 JoyCode 模型目录中` | 模型名不是 slug，且不带 `-agent` |
| `400 model_disabled` | 该模型在 `JOYCODE_SHIM_DISABLED_MODELS` 里（默认 `GLM-5.3`） |
| `insufficient_quota` | 套餐积分耗尽；只有 `JoyAI-Code-1.6` 不受影响 |
| `502 upstream_error` | 上游返回了 shim 不认识的错误体；看 shim.err.log |

## 法律与边界

本仓库不包含、不破解、不分发任何 JoyCode 的凭据或密钥。v3 的签名参数是从官方桌面客户端自身代码反解的，仅用于让**本机已登录账号**的凭据被标准 OpenAI 工具链使用；凭据始终留在 `~/.joycode/auth.json`，不经任何第三方。使用前请确认符合你所在组织对第三方模型服务的使用规定。

## License

MIT
