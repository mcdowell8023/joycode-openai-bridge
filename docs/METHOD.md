# 方法：从一个不透明的桌面客户端里，挖出它自己用的本地模型端点

这不是 JoyCode 专属的做法。任何「官方 API 拒你、但客户端里能用」的桌面 AI 工具，都可以按这套流程走一遍。JoyCode 只是这次的样本。

## 判定值不值得做

先花两分钟确认三件事，任何一条不成立就停手：

1. **同一账号，API 调用失败但客户端界面能用** —— 这说明限制在网关层，不在账号层。如果客户端也报同样的错，那就真是没权限，别折腾。
2. **客户端是 Electron 或类似外壳** —— 才有 `asar` 可解包、有 DevTools 协议口可探。原生编译的二进制难度高一个量级。
3. **客户端是本地跑推理路由** —— 云端只做转发、本地做协议适配的那种，本地一定有 HTTP 端口。纯远程渲染的（比如网页套壳）没有。

JoyCode 三条全中：`AI_GRAY_ACCESS_DENIED` 只出现在 API 路径；`JoyCode.app` 是 Electron 33；它在本地起了 responses proxy。

## 步骤一：列出客户端开的端口

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -i <客户端进程名>
```

按端口分三类看：

| 特征 | 通常是什么 |
| --- | --- |
| 固定端口，如 19888 | DevTools / CDP 调试口，可以用来读页面状态 |
| 随机端口（每次启动变） | 业务代理，最有价值 |
| 固定端口 + `/catalog` 之类路径 | 模型目录、配置服务 |

随机端口是重点。它是客户端为内部调用临时起的服务，通常不做鉴权加固。

## 步骤二：从日志里找到它的地址

随机端口没法硬编码，但客户端一定会把地址打进日志：

```bash
grep -rE "proxy ready|listening on|http://127\.0\.0\.1:[0-9]+" ~/.<客户端>/logs/ | tail -5
```

JoyCode 的那行是：

```
[daemon] pro responses proxy ready: http://127.0.0.1:58870/api/saas/openai/v1
```

**这行日志是整个方案的锚点。** 所有自动化都建立在「读最后一条」上，因为端口每次启动都变。

如果日志里没有，退一步用 `lsof` 实时抓，或者用 CDP 从页面里读（见步骤五）。

## 步骤三：摸清端点和鉴权

先打模型列表，这一步通常不需要鉴权或鉴权很松：

```bash
curl -s http://127.0.0.1:<port>/<prefix>/models | head -c 500
```

拿到模型 slug 后，逐个试鉴权头。**这一步最容易卡住，因为客户端内部用的头往往不是标准的 `Authorization`。**

JoyCode 的实测矩阵：

| 头 | 结果 |
| --- | --- |
| `Authorization: Bearer <token>` | 401 账号未登录 |
| `X-Model-Token: <token>` | 401 账号未登录 |
| `ptKey: <token>` | **200 正常** |
| 不带任何头（`/responses` 端点） | 200 正常 |

`ptKey` 这个头名是从客户端的请求日志里看到的，不是猜的：

```bash
grep -iE "request_headers|ptKey|authorization" ~/.<客户端>/logs/*.log | head -20
```

token 本身的来源也是文件：

- `~/.joycode/auth.json` 的 `tokens.access_token`
- `~/.joycode/config.toml` 的 `[model_providers.*.http_headers].ptKey`

两边值一致，说明这就是客户端自己用的那份。

## 步骤四：确认它到底能不能出 token

**这一步必须做，不能靠 `/models` 返回 200 就下结论。** JoyCode 就是典型的「模型目录能读、生成被拒」。

失败的形态有三种，要分清楚：

| 现象 | 含义 |
| --- | --- |
| `AI_GRAY_ACCESS_DENIED` | 网关层拒绝。换端点、换头、换 stream 参数再试 |
| `upstream_empty_stream` | 上游空流。通常是非流式请求导致 |
| `请求模型不在目录中` | 模型名不对，要用 `/models` 的原始 slug |

JoyCode 的坑是 `stream: false` 必被拒、`stream: true` 才通。这条只能实测出来。

## 步骤五：CDP 兜底（可选）

如果日志和端口都不给线索，用 DevTools 协议读页面状态：

```bash
curl -s http://127.0.0.1:19888/json/version   # 确认 CDP 活着
curl -s http://127.0.0.1:19888/json/list      # 列出页面
```

页面里的 `localStorage`、`window.__CONFIG__`、网络请求记录都可能带着真实端点。JoyCode 这次没用到这步，但端口是随机的情况下，这是最后的发现手段。

## 步骤六：包一层 shim，别直连

发现端点之后，**不要**让下游工具直连它。原因三个，每个都足够致命：

1. **端口会变。** 客户端重启一次，所有下游配置全部失效。shim 每次请求重新读日志，下游零感知。
2. **只绑 127.0.0.1。** 跨机用不了。shim 绑 `0.0.0.0` 才能给局域网 / Tailscale 上的机器用。
3. **鉴权头非标准。** 下游工具只认 `Authorization: Bearer`。shim 负责翻译成 `ptKey`。

shim 的职责就这四件事：发现端口、取 token、翻译鉴权、透传流式。不要加缓存、不要加重试、不要加队列——出问题时这些只会让排查变难。

## 步骤七：验证链条，从内到外

按这个顺序验，出问题能立刻定位是哪一层：

```bash
# 1. 上游代理本身
curl -s http://127.0.0.1:<proxy-port>/<prefix>/models

# 2. shim 健康
curl -s -H "Authorization: Bearer <shim-token>" http://127.0.0.1:18888/health

# 3. shim 出 token
curl -s -X POST http://127.0.0.1:18888/v1/chat/completions -H ... -d '...'

# 4. shim 的 tools
curl -s -X POST ... -d '{"tools":[...],"messages":[...]}'

# 5. 下游工具（opencode / Paseo / ...）
opencode run --model <provider>/<model> "..."
```

第 4 步特别重要：**tools 能不能通，决定了这个端点能不能给 coding agent 用**。不能出 `tool_calls` 的通道只能当聊天用。

## 步骤八：跨机部署时，下游工具的配置层比 shim 更容易出错

shim 一旦绑 `0.0.0.0`，跨机链路本身很简单（对端 curl 一下 `/health` 就验完）。真正耗时间的是**下游 agent 工具自己的 provider/模型目录机制**——它们对「配置文件里写了什么」和「运行时实际加载了什么」经常是两回事。

以 Paseo + opencode 为例，2026-11 在一台 Windows 上落地时依次踩到四层，每层都要单独验证：

| 层 | 症状 | 真因 | 判据 |
| --- | --- | --- | --- |
| 运行时版本 | `Database is not empty and has no session table` | PATH 上是 1.x 线（`opencode-ai`），库是 2.x schema | `opencode --version` 必须与库同代 |
| provider 映射位置 | `Unsupported package for <provider>/<model>` | 写进了 `providers`（复数），拿不到 `npm` 包 | 条目必须在 `provider`（单数）里 |
| 模型目录顺序 | 不指定模型时落到别的 provider | 凭据型 provider（`opencode auth` 存的）排在前面 | 加 `enabled_providers` 白名单收窄 |
| 默认模型 | 新建会话默认模型不可用 | Paseo 取 `catalog.models[0]`，opencode 从不设 `isDefault` | 让目标 provider 成为目录首项 |

关键教训：**「配置文件改了」不等于「运行时生效了」**。Paseo 会缓存 ACP server 的模型目录，改完配置要么 reload、要么等 ACP server 重建；期间 `provider diagnostic` 可能显示 `Status: Error: Transport`，不要据此判定配置失败。

判断「默认模型从哪来」不要猜，去读下游工具的服务端源码：Paseo 的答案在 `@getpaseo/server/dist/server/server/agent/agent-manager.js` 的 `resolveDefaultModelId`，两行代码就说明了一切（`catalog.models.find(m => m.isDefault) ?? catalog.models[0]`）。

## 步骤九：判断哪个模型真的不花钱

代理通了、能出 token，不等于能一直用 —— 多数客户端会按模型扣套餐积分，耗尽后整条链就哑了。**先搞清哪个模型不扣积分**，否则你搭的是个随时会停的通道。

### 不要用「请求前后读计数器」

直觉做法是「请求前读一次积分、请求后读一次、差值就是成本」。这条路实测不可靠：

- 计数器**异步结算**：请求返回时增量还没写进去，几秒后才跳变
- 延迟的增量会**跨到下一次测量里**，让下一次看起来贵得离谱
- 实测出现过单次小请求「Δ176」「Δ3105」这种明显是上一批延迟结算的假值

### 用「配额耗尽后还能不能用」

这个判据不受结算延迟影响，因为它只看**能不能出 token**，不看计数变化：

1. 读当前积分余额，确认 `remain <= 0`（真的耗尽了）
2. 在耗尽状态下，逐个模型发一条最小请求
3. **能正常出 token ⇒ 不扣积分；返配额错误 ⇒ 扣积分**

2026-11-16 实测结果（`remain=-20`）：`JoyAI-Code-1.6` 连跑 3 次全部出 token 且积分 Δ=0；其余四个全部 `insufficient_quota`。

### 怎么读积分

不要指望代理提供积分接口 —— 实测本地代理的 `/usage` / `/newpoint` 全部 401「账号未登录」。要用**客户端自己调的那个带签名的接口**：签名算法、HMAC key、`functionId` 表都在客户端 bundle 里（本次是 `get_newpoint_ide`），反解出来就能直连读余额。这一步值得做，因为它是唯一能拿到真实扣费的地方。

### 禁用一个模型要在两层都做

只想让某个贵模型不出现时，光删配置里的条目不够：

- **目录层**：从 `/v1/models` 的返回里过滤掉（否则下游仍能选到）
- **请求层**：在模型名解析**之前**显式拒绝。⚠️ 这一步容易漏 —— 如果有「未知模型回退到第一个」的兜底逻辑，只删目录会让它静默回退成别的模型，禁用形同虚设

## 判断标准：什么时候该放弃

- 客户端本身也报权限错 → 放弃，这是账号问题
- 端点只接受客户端签名的请求（有 HMAC 或证书绑定）→ 放弃，逆向签名不值得
- 只能非流式 → 可以继续，但要接受首字延迟
- 不能出 tool_calls → 只能当聊天用，别接给 coding agent

JoyCode 这次三条都没踩到，所以成了。

## 这套方法的代价

**它是临时的。** 厂商改一次协议就失效。所以：

- 发现过程要写成脚本，不要写成文档里的手动步骤——协议变了，改一处脚本比改十处文档快
- 所有关键判断（端口发现方式、鉴权头名、必须流式）写进代码注释，不要只写在 README
- 明确写「不保证长期有效」，别让人当成稳定方案依赖

## 附：JoyCode 的具体实现

见本仓库根目录 `README.md` 和 `scripts/joycode-openai-shim.mjs`。那 400 多行代码就是上面九步的落地：端口发现、token 读取、鉴权翻译、流式透传、懒启动、模型禁用。
