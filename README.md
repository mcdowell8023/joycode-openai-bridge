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
Kimi-K2.6        →  {"error":"请求模型不在当前 JoyCode 模型目录中"}   # 裸 display 名
Kimi-K2.6-agent  →  正常
```

本仓库的 shim 做了双向映射，`Kimi-K2.6` 和 `Kimi-K2.6-agent` 都能传。

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
  -d '{"model":"JoyAI-Code-1.6","messages":[{"role":"user","content":"只回复两个字：可用"}]}'
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

客户端只能跑在装了 JoyCode 且已登录的那台机器上，但 shim 监听 `0.0.0.0`，所以别的机器可以直接连过来。2026-11 在一台 Windows（wb-hub）上落地时踩到四件事，全部是 Paseo + opencode 侧的，跟 shim 无关：

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
| `JOYCODE_PROXY_URL` | 自动发现 | 手动钉死上游代理地址 |
| `JOYCODE_APP_LOG` | `~/.joycode/logs/joycode-app.log` | 端口发现来源 |
| `JOYCODE_AUTH_FILE` | `~/.joycode/auth.json` | `ptKey` 来源 |
| `JOYCODE_SHIM_TIMEOUT_MS` | `600000` | 单请求超时 |
| `JOYCODE_APP_PATH` | `/Applications/JoyCode.app` | 懒启动要拉起的 App |
| `JOYCODE_SHIM_AUTOSTART` | `1` | 端口不通时是否自动拉起 JoyCode.app；`0` 关闭 |
| `JOYCODE_SHIM_LAUNCH_WAIT_MS` | `60000` | 拉起后等新端口的超时 |
| `JOYCODE_SHIM_LAUNCH_COOLDOWN_MS` | `30000` | 两次拉起的冷却，防崩溃循环 |
| `JOYCODE_SHIM_DISABLED_MODELS` | `GLM-5.3` | 逗号分隔、大小写不敏感；命中的模型从 `/v1/models` 隐藏且请求返 `400 model_disabled`。设空串恢复全部 |

## 凭据固定（换号会打断链路）

shim 每个请求都重读 `JOYCODE_AUTH_FILE` 的 `tokens.access_token` 当 `ptKey`。默认值 `~/.joycode/auth.json` 意味着「跟随 JoyCode.app 当前登录账号」。

**在 JoyCode.app 里换号会立刻打断整条链路。** 2026-11-16 实例：账号从 `mcdowell1991` 换成 `zhanghong1991217`，代理进程跟着重建（端口 `55735 → 61767`），下游随即报 `HTTP 406 {"code":401,"msg":"账号未登录"}`。原因不是 token 过期，而是新账号在 chat 路径被判无权限（`AI_GRAY_ACCESS_DENIED`）—— 同一个代理、同一个端口，只换 `ptKey` 头打过去，旧账号 200 出 token、新账号被拒，就能确认是账号问题而非链路问题。

诊断顺序：

```bash
# 1. 当前 auth.json 属于哪个账号（token 是 base64，解出来是 <ts>||<loginType>|<userId>|<secret>）
python3 - <<'PY'
import json,base64,os
t=json.load(open(os.path.expanduser("~/.joycode/auth.json")))["tokens"]["access_token"]
print(base64.b64decode(t+"==").decode())
PY
# 2. 代理端口与是否存活
grep -o "pro responses proxy ready: http://127.0.0.1:[0-9]*" ~/.joycode/logs/joycode-app.log | tail -1
# 3. 换号时间点
grep -E "login_completed|login_credential_persisted|proxy ready" ~/.joycode/logs/joycode-app.log | tail -5
```

要固定身份，把目标账号的 token 快照落成独立文件，再让 LaunchAgent 指过去：

```bash
cp ~/.joycode/auth.json ~/.joycode/auth-<账号>.json
chmod 600 ~/.joycode/auth-<账号>.json
# 编辑：tokens.access_token / tokens.refresh_token / tenant / userId 必须同属一个账号
```

plist 的 `EnvironmentVariables` 加 `JOYCODE_AUTH_FILE` 指向该文件。改完必须 **bootout + bootstrap**（`kickstart -k` 不会重读 plist 的 env）：

```bash
launchctl bootout  gui/$(id -u)/<label>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist
tail -3 <log dir>/shim.out.log   # 应见 [shim] credential: … (pinned)
```

代价：固定文件里的 `refresh_token` 不再被 JoyCode.app 续期（app 只维护当前登录账号），过期后必须重新从该账号登录并重做快照。

### ⚠️ pin 是个陷阱：换号后必须解 pin

pin 之后 shim 用的是**快照文件**，不是 JoyCode.app 当前登录的账号。所以「用户在客户端里换了号、客户端自己能用」和「shim 能用」是两件事 —— 2026-11-18 就栽在这里：用户在 JoyCode.app 里重新登录了 `zhanghong1991217`，客户端一切正常，但下游一直报 `HTTP 406 账号未登录`，因为 shim 还 pin 在 11-16 的 `mcdowell1991` 旧快照上，那个 token 早过期了。

**先分清是「链路坏了」还是「身份不对」，一条命令即可**：

```bash
# 同一份 token，绕过 shim 直连上游（不经代理，不经 shim）
# 出 token  ⇒ 账号没问题，是 shim 用的身份不对 → 解 pin
# 被拒      ⇒ 账号/权限问题，跟 shim 无关
```

实测形态：**经 shim 全红、直连全绿 ⇒ 一定是身份不一致**，不要在端口、日志、代理上浪费时间。

解 pin（让 shim 跟随 JoyCode.app 当前登录）：

```bash
/usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:JOYCODE_AUTH_FILE" \
  ~/Library/LaunchAgents/<label>.plist
launchctl bootout  gui/$(id -u)/<label>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist
tail -3 <log dir>/shim.out.log   # 应见 [shim] credential: ~/.joycode/auth.json (live JoyCode.app login)
```

注意日志里的 `(pinned)` / `(live JoyCode.app login)` 后缀 —— 这是判断 shim 到底在用哪份凭据的唯一直接证据。`kickstart -k` 不重读 plist，必须 bootout + bootstrap。

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

- **JoyCode.app 会自行退出**，端口随之消失。shim 收到请求时若发现端口不通，会懒启动把它拉起来再重试（`JOYCODE_SHIM_AUTOSTART=0` 可关掉）。不是轮询，只在请求到来时动作。
- **依赖 token 自动续期**。`ptKey` 由 JoyCode.app 自己刷新（`~/.joycode/auth.json` 的 `last_refresh`）。token 过期后重启客户端即可。
- **在 JoyCode.app 里换号会立刻打断链路**，且新账号不一定有生成权限（报 `AI_GRAY_ACCESS_DENIED`，下游表现为 `HTTP 406 账号未登录`）。要固定身份用 `JOYCODE_AUTH_FILE` 指向账号快照文件，见上面「凭据固定」。
- **MiniMax-M3 输出带 `<think>` 前缀**，需要下游自己剥。
- **套餐积分会耗尽**。除 `JoyAI-Code-1.6` 外的模型都扣月积分；耗尽后它们一律返 `insufficient_quota`，而 1.6 仍可用（见上面「配额耗尽判别法」）。
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
| `400 model_disabled` | 该模型在 `JOYCODE_SHIM_DISABLED_MODELS` 里（默认 `GLM-5.3`） |
| `insufficient_quota` | 套餐积分耗尽；只有 `JoyAI-Code-1.6` 不受影响 |

## 法律与边界

本仓库不包含、不破解、不分发任何 JoyCode 的凭据或密钥。它只是把**本机已登录客户端自己开的本地端口**转发出去，凭据始终由客户端自己管理。使用前请确认符合你所在组织对第三方模型服务的使用规定。

## License

MIT
