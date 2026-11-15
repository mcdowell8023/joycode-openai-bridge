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

见本仓库根目录 `README.md` 和 `scripts/joycode-openai-shim.mjs`。那 328 行代码就是上面七步的落地。
