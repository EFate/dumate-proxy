# Magpie 模型识别、登录与保活

本项目作为 OpenAI-compatible provider plugin 接入 Magpie。插件直连 DuMate 官方网关，不需要本地反代地址。

## 模型声明

`config.provider.dumate.models` 是 Magpie 可见模型 map：

- LLM：`modalities.output` 为 `["text"]`
- 生图：`modalities.output` 为 `["image"]`，且不含 `"text"`
- 生图模型固定 `tool_call:false`、`reasoning:false`

插件枚举全部可用模型，不做单一聚合：

- 对话：`model-text`、`deepseek-v41-flash`、`glm-53-flash`、`kimi-k3`、`qwen3.8-max` 等
- 生图：`dumate-image2.2`、`dumate-image2.1`、`dumate-image1.2`、`dumate-image0.1`
- 兼容别名：`group/image`

模型元数据优先来自当前 DuMate 账号配置；缺失时使用内置完整清单。

## 生图模型选择

生图调用按版本号选择最强模型：插件合并 DuMate 当前模型清单与内置版本表，取最高的 `dumate-image*`。当前基线是 `dumate-image2.2`；后台上线更高版本后自动切换，未知新版本复用 v3 工具端点。

生图请求走 DuMate 原生工具端点：

```text
POST /gateway/v2/tools/dumate/image_generate_v3/async
GET  /gateway/v2/tools/dumate/image_generate_v3/async?task_id=<id>
```

参考图不直接上传超长 data URL，而是先由视觉模型转成结构化提示词，再调用最强生图模型。

## 登录方式

插件提供三种 Magpie 登录入口：

1. 桌面端只读复用 `auth.json` 与 `.cookie-key`
2. 浏览器登录后粘贴 DevTools Network 请求头 Cookie
3. 手动粘贴包含 `bce-sessionid` 的完整 Cookie 请求头

浏览器和手动方式先请求 `/api/dumate/user/info` 验证 Cookie。只有 302 登录跳转、HTML 登录页或明确凭证失效才标记 `signIn: "expired"`。

多账号使用显示名作为账号标识，上游 ID 存入 `uid`，不会互相顶掉。

## 登录态使用

`auth.loader(getAuth)` 从当前账号读取 Cookie，请求 `/api/dumate/app/token/get` 换取 gateway token，再请求官方 DuMate 网关。token 按 Cookie 单飞缓存；401 或登录跳转会清缓存并返回 `X-Magpie-Sign-In: expired`。

## 额度与签到

`auth.usage` 读取积分总览、已用积分、套餐到期时间和签到天数。`auth.checkin` 读取当天签到状态，未签到则提交签到请求并复查积分差额，结果使用 Magpie 的 `done` / `claimed` / `inactive` / `failed` 语义。
