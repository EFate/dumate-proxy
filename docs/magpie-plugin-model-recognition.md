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

## 登录方式

插件向 Magpie 注册四种登录入口：

1. 反代已配置登录态：检查 `/healthz`。
2. 服务器本机桌面端登录态：反代只读读取 `auth.json` 与 `.cookie-key`。
3. 浏览器登录：打开百度登录页，复制 DevTools Network 请求头 Cookie，交给 `POST /v1/auth/login` 校验并保存。
4. 手动粘贴 Cookie：表单输入完整 Cookie 请求头，校验 `bce-sessionid` 后交给 `POST /v1/auth/login`。

登录成功后，Cookie 只保存在反代状态目录的 `runtime-cookie.json`，Magpie 账号记录只保留来源、账号名和 Cookie 尾号。反代重启后会优先读取这份运行时登录态。
## 登录保活

插件声明：

- `auth.refresh`
- `auth.refreshLead = 10min`
- `auth.keepAlive = true`
- `auth.single = true`，重复登录复用同一个账号槽位

登录入口会先请求 `/healthz`：只有反代报告 DuMate 登录态可用时才会保存账号，否则返回明确的失败提示。sign-in 结果包含 55 分钟有效期。Magpie 会在到期前触发续期，并在账号空闲时后台保活。续期逻辑调用反代的 `POST /v1/keepalive`，该接口强制刷新 DuMate gateway token，但不返回 token 内容。

错误语义：

- 反代临时不可达：抛出普通错误，交给 Magpie 退避重试
- 反代明确报告 DuMate 登录态缺失：抛出 `signIn: "expired"`，让账号进入重新登录流程
