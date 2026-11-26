import { createServer } from "node:http"
import { Readable } from "node:stream"
import {
  buildImageUpstreamBody,
  chatMessagesToPrompt,
  isImageModel,
  resolveImageModel,
  toChatCompletion,
  toChatSSE,
  toOpenAIImages,
} from "./image.mjs"

function sendJson(reply, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value)
  reply.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  })
  reply.end(body)
}

function sendText(reply, status, text, contentType = "text/plain; charset=utf-8") {
  reply.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(text) })
  reply.end(text)
}

function errorPayload(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500
  return {
    error: {
      message: String(error?.message ?? error ?? "internal error"),
      type: error?.type || (status === 400 ? "invalid_request_error" : "api_error"),
      ...(error?.code ? { code: error.code } : {}),
    },
  }
}

async function readBody(request, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > maxBytes) {
      const error = new Error(`请求体超过 ${maxBytes} 字节限制`)
      error.status = 413
      error.type = "invalid_request_error"
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(request, maxBytes) {
  const buffer = await readBody(request, maxBytes)
  if (!buffer.length) return {}
  try {
    return JSON.parse(buffer.toString("utf8"))
  } catch {
    const error = new Error("请求体不是合法 JSON")
    error.status = 400
    error.type = "invalid_request_error"
    throw error
  }
}

async function readForm(request, maxBytes) {
  const buffer = await readBody(request, maxBytes)
  const contentType = request.headers["content-type"] || "application/x-www-form-urlencoded"
  const synthetic = new Request("http://localhost/form", { method: "POST", headers: { "content-type": contentType }, body: buffer })
  return synthetic.formData()
}

async function fileToDataUrl(value) {
  if (!value || typeof value !== "object" || typeof value.arrayBuffer !== "function") {
    return typeof value === "string" ? value : undefined
  }
  const mime = value.type || "application/octet-stream"
  const buffer = Buffer.from(await value.arrayBuffer())
  return `data:${mime};base64,${buffer.toString("base64")}`
}

function pipeUpstream(upstream, reply) {
  const status = upstream.status || 200
  const headers = {}
  const contentType = upstream.headers.get("content-type")
  if (contentType) headers["Content-Type"] = contentType
  const requestId = upstream.headers.get("x-request-id")
  if (requestId) headers["X-Request-Id"] = requestId
  reply.writeHead(status, headers)
  if (!upstream.body) {
    reply.end()
    return
  }
  const stream = Readable.fromWeb(upstream.body)
  stream.on("error", () => reply.destroy())
  stream.pipe(reply)
}

export function createProxyServer({ config, auth, gateway, catalog, fetchImpl = fetch }) {
  return createServer((request, reply) => {
    handleRequest(request, reply, { config, auth, gateway, catalog, fetchImpl }).catch((error) => {
      if (reply.headersSent) {
        reply.destroy()
        return
      }
      const payload = errorPayload(error)
      if (config.logLevel !== "silent") console.error(`[dumate-proxy] ${request.method} ${request.url} -> ${payload.error.type}`)
      sendJson(reply, payload.error.type === "api_error" && error?.status ? error.status : (error.status || 500), payload)
    })
  })
}

async function handleRequest(request, reply, deps) {
  const { config, auth, gateway, catalog, fetchImpl } = deps
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`)
  const path = url.pathname.replace(/\/+$/, "") || "/"

  if (config.apiKey && request.headers.authorization !== `Bearer ${config.apiKey}`) {
    sendJson(reply, 401, { error: { message: "invalid proxy api key", type: "authentication_error" } })
    return
  }

  if (path === "/healthz" || path === "/health") {
    let login = "ok"
    try { await auth.cookieHeader() } catch { login = "missing" }
    sendJson(reply, 200, {
      status: "ok",
      login,
      catalogSource: catalog.source,
      chatModels: catalog.chatModels.length,
      imageModels: catalog.imageModels.length,
      defaultChatModel: catalog.defaultChatModel,
      defaultImageModel: catalog.defaultImageModel,
    })
    return
  }

  if (path === "/v1/keepalive" || path === "/keepalive") {
    if (request.method !== "GET" && request.method !== "POST") {
      sendJson(reply, 405, { error: { message: "method not allowed", type: "invalid_request_error" } })
      return
    }
    try {
      await auth.refreshGatewayToken()
      sendJson(reply, 200, { status: "ok", login: "ok" })
    } catch (error) {
      const payload = errorPayload(error)
      sendJson(reply, payload.error.type === "authentication_error" ? 401 : 502, payload)
    }
    return
  }

  if (request.method === "GET" && (path === "/v1/models" || path === "/models")) {
    sendJson(reply, 200, {
      object: "list",
      data: Object.values(catalog.models).map((model) => ({
        id: model.id,
        apiId: model.upstreamId,
        upstreamId: model.upstreamId,
        object: "model",
        created: model.created,
        owned_by: model.owned_by,
        name: model.name,
        limit: { context: model.context, output: model.maxOutput },
        tool_call: model.tool_call,
        reasoning: model.reasoning,
        attachment: model.attachment,
        modalities: model.modalities,
        metadata: {
          kind: model.kind,
          context: model.context,
          max_output: model.maxOutput,
          modalities: model.modalities,
          tool_call: model.tool_call,
          reasoning: model.reasoning,
        },
      })),
    })
    return
  }

  if (request.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
    await handleChat(request, reply, deps)
    return
  }

  if (request.method === "POST" && (path === "/v1/images/generations" || path === "/images/generations")) {
    await handleImageGenerations(request, reply, deps)
    return
  }

  if (request.method === "POST" && (path === "/v1/images/edits" || path === "/images/edits")) {
    await handleImageEdits(request, reply, deps)
    return
  }

  sendJson(reply, 404, { error: { message: `unknown endpoint ${path}`, type: "invalid_request_error" } })
}

async function handleChat(request, reply, deps) {
  const { config, gateway, catalog } = deps
  const body = await readJson(request, config.maxBodyBytes)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(reply, 400, { error: { message: "body must be a JSON object", type: "invalid_request_error" } })
    return
  }

  const requestedId = body.model || catalog.defaultChatModel
  const model = requestedId && catalog.models[requestedId] ? catalog.models[requestedId] : undefined

  if (model?.kind === "image" || (!model && isImageModel(catalog, requestedId))) {
    const imageModel = resolveImageModel(catalog, config, requestedId)
    const upstreamBody = buildImageUpstreamBody(
      { ...body, prompt: body.prompt ?? chatMessagesToPrompt(body.messages) },
      imageModel,
    )
    const payload = await gateway.chatJson(upstreamBody, { signal: AbortSignal.timeout(config.imageTimeoutMs) })
    const completion = toChatCompletion(payload, imageModel.id, { ...body, model: requestedId || imageModel.id })
    if (body.stream) {
      sendText(reply, 200, toChatSSE(completion, requestedId || imageModel.id), "text/event-stream; charset=utf-8")
    } else {
      sendJson(reply, 200, completion)
    }
    return
  }

  const resolvedId = requestedId || catalog.defaultChatModel
  const upstreamBody = { ...body, model: model?.upstreamId || resolvedId }
  const upstream = await gateway.chat(upstreamBody)
  if (body.stream) {
    pipeUpstream(upstream, reply)
    return
  }
  const text = await upstream.text()
  const contentType = upstream.headers.get("content-type") || "application/json"
  if (/json/i.test(contentType)) {
    try {
      sendJson(reply, upstream.status || 200, JSON.parse(text))
      return
    } catch { /* fall through to raw text */ }
  }
  sendText(reply, upstream.status || 200, text, contentType)
}

async function handleImageGenerations(request, reply, deps) {
  const { config, catalog, gateway, fetchImpl } = deps
  const body = await readJson(request, config.maxBodyBytes)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(reply, 400, { error: { message: "body must be a JSON object", type: "invalid_request_error" } })
    return
  }
  const model = resolveImageModel(catalog, config, body.model)
  const upstreamBody = buildImageUpstreamBody(body, model)
  const payload = await gateway.chatJson(upstreamBody, { signal: AbortSignal.timeout(config.imageTimeoutMs) })
  const result = await toOpenAIImages(
    payload,
    { model: body.model || model.id, responseFormat: body.response_format || "url" },
    config,
    fetchImpl,
  )
  sendJson(reply, result.status, result.body)
}

async function handleImageEdits(request, reply, deps) {
  const { config, catalog, gateway, fetchImpl } = deps
  const form = await readForm(request, config.maxBodyBytes)
  const prompt = String(form.get("prompt") ?? "").trim()
  if (!prompt) {
    sendJson(reply, 400, { error: { message: "缺少 prompt", type: "invalid_request_error" } })
    return
  }

  const images = []
  for (const key of ["image", "image[]", "images", "image_url"]) {
    for (const value of form.getAll(key)) {
      const dataUrl = await fileToDataUrl(value)
      if (dataUrl) images.push(dataUrl)
    }
  }

  const model = resolveImageModel(catalog, config, form.get("model") || undefined)
  const upstreamBody = buildImageUpstreamBody({
    prompt,
    n: form.get("n") || 1,
    size: form.get("size") || undefined,
    response_format: form.get("response_format") || "url",
    ...(images.length === 1 ? { image: images[0] } : {}),
    ...(images.length > 1 ? { images } : {}),
  }, model)

  const payload = await gateway.chatJson(upstreamBody, { signal: AbortSignal.timeout(config.imageTimeoutMs) })
  const result = await toOpenAIImages(
    payload,
    { model: form.get("model") || model.id, responseFormat: form.get("response_format") || "url" },
    config,
    fetchImpl,
  )
  sendJson(reply, result.status, result.body)
}

export { sendJson, errorPayload }
