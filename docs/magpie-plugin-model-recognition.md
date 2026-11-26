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

## 登录保活

插件声明：

- `auth.refresh`
- `auth.refreshLead = 10min`
- `auth.keepAlive = true`

sign-in 结果包含 55 分钟有效期。Magpie 会在到期前触发续期，并在账号空闲时后台保活。续期逻辑调用反代的 `POST /v1/keepalive`，该接口强制刷新 DuMate gateway token，但不返回 token 内容。

错误语义：

- 反代临时不可达：抛出普通错误，交给 Magpie 退避重试
- 反代明确报告 DuMate 登录态缺失：抛出 `signIn: "expired"`，让账号进入重新登录流程
