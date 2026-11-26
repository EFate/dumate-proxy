# Magpie 如何识别 provider plugin 的 LLM 与生图模型

- 日期：2026-11-26
- 目标：确认 `dumate-proxy` 暴露的模型既要让 `model-text` / `deepseek-v41-flash` 走普通 LLM/chat，又要让 `dumate-image0.1` 被 Magpie 识别为生图模型。
- 证据基准：本机参考插件 + 本机已装 OpenCode SDK/type definitions + Magpie 官方仓库当前 `main` 快照 `d20f306fc3c501b6d8a61f708b2cfa02bb058092`。本机未发现 `magpie` CLI/独立安装；发现的是 `C:\Users\EFate\AppData\Local\Programs\ai.opencode.desktop\OpenCode.exe` 与 `@opencode-ai/sdk/plugin` 1.19.5（`C:\Users\EFate\.config\opencode\node_modules\@opencode-ai\sdk\dist\gen\types.gen.d.ts:884-924`）。

## 结论先行

1. **生图模型不需要一个新的 `type: image` 字段，也不需要 `capabilities.output.image` 作为 plugin schema 字段。** 对 OpenAI-compatible plugin，Magpie 判断生图 drawer 的关键公式是：

   ```go
   (catalog.DrawsID(m.ID) && catalog.ImagesAPI(m.ID) || imagesOnly(m.OutputModalities)) && p.PluginOpenAICompatible(m.ID)
   ```

   来源：`internal/gateway/draw.go:400-420`，镜像链接：<https://github.com/yetone/magpie/blob/d20f306fc3c501b6d8a61f708b2cfa02bb058092/internal/gateway/draw.go#L400-L420>。其中 `imagesOnly(out)` 定义为 output 含 `"image"` 且不含 `"text"`（`internal/gateway/draw.go:1278-1281`）。

   因此最稳的声明是：**生图模型的 `modalities.output` 只写 `["image"]`，不要写 `"text"`；LLM 的 `modalities.output` 写 `["text"]`。**

2. `dumate-image0.1` 仅靠名字不够稳。`catalog.DrawsID()` 的关键词包含裸 `image`，所以它会命中 DrawsID；但 `catalog.ImagesAPI()` 的关键词是 `gpt-image`、`chatgpt-image`、`dall-e`、`imagen`、`imagine`、`qwen-image`、`wanx`、`seedream`、`cogview`、`flux`、`stable-diffusion`、`sdxl`、`kolors`、`hidream`、`sensenova-u1`、`hy-image`、`h3-image`，**不包含裸 `image`**。来源：`internal/catalog/catalog.go:2502-2535`，<https://github.com/yetone/magpie/blob/d20f306fc3c501b6d8a61f708b2cfa02bb058092/internal/catalog/catalog.go#L2502-L2535>。所以 `dumate-image0.1` 不会走 `ImagesAPI` 的名称分支；要靠 `modalities.output: ["image"]` 的 `imagesOnly` 分支被识别。

3. **Magpie 确实会让 plugin 的 `loader.fetch` 处理生图端点。** 官方描述明确写道：`drawImages` 把请求发到 `/v1/images/generations` 或 `/v1/images/edits`，"through its `fetch`, which signs it as a chat"。来源：`docs/subsystems/provider-plugins.md:129`，<https://github.com/yetone/magpie/blob/d20f306fc3c501b6d8a61f708b2cfa02bb058092/docs/subsystems/provider-plugins.md#L129>

4. 参考插件把 `loader.fetch` 限制为 `GATEWAY_BASE + "/chat/completions"` 是**插件自己的防 token 泄漏措施**，不是 Magpie 要求。证据：参考插件注释 `"Only the official chat endpoint may receive the gateway token"`，并在 URL 不匹配时返回 400（`D:\BrowserDownloads\MyGIT\dumate-plugin\.ref\magpie-dumate\index.mjs:451-467`）。Magpie 官方则要求图像/编辑/视频/嵌入等请求也经 plugin fetch：`docs/subsystems/provider-plugins.md:129,137,139`，`internal/provider/plugins.go:748-838`。

5. 对本地 reverse proxy 包装插件，`loader.fetch` 应至少允许：`/chat/completions`、`/images/generations`、`/images/edits`；若 loader baseURL 带 `/v1`，Magpie 会把内部 `/v1/...` 去掉再拼到 base（`internal/provider/plugins.go:765,802-820`），也就是最终打到 proxy 的 `.../v1/chat/completions`、`.../v1/images/generations`、`.../v1/images/edits`。

## 1. `config.provider.<id>.models` 的形状

OpenCode/Magpie 的 provider config 是 **map**，key 是暴露给客户端的 model id，value 是模型元数据对象。本机 SDK type definitions 给出的字段为：`id?`, `name?`, `release_date?`, `attachment?`, `reasoning?`, `temperature?`, `tool_call?`, `cost?`, `limit?: {context, output}`, `modalities?: {input, output}`, `options?`, `headers?`, `provider?: {npm}` 等；allowed modalities 是 `text | audio | image | video | pdf`（`C:\Users\EFate\.config\opencode\node_modules\@opencode-ai\sdk\dist\gen\types.gen.d.ts:880-924`）。

Magpie host 解析 config 时，将 map key 作为 `out.models[key].id`，把 `value.id` 放进 `api.id`（API/upstream id）：

```js
for (const [key, m] of Object.entries(cfg?.models ?? {})) {
  const was = out.models[m.id ?? key]
  ...
  out.models[key] = {
    ...
    id: key,
    api: { id: m.id ?? was?.api.id ?? key, ... },
    limit: { ...(was?.limit ?? { context: 0, output: 0 }), ...(m.limit ?? {}) },
    capabilities: {
      ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
      ...(m.attachment !== undefined ? { attachment: m.attachment } : {}),
      ...(m.tool_call !== undefined ? { toolcall: m.tool_call } : {}),
      ...(m.modalities?.input ? { input: modalities(m.modalities.input) } : {}),
      ...(m.modalities?.output ? { output: modalities(m.modalities.output) } : {}),
    },
  }
}
```

来源：`internal/plugin/host.js:2272-2293`，<https://github.com/yetone/magpie/blob/d20f306fc3c501b6d8a61f708b2cfa02bb058092/internal/plugin/host.js#L2272-L2293>。

本机参考插件正是这样写：`config.provider[PROVIDER_ID] = { name, npm: "@ai-sdk/openai-compatible", api: GATEWAY_BASE, ...was, models: {...fallback, ...loadModels(...), ...(was.models ?? {})} }`，provider hook 再返回 `provider.models`（`D:\BrowserDownloads\MyGIT\dumate-plugin\.ref\magpie-dumate\index.mjs:355-391`）。导入器把 source catalog 映射成 `{ id, name, limit:{context,output}, tool_call, reasoning, variants?, attachment, modalities:{input,output} }`，并对 `limit.context ?? limit.input`、`limit.output` 做正整数校验（`D:\BrowserDownloads\MyGIT\dumate-plugin\.ref\magpie-dumate\models.mjs:53-68`）。

结论：一个最小可用模型条目：

```json
"model-text": {
  "id": "model-text",
  "name": "model-text",
  "limit": { "context": 1000000, "output": 384000 },
  "tool_call": true,
  "reasoning": false,
  "attachment": true,
  "modalities": { "input": ["text", "image"], "output": ["text"] }
}
```

```json
"dumate-image0.1": {
  "id": "dumate-image0.1",
  "name": "DuMate Image",
  "limit": { "context": 200000, "output": 32000 },
  "tool_call": false,
  "reasoning": false,
  "attachment": false,
  "modalities": { "input": ["text"], "output": ["image"] }
}
```

## 2. chat vs image 到底由谁决定

### 2.1 OpenAI-compatible plugin 的正式路径

Magpie 官方插件文档明确区分两类：

- OpenAI-compatible plugin：按 id 中的 images-API 名称，或 plugin 说 output 只有图片，进入 images drawer；`drawImages` 请求 `/v1/images/generations` 或 `/v1/images/edits`，经 plugin `fetch`（`docs/subsystems/provider-plugins.md:129`）。
- Gemini/`@ai-sdk/google` plugin：可用 `capabilities.output.image` 或 models.dev `modalities.output` 判定，并走 `generateContent`；这不是 OpenAI-compatible proxy 的路径（`docs/subsystems/provider-plugins.md:131`）。

代码层面对应 `DrawersOf()`：

```go
if (catalog.DrawsID(m.ID) && catalog.ImagesAPI(m.ID) || imagesOnly(m.OutputModalities)) && p.PluginOpenAICompatible(m.ID) ||
   pluginDrawsGemini(p, m.ID) && (catalog.DrawsID(m.ID) || slices.Contains(m.OutputModalities, "image")) {
```

来源：`internal/gateway/draw.go:400-420`。

请求路径选择函数也用同一事实：plugin 且 `imagesOnly(m.OutputModalities)` 时 `viaImages`，否则默认 `viaChat`（`internal/gateway/draw.go:1260-1275,1278-1287`）。 Magpie 在 404/405 或上游 400 明说 "Use /v1/images/generations" 时会回退到另一条路径（`internal/gateway/draw.go:1512-1524,1528-1541`；`internal/catalog/catalog.go:2564-2570`）。

### 2.2 字段解释

| 字段 | 作用 | 推荐 |
|---|---|---|
| `modalities.output` | host 转成 `capabilities.output`；`["image"]` 且无 `"text"` 触发 `imagesOnly`，是 OpenAI-compatible plugin 最稳的生图信号 | 生图：`["image"]`；LLM：`["text"]` |
| `modalities.input` | host 转成 `capabilities.input`；影响输入模态展示，参考插件用 `attachment: input.some(x => x !== "text")` | 文生图：`["text"]`；图片编辑：`["text","image"]` |
| `attachment` | 表示模型接受附件/非文本输入；不是生图 output 标记 | 纯文生图 `false`；编辑模型 `true` |
| `tool_call` | LLM 工具能力；生图模型默认关掉 | 生图 `false`；支持的 LLM `true` |
| `reasoning` | 推理档位/展示 | 生图 `false`；`deepseek-v41-flash` 可按参考插件设 `true` 并给 `variants` |
| `limit.context` / `limit.input` / `limit.output` | 窗口与输出上限；参考插件用 `context ?? input`，Magpie host merge `limit` | 填正整数；`dumate-image0.1` 沿用现有 200000/32000 或真实值 |
| `type` / `capabilities.output.image` / `kind` | 不是本任务所需 OpenAI-compatible plugin 声明字段 | 不依赖；`plugin.Model` 结构没有 `Kind` 字段（`internal/plugin/providers.go:71-146`） |

用户可在 Magpie 设置里把某个模型标成 image model，代码读取 `settings.ModelKinds["<provider>/<model>"]`，但这是用户设置，不是 plugin catalog 的可靠声明（`internal/provider/modelkind.go:13-52`）。

## 3. `/v1/images/generations` 与 SDK image method 调用链

Magpie 的 gateway 对外提供图片生成/编辑路由；对 plugin provider，它不直接把请求发给 plugin 声明的 `api` host，而是经 plugin host 的 `fetch`。官方实现说明：`drawImages` 以 `<base>/images/generations`（无输入图片）或 `<base>/images/edits`（有输入图片）发送 OpenAI-style body，包括 `model`、`prompt`、`n`、`size`、`quality`、`background`、`output_format`，部分模型还会带 `response_format`（`internal/gateway/draw.go:1725-1797`）。

`pluginFetch` 的关键行为：

```go
rest := strings.TrimPrefix(req.URL.String(), pluginBase+pp.ID)
...
api := modelAPIID(m)
if api != model && !codeAssist { body = withModel(body, api) }
base := pluginRequestBase(pp, m, o.BaseURL)
case strings.HasPrefix(rest, "/v1/"):
    url = base + strings.TrimPrefix(rest, "/v1")
...
plugin.Fetch(... URL: url, Method: req.Method, Headers: h, Body: body ...)
```

来源：`internal/provider/plugins.go:748-838`。也就是说：

- plugin 声明 `loader.baseURL` 是路径拼接基准；
- Magpie 会把内部 `/v1/...` 去掉后拼到 base；loader 带 `/v1` 则最终仍是 `/v1/...`，loader 不带 `/v1` 则最终是根路径 `/...`；
- 请求 body 的 `model` 会被替换为 API id；
- `loader.fetch` 收到的是最终 URL，可自行加认证头。

参考插件的 `api = GATEWAY_BASE`、`loader.baseURL = GATEWAY_BASE`，且只允许 `gateway.pathname + "/chat/completions"`（`D:\BrowserDownloads\MyGIT\dumate-plugin\.ref\magpie-dumate\index.mjs:355-363,448-467`）。这个限制是插件为保护 DuMate gateway token 写的；Magpie 本身不会限制 plugin fetch 只有 chat：embedding/rerank/speech/transcription 也会走 `<base>/embeddings`、`/rerank`、`/audio/speech`、`/audio/transcriptions`（`docs/subsystems/provider-plugins.md:137`），视频走 `/videos`、`/videos/{id}`、`/videos/{id}/content`（`docs/subsystems/provider-plugins.md:139`）。

## 4. alias 与 `id` / key

- config map 的 key 是客户端/Magpie 可见 id；`value.id` 是 API id。host 明确设置 `out.models[key].id = key` 与 `api.id = m.id ?? ... ?? key`（`internal/plugin/host.js:2272-2280`）。
- pluginFetch 发请求时把 body 的 `model` 改成 `modelAPIID(m)`，而 `modelAPIID` 返回 `m.APIID`（由 host 的 `apiId`）否则返回 `m.ID`（`internal/provider/plugins.go:790-793,987-992`；`internal/plugin/providers.go:77`）。
- 因此 `glm-5` -> `model-text` 可以暴露为独立可见模型：map key `glm-5`，`id: "model-text"`。参考插件把这种 alias 去重掉是它自己的目录政策，用来避免重复显示（`D:\BrowserDownloads\MyGIT\dumate-plugin\.ref\magpie-dumate\models.mjs:48-52`；`D:\BrowserDownloads\MyGIT\dumate-plugin\.ref\dumate-rance\models.mjs:30-33`），不是 Magpie 限制。
- 当前代理的 `src/catalog.mjs:47-50` 写成 `id: key, upstreamId: id`；`GET /v1/models` 只输出 `id: model.id`，未暴露 `upstreamId`（`D:\BrowserDownloads\MyGIT\dumate-plugin\src\server.mjs:141-161`）。若客户端/插件需要 alias 映射，应在 `/v1/models` 输出可识别的 API id（例如 `apiId` 或继续让 `id` 保持可见 id、另给 `upstreamId`），并在 wrapper plugin 的 config 模型里用 `id`/`apiId` 表达。

### 参考插件使用的 alias 约定

参考插件显示名会让别名和 API id 都能被看懂：

```js
name: key === id ? key : `${key} (API: ${id})`
```

来源：`D:\BrowserDownloads\MyGIT\dumate-plugin\.ref\magpie-dumate\models.mjs:58-67`。

## 5. Action items for dumate-proxy

1. **保持 `/v1/models`（以及无 `/v1` 别名）输出 Magpie 可消费的字段。** 当前 `src/server.mjs:141-161` 已有 `limit`、`tool_call`、`reasoning`、`attachment`、`modalities`、`kind`。补齐/确认：
   - `modalities.output` 必须是数组；`dumate-image0.1` 为 `["image"]`，`model-text`/`deepseek-v41-flash` 为 `["text"]`；
   - `limit.context` / `limit.output` 用数字，不再只依赖顶层 `context`/`max_output`；
   - `attachment` 对纯文生图设 `false`，对支持 edit 的模型设 `true`；
   - 生图 `tool_call:false`、`reasoning:false`；LLM 按真实能力设置。
   依据：`internal/plugin/host.js:2272-2293`、`internal/gateway/draw.go:400-420,1278-1287`。

2. **不要依赖 `kind` 或 `capabilities.output.image` 作为唯一识别信号。** 当前 `src/catalog.mjs:46` 用 `IMAGE_HINT` + `output.includes("image")` 生成 `kind`，这对自家 proxy 路由有用，但 Magpie plugin 结构不消费 `kind`；真正稳定的是 `modalities.output: ["image"]` 且无 `"text"`。依据：`internal/plugin/providers.go:71-146`、`internal/gateway/draw.go:416`。

3. **确认 `dumate-image0.1` 的 `modalities.output` 在真实账号 catalog 中也被规范化。** 当前 `src/catalog.mjs:38-46` 对缺失 modalities 会回落到 `["text"]`，并把 `kind` 设为 image，但 Magpie 看不到 `kind`。如果账号 `opencode.json` 没写 `modalities.output: ["image"]`，应在导入器里对 `dumate-image0.1` 显式补写 `modalities.output = ["image"]`。依据：`src/catalog.mjs:14-19,38-46`、`internal/gateway/draw.go:416,1278-1281`。

4. **让 proxy 同时接受带 `/v1` 和不带 `/v1` 的三类路径。** 当前 `src/server.mjs:141-184` 已支持 `/v1/models` 与 `/models`、`/v1/chat/completions` 与 `/chat/completions`、`/v1/images/generations` 与 `/images/generations`、`/v1/images/edits` 与 `/images/edits`。这是正确方向，因为 pluginFetch 是否保留 `/v1` 取决于 loader baseURL（`internal/provider/plugins.go:802-820`）。

5. **若新增 Magpie plugin wrapper：**
   - `config` hook 设置 `provider.<id>.npm = "@ai-sdk/openai-compatible"`、`api`/`loader.baseURL` 指向 proxy（建议带 `/v1`），并写入上述 models map；
   - `provider.models` hook 返回同一份模型 map；
   - `auth.loader` 的 `fetch` 放行 `/chat/completions`、`/images/generations`、`/images/edits`，只给 proxy 加 `Authorization: Bearer <PROXY_KEY>`，不要把 DuMate gateway token 发给任意 URL；
   - 参考插件只放行 chat 是为了保护 gateway token（`D:\BrowserDownloads\MyGIT\dumate-plugin\.ref\magpie-dumate\index.mjs:451-467`），proxy 场景下应替换为 proxy key 的最小权限放行。
   依据：`D:\BrowserDownloads\MyGIT\dumate-plugin\.ref\magpie-dumate\index.mjs:355-391,419-495`、`docs/subsystems/provider-plugins.md:129,133`、`internal/provider/plugins.go:748-838`。

6. **测试建议（不改动本任务源文件）：** 增加一个断言：`GET /v1/models` 中 `dumate-image0.1.modalities.output === ["image"]` 且不含 `"text"`；`model-text` 和 `deepseek-v41-flash` 的 output 含 `"text"` 且不含 `"image"`；用 wrapper 视角模拟 `DrawersOf`/`imagesOnly` 条件。当前已有 `test/catalog.test.mjs` 和 `test/server.test.mjs`，可作为落点（`D:\BrowserDownloads\MyGIT\dumate-plugin\test\catalog.test.mjs:1-60`、`D:\BrowserDownloads\MyGIT\dumate-plugin\test\server.test.mjs:1-120`）。

## 6. 证据边界

- 本机没有找到 `magpie` CLI 或独立 Magpie 安装；只找到 OpenCode Desktop 2.4.1 与 OpenCode SDK 1.19.5。因此“真实 Magpie UI 的图片下拉框实测”尚未做；以上结论来自官方源码/文档与 OpenCode plugin SDK 类型。
- 官方文档和代码快照固定为 commit `d20f306fc3c501b6d8a61f708b2cfa02bb058092`；若 Magpie 升级，需重新核对 `DrawersOf`、`imagesOnly`、`pluginFetch`。



## 7. 登录后保活（已实现）

Magpie 的保活契约来自 `internal/plugin/host.js:3065-3080` 与 `internal/provider/plugin_keepalive.go`：

- plugin 声明 `auth.refresh(auth, provider)` 即表示由 Magpie 负责续期；
- `auth.refreshLead` 指定提前多久续期（默认 5 分钟）；
- 只要 `auth.keepAlive !== false`，Magpie 网关会为长时间无请求的账号在后台按时续期；
- `renewAt` 只对 `type: "oauth"` 且有正 `expires` 的 sign-in 生效；
- `refreshLead` 与 `expires` 都是毫秒时间戳。

dumate-proxy 的实现：

- `POST /v1/keepalive` 调用 `DuMateAuth.refreshGatewayToken()`，强制重新换取 gateway token，不返回 token 本身。
- 插件 sign-in 返回 `type:"oauth"`、`refresh:"dumate-proxy-keepalive"`、`expires: now + 55min`、`refreshLead: 10min`、`keepAlive:true`。
- `auth.refresh` 调 `/v1/keepalive`；代理临时不可达抛普通错误让 Magpie 退避，代理明确报告登录态缺失时抛带 `signIn:"expired"` 的错误让账号重新登录。

来源：Magpie commit `d20f306fc3c501b6d8a61f708b2cfa02bb058092`。
