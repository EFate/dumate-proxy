# Magpie 模型识别与登录保活

本项目作为 OpenAI-compatible provider plugin 接入 Magpie，模型声明和登录续期按 Magpie 的 provider plugin 契约实现。

## 模型声明

`config.provider.dumate.models` 使用 map 结构：

- key：Magpie 可见模型 id
- value.id：上游 API id
- value.limit：上下文与输出上限
- value.modalities：输入与输出模态
- value.tool_call / reasoning / attachment：能力标记

LLM 输出模态固定为 `["text"]`。生图模型 `dumate-image0.1` 输出模态固定为 `["image"]`，且不包含 `"text"`，这是 Magpie 识别生图模型的稳定信号。

常见模型映射：

- `model-text`：智能路由，输出 `["text"]`
- `deepseek-v41-flash`：推理模型，输出 `["text"]`，提供 none / low / high / max 推理档位
- `dumate-image0.1`：生图模型，输出 `["image"]`

## 请求路径

`loader.fetch` 只接受反代 origin 下的这些路径：

- `/models`
- `/chat/completions`
- `/images/generations`
- `/images/edits`
- 以及对应的 `/v1/*` 路径

Proxy API key 只会发给配置中的反代地址，避免凭据泄漏到其他域名。

## 生图模型选择

生图模型按版本号动态选择：插件合并 DuMate 当前模型清单与内置版本表，取版本号最高的 `dumate-image*`。当前基线是 `dumate-image2.2`；后台上线更高版本后会自动切换，未知新版本复用 v3 工具端点。
## 模型清单

模型元数据来自当前 DuMate 账号配置；没有本地配置时使用插件内置完整清单，覆盖 22 个对话模型和 1 个生图模型。LLM 输出模态为 `["text"]`，生图模型输出模态为 `["image"]`。
## 登录方式

插件遵循 Magpie provider plugin 的登录契约，提供三种入口：桌面端只读复用、百度账号浏览器登录、手动粘贴 Cookie。后两者先请求百度控制台 `/api/dumate/user/info` 验证 Cookie，成功后把 Cookie 数组与账号信息交给 Magpie 保存。

桌面端账号在客户端重新登录后，由 `auth.refresh` 读取新的 `auth.json` 登录态并更新账号。其他来源的 Cookie 没有刷新接口，过期时由请求链路标记 `signIn: "expired"`。

## 登录态使用

`auth.loader(getAuth)` 从当前账号读取 Cookie，请求百度控制台 `/api/dumate/app/token/get` 换取 gateway token，然后只向官方 `GATEWAY_BASE/chat/completions` 发请求。token 按 Cookie 单飞缓存；401 或 3xx 登录跳转会清缓存并返回 `X-Magpie-Sign-In: expired`。

生图模型在插件内翻译成 DuMate 网关所需的 `prompt` 请求，再包装为 OpenAI chat/image 响应。

## 额度与签到

`auth.usage` 读取积分总览、已用积分、套餐到期时间和签到天数。`auth.checkin` 先读当天签到状态，未签到则 POST 签到接口，再复查积分差额；结果使用 Magpie 的 `done` / `claimed` / `inactive` / `failed` 语义。
