# dumate-proxy

把 DuMate 的账号能力包装成两套入口：

1. **Magpie / OpenCode provider plugin**：插件直连 DuMate 官方网关，负责登录、模型、额度、签到、对话和生图。
2. **独立 OpenAI-compatible 反代**：给其它 OpenAI 客户端使用的本地 HTTP 服务。

两者共用项目里的 DuMate 登录、模型元数据、错误归一与生图工具协议；Magpie 插件**不依赖本地反代地址**。

## Magpie provider plugin

插件注册 OpenAI-compatible provider：

- provider id：`dumate`
- package：`@ai-sdk/openai-compatible`
- 登录态：保存在 Magpie 账号记录中，不写入本地反代文件
- 请求：使用 DuMate 官方网关 + 短期 gateway token

### 登录方式

Magpie 会显示三个登录入口：

1. **百度搭子桌面端登录态**：只读 `qianfan-desktop-app/auth.json` 与 `.cookie-key`
2. **百度账号浏览器登录**：打开百度登录页，从 DevTools Network 复制完整 Cookie 请求头
3. **手动粘贴 Cookie 字符串**：粘贴包含 `bce-sessionid` 的完整 Cookie 请求头

浏览器和手动登录会先请求 `https://console.bce.baidu.com/api/dumate/user/info` 验证 Cookie。只有 302 登录跳转、HTML 登录页或明确凭证失效才会把账号标记为需要重新登录；普通接口错误不会误伤账号。

多个账号使用百度账号显示名作为 `accountId`，上游 `bceAccountId` 存到 `uid`，因此同名上游 ID 的不同账号不会互相顶掉。

### 模型清单

插件会枚举全部模型，不做单一聚合：

- 对话模型：`model-text`、`deepseek-v41-flash`、`glm-53-flash`、`kimi-k3`、`qwen3.8-max` 等
- 生图模型：只显示一个统一模型 `dumate-image2.2`

LLM 的 `modalities.output` 为 `["text"]`，生图模型为 `["image"]`，便于 Magpie 正确识别。

插件只向 Magpie 暴露一个生图模型名 `dumate-image2.2`；实际生图调用始终选择当前最强模型。插件合并 DuMate 当前模型清单与内置版本表，按版本号取最高 `dumate-image*`；旧别名和其它版本不会出现在模型列表，但请求仍会归一到最强模型。百度后台上线更高版本后会自动切换，未知新版本复用 v3 工具端点。

### 额度与签到

插件实现 Magpie 的 `auth.usage` 与 `auth.checkin`：

- 额度：读取积分总览、已用积分、套餐到期时间和累计签到天数
- 签到：读取当天状态，未签到则提交签到请求，再复查实际到账积分
- 过期：明确登录失效时返回 `signIn: "expired"`，由 Magpie 引导重新登录

### 生图

生图走 DuMate 原生工具端点：

```text
POST /gateway/v2/tools/dumate/image_generate_v3/async
GET  /gateway/v2/tools/dumate/image_generate_v3/async?task_id=<id>
```

参考图不会把超长 data URL 直接发给上游：插件先用视觉模型读取参考图的主体、构图、服装、环境、光线和画风，再合并用户提示词调用生图接口。因此 `/images/edits` 不会打到上游不支持的旧路径。

完整调用教程见 [`docs/image-generation.md`](docs/image-generation.md)。

## 安装 Magpie 插件

```bash
magpie plugin add github:EFate/dumate-proxy
```

社区包可用时使用：

```bash
magpie plugin add @magpie-community/magpie-dumate-proxy
```

安装后在 Magpie 中添加 DuMate 账号，选择上面三种登录方式之一，然后点“重新获取模型”。

## 快速生图示例

```powershell
$env:MAGPIE_KEY='sk-你的MagpieKey'
$base='http://123.60.6.205:8890/v1'

curl.exe -X POST "$base/images/generations" `
  -H "Authorization: Bearer $env:MAGPIE_KEY" `
  -H 'Content-Type: application/json' `
  --data '{"model":"dumate-image2.2","prompt":"白发精灵少女站在森林水流中，阳光穿过树叶，动漫插画","n":1,"size":"1024x1024","response_format":"url"}'
```

参考图生成：

```powershell
$ref='C:\path\to\reference.jpg'

curl.exe -X POST "$base/images/edits" `
  -H "Authorization: Bearer $env:MAGPIE_KEY" `
  -F 'model=dumate-image2.2' `
  -F 'prompt=保留参考图的白发精灵少女、白色连衣裙、森林水流与阳光光束，生成一张新的动漫插画' `
  -F 'n=1' `
  -F 'size=1024x1024' `
  -F 'response_format=url' `
  -F "image=@$ref"
```

## 独立 OpenAI-compatible 反代

 Magpie 插件不需要这一步。独立反代用于其它 OpenAI 客户端。

```bash
node bin/dumate-proxy.mjs
```

默认监听：

```text
http://127.0.0.1:8787/v1
```

端点：

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/keepalive`

### 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DUMATE_HOST` | `127.0.0.1` | 监听地址 |
| `DUMATE_PORT` | `8787` | 监听端口 |
| `DUMATE_USER_DATA_DIR` | 自动探测 | DuMate 用户数据目录 |
| `DUMATE_OPENCODE_CONFIG` | 自动探测 | DuMate 模型清单路径 |
| `DUMATE_COOKIE` | 空 | 手工 Cookie 请求头 |
| `DUMATE_COOKIE_FILE` | 空 | Cookie 请求头文件 |
| `DUMATE_PROXY_API_KEY` | 空 | 客户端调用反代所需 API key |
| `DUMATE_MODEL` | 自动 | 默认对话模型 |
| `DUMATE_IMAGE_MODEL` | 自动 | 默认生图模型 |
| `DUMATE_STATE_DIR` | `~/.config/dumate-proxy` | 元数据快照目录 |
| `DUMATE_LOG_LEVEL` | `info` | `silent` 可关闭请求错误日志 |

## 测试

```bash
npm test
npm run check
```

## 说明

DuMate 是百度产品。本项目是独立实现，与百度无隶属或背书关系。
