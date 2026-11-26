import test from "node:test"
import assert from "node:assert/strict"
import { importCatalog } from "../src/catalog.mjs"
import { DuMateProxyPlugin, _internal } from "../magpie.mjs"

const GATEWAY_BASE = "https://dumate-svc.baidu.com/gateway/apis/v1"
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
        "dumate-image0.1": {
          id: "dumate-image0.1",
          name: "DuMate Image",
          limit: { context: 200_000, output: 32_000 },
          tool_call: false,
          modalities: { input: ["text"], output: ["image"] },
        },
      },
    },
  },
}
const catalog = importCatalog(raw, { source: "test", env: {} })

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("catalog normalizes image output modalities for Magpie", () => {
  assert.deepEqual(catalog.models["dumate-image0.1"].modalities.output, ["image"])
  assert.equal(catalog.models["dumate-image0.1"].attachment, false)
  assert.deepEqual(catalog.models["model-text"].modalities.output, ["text"])
})

test("Magpie model map exposes text and image modalities", () => {
  const models = _internal.toMagpieModels(catalog)
  assert.deepEqual(models["dumate-image0.1"].modalities.output, ["image"])
  assert.equal(models["dumate-image0.1"].modalities.output.includes("text"), false)
  assert.deepEqual(models["model-text"].modalities.output, ["text"])
})

test("plugin registers official gateway, not a local proxy", async () => {
  const plugin = await DuMateProxyPlugin({ config: {}, catalog })
  const config = {}
  plugin.config(config)
  assert.equal(config.provider.dumate.api, GATEWAY_BASE)
  assert.ok(config.provider.dumate.models["model-text"])
  assert.deepEqual(config.provider.dumate.models["dumate-image0.1"].modalities.output, ["image"])
})

test("entry has the three reference login methods", async () => {
  const plugin = await DuMateProxyPlugin({ config: {}, catalog })
  assert.equal(plugin.auth.methods.length, 3)
  assert.ok(plugin.auth.methods[0].label.includes("桌面端"))
  assert.ok(plugin.auth.methods[1].label.includes("浏览器"))
  assert.ok(plugin.auth.methods[2].label.includes("手动粘贴"))
})

test("browser and manual sign-in validate cookies against Baidu console", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes("/api/dumate/user/info")) {
      return json({ code: 0, result: { bceAccountId: "acct-1", displayName: "DuMate User" } })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const plugin = await DuMateProxyPlugin({ config: {}, catalog, fetchImpl })

  const browser = await plugin.auth.methods[1].authorize()
  assert.equal(browser.method, "code")
  assert.ok(browser.url.startsWith("https://login.bce.baidu.com/"))
  const seat = await browser.callback("bce-sessionid=abc; BDUSS=xyz")
  assert.equal(seat.type, "success")
  assert.equal(seat.source, "browser")
  assert.equal(seat.accountId, "acct-1")
  assert.equal(seat.cookies.length, 2)

  const failed = await browser.callback("document.cookie=fake")
  assert.equal(failed.type, "failed")
  assert.ok(calls.every((call) => call.url.includes("console.bce.baidu.com")))
})

test("loader exchanges stored cookies for a gateway token and calls official gateway", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes("/api/dumate/app/token/get")) {
      return json({ code: 0, result: { token: "gateway-token", expired_at: new Date(Date.now() + 3600_000).toISOString() } })
    }
    if (String(url).includes(`${GATEWAY_BASE}/chat/completions`)) {
      return json({ id: "chat-1", model: "model-text", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const plugin = await DuMateProxyPlugin({ config: {}, catalog, fetchImpl })
  const loader = await plugin.loader(async () => ({
    type: "oauth",
    cookies: [{ name: "bce-sessionid", value: "abc", domain: ".baidu.com" }],
  }))
  assert.equal(loader.baseURL, GATEWAY_BASE)
  const response = await loader.fetch(`${GATEWAY_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "model-text", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).id, "chat-1")
  const gatewayCall = calls.find((call) => call.url.includes(`${GATEWAY_BASE}/chat/completions`))
  assert.equal(gatewayCall.init.headers.Authorization, "Bearer gateway-token")
})
