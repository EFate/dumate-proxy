import test from "node:test"
import assert from "node:assert/strict"
import { importCatalog } from "../src/catalog.mjs"
import { DuMateProxyPlugin, toMagpieModels } from "../magpie.mjs"

const raw = {
  model: "QianfanPersonalQuota/glm-5",
  provider: {
    QianfanPersonalQuota: {
      models: {
        "model-text": {
          id: "model-text",
          name: "DuMate Auto",
          limit: { context: 1_000_000, output: 384_000 },
          tool_call: true,
          modalities: { input: ["text", "image"], output: ["text"] },
        },
        "glm-5": {
          id: "model-text",
          name: "GLM 5 alias",
          limit: { context: 1_000_000, output: 128_000 },
          tool_call: true,
          modalities: { input: ["text"], output: ["text"] },
        },
        "dumate-image0.1": {
          id: "dumate-image0.1",
          name: "DuMate Image",
          limit: { context: 200_000, output: 32_000 },
          tool_call: false,
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
  },
}

const catalog = importCatalog(raw, { source: "test", env: {} })

test("catalog normalizes image output modalities for Magpie", () => {
  assert.deepEqual(catalog.models["dumate-image0.1"].modalities.output, ["image"])
  assert.equal(catalog.models["dumate-image0.1"].attachment, false)
  assert.equal(catalog.models["dumate-image0.1"].tool_call, false)
  assert.equal(catalog.models["model-text"].modalities.output.includes("image"), false)
  assert.deepEqual(catalog.models["model-text"].modalities.output, ["text"])
})

test("Magpie model map uses visible key and upstream API id", () => {
  const models = toMagpieModels(catalog)
  assert.equal(models["glm-5"].id, "model-text")
  assert.deepEqual(models["dumate-image0.1"].modalities.output, ["image"])
  assert.equal(models["dumate-image0.1"].modalities.output.includes("text"), false)
  assert.deepEqual(models["model-text"].modalities.output, ["text"])
  assert.equal(models["model-text"].tool_call, true)
  assert.deepEqual(models["deepseek-v41-flash"]?.variants, undefined)
})

test("config hook registers chat and image models for Magpie", async () => {
  const plugin = await DuMateProxyPlugin({ config: {}, catalog, proxyUrl: "http://127.0.0.1:8799/v1" })
  const config = {}
  plugin.config(config)
  assert.equal(config.provider.dumate.npm, "@ai-sdk/openai-compatible")
  assert.equal(config.provider.dumate.api, "http://127.0.0.1:8799/v1")
  assert.ok(config.provider.dumate.models["model-text"])
  assert.deepEqual(config.provider.dumate.models["dumate-image0.1"].modalities.output, ["image"])
})

test("loader allows image endpoints and only sends proxy key to proxy origin", async () => {
  const calls = []
  const plugin = await DuMateProxyPlugin({
    config: {},
    catalog,
    proxyUrl: "http://127.0.0.1:8799/v1",
    proxyKey: "proxy-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    },
  })
  const loader = await plugin.loader()
  assert.equal(loader.baseURL, "http://127.0.0.1:8799/v1")

  const ok = await loader.fetch("http://127.0.0.1:8799/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "a cat" }),
  })
  assert.equal(ok.status, 200)
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer proxy-secret")

  const bad = await loader.fetch("https://evil.example/v1/images/generations", { method: "POST" })
  assert.equal(bad.status, 400)
  assert.equal(calls.length, 1)
})

test("auth hook declares Magpie keep-alive and renews through proxy", async () => {
  const calls = []
  const plugin = await DuMateProxyPlugin({
    config: {},
    catalog,
    proxyUrl: "http://127.0.0.1:8799/v1",
    proxyKey: "proxy-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).includes("/healthz")) {
        return new Response(JSON.stringify({ login: "ok" }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ status: "ok", login: "ok" }), { status: 200, headers: { "content-type": "application/json" } })
    },
  })

  assert.equal(plugin.auth.keepAlive, true)
  assert.equal(plugin.auth.refreshLead, 10 * 60 * 1000)
  assert.equal(typeof plugin.auth.refresh, "function")

  const seat = await plugin.auth.refresh({ accountId: "acct", name: "saved" })
  assert.equal(seat.type, "oauth")
  assert.equal(seat.accountId, "acct")
  assert.equal(seat.name, "saved")
  assert.equal(seat.refresh, "dumate-proxy-keepalive")
  assert.ok(seat.expires > Date.now() + 50 * 60 * 1000)
  assert.equal(calls[0].url, "http://127.0.0.1:8799/v1/keepalive")
  assert.equal(calls[0].init.headers.Authorization, "Bearer proxy-secret")

  const method = plugin.auth.methods[0]
  const authorize = await method.authorize()
  const result = await authorize.callback()
  assert.equal(result.type, "success")
  assert.ok(result.expires > Date.now())
})
