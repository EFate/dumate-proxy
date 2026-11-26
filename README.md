# dumate-proxy

把百度搭子 DuMate 的个人额度暴露成一套 OpenAI 兼容反代，同时覆盖 **LLM 对话** 与 **生图模型**。

运行层使用 Node.js 22+ 原生能力（ESM、`fetch`、`ReadableStream`、`FormData`、`AbortSignal.timeout`、AES-256-GCM），无第三方运行时依赖。

## 能力

- `GET /v1/models`：输出真实账号模型清单，区分 `chat` / `image`。
- `POST /v1/chat/completions`：
  - LLM：透传 OpenAI 兼容请求，支持 SSE 流式、工具调用与推理档位规范化。
  - 生图模型：自动把 `messages` 转成 DuMate 网关所需的 `prompt` 请求，并把图片结果包装成 Markdown 图片消息。
- `POST /v1/images/generations`：标准 OpenAI 生图接口，支持 `url` / `b64_json`。
- `POST /v1/images/edits`：multipart 图片编辑入口，会把图片转 data URL 后交给生图模型。
- 桌面端登录态只读复用：`auth.json` + `.cookie-key` 在内存中解密，不修改 DuMate 文件。
- gateway token 单飞缓存、提前刷新、401 自动失效。
- 模型清单快照只保存元数据，不含 Cookie、token、API key 或本地代理地址。
- 支持 Magpie provider plugin 模型识别、登录续期与后台保活。
- Magpie 供应商页会显示可点击的 DuMate 登录入口；登录时检查反代健康状态与 DuMate 登录态。

## 启动

```bash
node bin/dumate-proxy.mjs
```

默认监听 `127.0.0.1:8787`。健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

首次启动会自动读取当前账号的 `opencode.json`。若桌面端未登录或路径不同，可设置：

```powershell
$env:DUMATE_USER_DATA_DIR = "C:\Users\<你>\AppData\Roaming\qianfan-desktop-app"
$env:DUMATE_PORT = "8787"
node bin/dumate-proxy.mjs
```

也可直接粘贴浏览器登录后的完整 Cookie 请求头：

```powershell
$env:DUMATE_COOKIE = "bce-sessionid=...; BDUSS=...; ..."
node bin/dumate-proxy.mjs
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DUMATE_HOST` | `127.0.0.1` | 监听地址 |
| `DUMATE_PORT` | `8787` | 监听端口 |
| `DUMATE_USER_DATA_DIR` | 自动探测 | DuMate 用户数据目录 |
| `DUMATE_OPENCODE_CONFIG` | 自动探测 | 账号模型清单绝对路径 |
| `DUMATE_COOKIE` | 空 | 手工 Cookie 请求头 |
| `DUMATE_COOKIE_FILE` | 空 | 存放 Cookie 请求头的文件 |
| `DUMATE_PROXY_API_KEY` | 空 | 设置后客户端需带 `Authorization: Bearer <key>` |
| `DUMATE_MODEL` | `model-text` | 默认对话模型 |
| `DUMATE_IMAGE_MODEL` | `dumate-image0.1` | 默认生图模型 |
| `DUMATE_PROXY_URL` | `http://127.0.0.1:8787/v1` | Magpie 插件连接反代的地址 |
| `DUMATE_STATE_DIR` | `~/.config/dumate-proxy` | 元数据快照目录 |
| `DUMATE_TIMEOUT_MS` | `120000` | 普通请求超时 |
| `DUMATE_IMAGE_TIMEOUT_MS` | `180000` | 生图请求超时 |
| `DUMATE_IMAGE_FETCH_TIMEOUT_MS` | `20000` | 下载生成图片超时 |
| `DUMATE_MAX_IMAGE_BYTES` | `20971520` | 单张图片下载上限 |
| `DUMATE_MAX_BODY_BYTES` | `67108864` | 请求体上限 |
| `DUMATE_LOG_LEVEL` | `info` | 设为 `silent` 关闭请求错误日志 |

## 调用示例

### 对话（LLM）

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"model-text","messages":[{"role":"user","content":"用一句话解释向量数据库"}]}'
```

### 通过 chat endpoint 调用生图模型

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"dumate-image0.1","messages":[{"role":"user","content":"画一只戴墨镜的猫，扁平插画风格"}]}'
```

### 标准生图接口

```bash
curl http://127.0.0.1:8787/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"model":"dumate-image0.1","prompt":"赛博朋克城市夜景，霓虹灯，广角","n":1,"size":"1024x1024"}'
```

返回 `b64_json`：

```bash
curl http://127.0.0.1:8787/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"一只白色狐狸","response_format":"b64_json"}'
```

### 图片编辑

```bash
curl http://127.0.0.1:8787/v1/images/edits \
  -F 'image=@input.png' \
  -F 'prompt="把背景换成海边日落"'
```

## DuMate 生图协议

网关使用 `https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions`，生图模型要求 `prompt` 字段而不是 `messages`：

```json
{"model":"dumate-image0.1","prompt":"a simple red circle"}
```

网关会再转发到 `https://qianfan.baidubce.com/v2/images/generations`。账号若未开通对应生图模型权限，上游会返回 `invalid_model`；本反代会保留该错误并规范化为 OpenAI 错误响应。模型清单里有生图入口不代表账号一定具备调用权限。

## 作为 Magpie provider plugin 使用

项目根目录本身就是 Magpie 插件入口（`package.json` 的 `main` 指向 `magpie.mjs`）。先启动反代，再把本项目加入 Magpie：

```bash
magpie plugin add /absolute/path/to/dumate-plugin
```

插件会注册 OpenAI-compatible provider：

- provider id：`dumate`
- `npm`：
  `@ai-sdk/openai-compatible`
- `api` / `loader.baseURL`：`DUMATE_PROXY_URL`，默认 `http://127.0.0.1:8787/v1`
- 登录方式：选择 “DuMate 本地反代”，插件只检查 `/healthz`，真正的 DuMate 登录态由反代进程管理

### 模型识别

- `config.provider.dumate.models` 是 map：key 是 Magpie 可见模型 id，value.id 是上游 API id。
- LLM 的 `modalities.output` 为 `["text"]`。
- `dumate-image0.1` 的 `modalities.output` 为 `["image"]` 且不含 `"text"`，让 Magpie 将其识别为生图模型。
- 生图模型固定 `tool_call:false`、`reasoning:false`、`attachment:false`。
- `loader.fetch` 放行 `/models`、`/chat/completions`、`/images/generations`、`/images/edits` 及对应 `/v1/*` 路径；Proxy API key 只会发给反代 origin。

### 登录方式

Magpie 插件本身只负责登录与官方网关请求，不要求填写本地反代地址：

- **百度搭子桌面端登录态**：读取 `qianfan-desktop-app/auth.json` 与 `.cookie-key`，只读复用本机客户端登录态。
- **百度账号浏览器登录**：打开百度登录页，登录后从 DevTools Network 复制请求头 Cookie 并粘贴。
- **手动粘贴 Cookie 字符串**：直接粘贴包含 `bce-sessionid` 的完整 Cookie 请求头。

浏览器与手动方式会通过 `https://console.bce.baidu.com/api/dumate/user/info` 验证 Cookie；成功后 Cookie 保存在 Magpie 账号记录中。桌面端账号在客户端重新登录后会由 `auth.refresh` 自动读取新 Cookie。

多账号登录使用百度账号显示名作为账号标识，并把上游账号 ID 存到 `uid`；即使上游返回相同 `bceAccountId`，不同显示名也不会互相顶掉。只有登录页、302 跳转或明确的凭证失效信号才会把账号标记为需要重新登录。
### 生图

生图使用 DuMate 原生工具端点 `image_generate_v3/async`，提交任务后轮询取图；默认模型 `dumate-image2.2`，`group/image` 与旧 `dumate-image0.1` 都会归一到该可用模型。

参考图不直接上传超长 data URL：先通过视觉模型把参考图转成结构化中文提示词，再调用文生图接口。这样 `/images/edits` 不会再把请求错误地打到上游不支持的 `/apis/v1/images/edits`。
### 额度与签到

插件实现 Magpie 的 `auth.usage` 与 `auth.checkin` 钩子：

- 额度：读取 `/api/dumate/points/quota_overview` 与 `/api/dumate/points/loginBonusInfo`，展示剩余积分、已用积分、最近到期套餐和累计签到天数。
- 签到：读取当天签到状态；未签到时调用 `/api/dumate/points/loginBonus`，再复查积分变化并返回实际到账积分。
- 登录过期时返回 `signIn: "expired"`，由 Magpie 引导重新登录。
### 登录态使用

模型请求由插件直接发送到官方网关：先从百度控制台换取 gateway token，再请求 `https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions`。token 做单飞缓存；401 或跳转登录页时清除缓存并返回 `X-Magpie-Sign-In: expired`，让 Magpie 引导重新登录。

这里没有本地反代 IP 或端口配置；独立反代进程仍可供其他 OpenAI 兼容客户端使用。
## 测试

```bash
npm test
```

## 说明

DuMate 是百度产品。本项目是独立本地反代实现，与百度无隶属或背书关系。
