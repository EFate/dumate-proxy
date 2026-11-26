import test from "node:test"
import assert from "node:assert/strict"
import { importCatalog } from "../src/catalog.mjs"
import { DuMateProxyPlugin, _internal } from "../magpie.mjs"
const { toMagpieModels } = _internal

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


test("server entry does not expose functions to the plugin host", async () => {
  const module = await import("../src/server.mjs")
  assert.equal(Object.values(module).filter((value) => typeof value === "function").length, 0)
  assert.equal(typeof module._internal.createProxyServer, "function")
})

test("entry exports only one plugin function with a usable sign-in method", async () => {
  const module = await import("../magpie.mjs")
  const functions = [...new Set(Object.values(module).filter((value) => typeof value === "function"))]
  assert.equal(functions.length, 1)
  const hooks = await functions[0]({ config: {}, catalog, proxyUrl: "http://127.0.0.1:8799/v1" })
  assert.equal(hooks.auth.provider, "dumate")
  assert.match(hooks.auth.icon, /^data:image\/png;base64,/)
  assert.equal(hooks.auth.methods.length, 4)
  assert.ok(hooks.auth.methods.some((method) => method.label.includes("浏览器登录")))
  assert.ok(hooks.auth.methods.some((method) => method.label.includes("手动粘贴")))
  assert.ok(hooks.auth.methods.some((method) => method.label.includes("桌面端")))
  assert.equal(typeof hooks.auth.methods[0].authorize, "function")
})


test("all sign-in methods validate cookies through the proxy", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    const body = init?.body ? JSON.parse(init.body) : {}
    return new Response(JSON.stringify({
      status: "ok",
      login: "ok",
      source: body.source || (String(url).includes("/v1/auth/desktop") ? "desktop" : "proxy"),
      accountId: "acct-1",
      name: "DuMate User",
      cookieTail: "abcd",
    }), { status: 200, headers: { "content-type": "application/json" } })
  }
  const plugin = await DuMateProxyPlugin({
    config: {},
    catalog,
    proxyUrl: "http://127.0.0.1:8799/v1",
    proxyKey: "proxy-secret",
    fetchImpl,
  })
  const [proxyMethod, desktopMethod, browserMethod, manualMethod] = plugin.auth.methods

  const proxyAuth = await proxyMethod.authorize()
  assert.equal((await proxyAuth.callback()).accountId, "acct-1")

  const desktopAuth = await desktopMethod.authorize()
  const desktop = await desktopAuth.callback()
  assert.equal(desktop.source, "desktop")

  const browserAuth = await browserMethod.authorize()
  assert.equal(browserAuth.method, "code")
  const browser = await browserAuth.callback("bce-sessionid=abc; BDUSS=xyz")
  assert.equal(browser.source, "browser")

  const manualAuth = await manualMethod.authorize({ cookie: "bce-sessionid=abc; BDUSS=xyz" })
  const manual = await manualAuth.callback()
  assert.equal(manual.source, "manual")

  const rejected = await browserAuth.callback("document.cookie=fake")
  assert.equal(rejected.type, "failed")

  const authCalls = calls.filter((call) => call.url.includes("/v1/auth/"))
  assert.equal(authCalls.length, 3)
  assert.ok(authCalls.every((call) => call.init.headers.Authorization === "Bearer proxy-secret"))
})


test("login form can use a reachable proxy URL and loader keeps it", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ status: "ok", login: "ok", source: "browser", accountId: "acct-2", name: "DuMate User", cookieTail: "wxyz" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  const plugin = await DuMateProxyPlugin({ config: {}, catalog, proxyUrl: "http://127.0.0.1:8799/v1", fetchImpl })
  const browser = await plugin.auth.methods[2].authorize({ proxyUrl: "http://127.0.0.1:8899/v1", proxyKey: "custom-key" })
  const seat = await browser.callback("bce-sessionid=abc; BDUSS=xyz")
  assert.equal(seat.proxyUrl, "http://127.0.0.1:8899/v1")
  assert.equal(seat.proxyKey, "custom-key")
  assert.ok(calls[0].url.startsWith("http://127.0.0.1:8899/v1/auth/login"))

  const loader = await plugin.loader(async () => seat)
  assert.equal(loader.baseURL, "http://127.0.0.1:8899/v1")
  assert.equal(loader.apiKey, "custom-key")
  const ok = await loader.fetch("http://127.0.0.1:8899/v1/models")
  assert.equal(ok.status, 200)
  assert.equal(calls.at(-1).init.headers.get("authorization"), "Bearer custom-key")
})
