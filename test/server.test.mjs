import test from "node:test"
import assert from "node:assert/strict"
import { createProxyServer } from "../src/server.mjs"

const config = {
  apiKey: undefined,
  maxBodyBytes: 1024 * 1024,
  imageTimeoutMs: 5000,
  imageFetchTimeoutMs: 1000,
  maxImageBytes: 1024 * 1024,
  userAgent: "test",
  logLevel: "silent",
}

const catalog = {
  source: "test",
  models: {
    "model-text": { id: "model-text", upstreamId: "model-text", kind: "chat", name: "chat", owned_by: "dumate", created: 0, context: 1, maxOutput: 1, modalities: { input: ["text"], output: ["text"] }, tool_call: true, reasoning: false },
    "dumate-image0.1": { id: "dumate-image0.1", upstreamId: "dumate-image0.1", kind: "image", name: "image", owned_by: "dumate", created: 0, context: 1, maxOutput: 1, modalities: { input: ["text"], output: ["image"] }, tool_call: false, reasoning: false },
  },
  chatModels: ["model-text"],
  imageModels: ["dumate-image0.1"],
  defaultChatModel: "model-text",
  defaultImageModel: "dumate-image0.1",
}

let keepaliveCalls = 0
const auth = {
  async cookieHeader() { return "a=1" },
  async refreshGatewayToken() { keepaliveCalls++; return "tok" },
  invalidate() {},
}

async function withServer(handler, run) {
  const calls = []
  const gateway = {
    async chat(body) {
      calls.push(body)
      return new Response(JSON.stringify({ id: "upstream-1", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
    async chatJson(body) {
      calls.push(body)
      return { data: [{ url: "https://cdn.example.com/a.png" }] }
    },
  }
  const server = createProxyServer({ config, auth, gateway, catalog })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  try {
    await run(`http://127.0.0.1:${port}`, calls)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  return calls
}

test("GET /v1/models lists chat and image models", async () => {
  await withServer(null, async (base) => {
    const response = await fetch(`${base}/v1/models`)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.data.length, 2)
    const image = body.data.find((model) => model.id === "dumate-image0.1")
    assert.deepEqual(image.modalities.output, ["image"])
    assert.equal(image.apiId, "dumate-image0.1")
    const chat = body.data.find((model) => model.id === "model-text")
    assert.deepEqual(chat.modalities.output, ["text"])
  })
})

test("chat completions pass LLM requests through", async () => {
  const calls = await withServer(null, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model-text", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).id, "upstream-1")
  })
  assert.equal(calls[0].model, "model-text")
})

test("image generations translate to gateway prompt calls", async () => {
  const calls = await withServer(null, async (base) => {
    const response = await fetch(`${base}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat", size: "1024x1024" }),
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.data[0].url, "https://cdn.example.com/a.png")
  })
  assert.equal(calls[0].model, "dumate-image0.1")
  assert.equal(calls[0].prompt, "a cat")
  assert.equal(calls[0].width, 1024)
})

test("chat endpoint with image model returns markdown image content", async () => {
  await withServer(null, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "dumate-image0.1", messages: [{ role: "user", content: "画一只猫" }] }),
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.match(body.choices[0].message.content, /a\.png/)
  })
})

test("POST /v1/keepalive refreshes the gateway token", async () => {
  keepaliveCalls = 0
  await withServer(null, async (base) => {
    const response = await fetch(base + "/v1/keepalive", { method: "POST" })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.login, "ok")
    assert.equal(keepaliveCalls, 1)
  })
})
