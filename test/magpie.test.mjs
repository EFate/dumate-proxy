import { createCipheriv, randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  assert.deepEqual(models["dumate-image2.2"].modalities.output, ["image"])
  assert.equal(models["dumate-image2.2"].modalities.output.includes("text"), false)
  assert.deepEqual(models["model-text"].modalities.output, ["text"])
})

test("plugin registers official gateway, not a local proxy", async () => {
  const plugin = await DuMateProxyPlugin({ config: {}, catalog })
  const config = {}
  plugin.config(config)
  assert.equal(config.provider.dumate.api, GATEWAY_BASE)
  assert.ok(config.provider.dumate.models["model-text"])
  assert.deepEqual(config.provider.dumate.models["dumate-image2.2"].modalities.output, ["image"])
})

test("entry has four login methods with file upload first", async () => {
  const plugin = await DuMateProxyPlugin({ config: {}, catalog })
  assert.equal(plugin.auth.methods.length, 4)
  assert.ok(plugin.auth.methods[0].label.includes("上传两个文件"))
  assert.ok(plugin.auth.methods[1].label.includes("桌面端"))
  assert.ok(plugin.auth.methods[2].label.includes("浏览器"))
  assert.ok(plugin.auth.methods[3].label.includes("手动粘贴"))
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

  const browser = await plugin.auth.methods[2].authorize()
  assert.equal(browser.method, "code")
  assert.ok(browser.url.startsWith("https://login.bce.baidu.com/"))
  const seat = await browser.callback("bce-sessionid=abc; BDUSS=xyz")
  assert.equal(seat.type, "success")
  assert.equal(seat.source, "browser")
  assert.equal(seat.accountId, "DuMate User")
  assert.equal(seat.uid, "acct-1")
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


test("usage reports DuMate point balance", async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes("quota_overview")) {
      return json({ code: 0, result: { totalPoints: "1000", usedPoints: "250", subscription: [{ status: "active", expireDate: Math.floor(Date.now() / 1000) + 3600, totalPoints: "100" }] } })
    }
    if (target.includes("loginBonusInfo")) return json({ code: 0, result: { hasIssued: true, totalTimes: 3, totalPoints: "1000" } })
    throw new Error(`unexpected url ${target}`)
  }
  const plugin = await DuMateProxyPlugin({ config: {}, catalog, fetchImpl })
  const result = await plugin.auth.usage(async () => ({ type: "oauth", cookies: [{ name: "bce-sessionid", value: "abc", domain: ".baidu.com" }], name: "DuMate User", accountId: "acct" }))
  assert.equal(result.balance, "750.00 积分")
  assert.equal(result.plan, "已签到 3 天")
  assert.equal(result.windows[0].display, "250.00 / 1000.00")
  assert.ok(result.windows[0].runsOutAt)
})

test("checkin claims the daily bonus and reports the point delta", async () => {
  let bonusInfoCalls = 0
  let checkinCalls = 0
  const fetchImpl = async (url, init) => {
    const target = String(url)
    if (target.includes("loginBonusInfo")) {
      bonusInfoCalls++
      const issued = bonusInfoCalls > 1
      return json({ code: 0, result: { hasIssued: issued, totalTimes: issued ? 4 : 3, totalPoints: issued ? "1500" : "1000" } })
    }
    if (target.includes("loginBonus") && init?.method === "POST") {
      checkinCalls++
      return json({ code: 0, result: {} })
    }
    throw new Error(`unexpected url ${target}`)
  }
  const plugin = await DuMateProxyPlugin({ config: {}, catalog, fetchImpl })
  const result = await plugin.auth.checkin(async () => ({ type: "oauth", cookies: [{ name: "bce-sessionid", value: "abc", domain: ".baidu.com" }] }))
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 500)
  assert.equal(checkinCalls, 1)
})


test("built-in catalog exposes the full DuMate model set", () => {
  const builtin = JSON.parse(readFileSync(new URL("../src/models.default.json", import.meta.url), "utf8"))
  const full = importCatalog(builtin, { source: "builtin-test", env: {} })
  assert.ok(full.chatModels.length >= 20)
  assert.ok(full.imageModels.includes("dumate-image0.1"))
  assert.ok(full.models["deepseek-v41-flash"])
  assert.ok(full.models["kimi-k3"])
})


test("multiple accounts keep distinct identities", async () => {
  const fetchImpl = async (url, init) => {
    const header = String(init?.headers?.Cookie ?? init?.headers?.get?.("cookie") ?? "")
    const name = header.includes("session-8") ? "EFate8" : "EFateNex"
    return json({ code: 0, result: { bceAccountId: "same-upstream-id", displayName: name } })
  }
  const plugin = await DuMateProxyPlugin({ config: {}, catalog, fetchImpl })
  assert.equal(plugin.auth.single, false)
  const method = plugin.auth.methods[2]
  const a = await (await method.authorize()).callback("bce-sessionid=session-8; BDUSS=x")
  const b = await (await method.authorize()).callback("bce-sessionid=session-nex; BDUSS=y")
  assert.notEqual(a.accountId, b.accountId)
  assert.equal(a.accountId, "EFate8")
  assert.equal(b.accountId, "EFateNex")
  assert.equal(a.uid, b.uid)
})

test("generic console API errors do not mark the account expired", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("quota_overview")) return json({ code: 1, message: "login service temporarily unavailable" })
    if (String(url).includes("loginBonusInfo")) return json({ code: 0, result: { hasIssued: true, totalTimes: 1 } })
    throw new Error(`unexpected url ${url}`)
  }
  const plugin = await DuMateProxyPlugin({ config: {}, catalog, fetchImpl })
  const result = await plugin.auth.usage(async () => ({ type: "oauth", cookies: [{ name: "bce-sessionid", value: "abc", domain: ".baidu.com" }] }))
  assert.ok(result.error)
  assert.equal(result.signIn, "kept")
})


test("config exposes exactly one strongest image model", async () => {
  const plugin = await DuMateProxyPlugin({ config: {}, catalog })
  const config = {}
  plugin.config(config)
  const imageIds = Object.entries(config.provider.dumate.models)
    .filter(([id, model]) => model.modalities?.output?.includes("image") || /^dumate-image/i.test(id))
    .map(([id]) => id)
  assert.deepEqual(imageIds, ["dumate-image2.2"])
  assert.equal(config.provider.dumate.models["dumate-image2.2"].modalities.output.includes("text"), false)
})
test("group/image compatibility alias is not advertised as a second model", async () => {
  const plugin = await DuMateProxyPlugin({ config: {}, catalog })
  const config = {}
  plugin.config(config)
  assert.equal(config.provider.dumate.models["group/image"], undefined)
})

test("JSON image edits stay on the official chat route", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(String(url))
    if (String(url).includes("/api/dumate/app/token/get")) return json({ code: 0, result: { token: "edit-token", expired_at: new Date(Date.now() + 3600_000).toISOString() } })
    if (String(url).includes(`${GATEWAY_BASE}/chat/completions`)) return json({ choices: [{ message: { content: "参考图描述：白发精灵少女，森林水流与阳光光束" } }] })
    if (String(url).includes("/gateway/v2/tools/dumate/image_generate_v3/async")) {
      if (init?.method === "POST") return json({ code: "0", task_id: "task-edit" })
      return json({ code: "0", status: "success", imageUrls: ["https://cdn.example.com/edited.png"] })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const plugin = await DuMateProxyPlugin({ config: {}, catalog, fetchImpl })
  const loader = await plugin.loader(async () => ({ type: "oauth", cookies: [{ name: "bce-sessionid", value: "abc", domain: ".baidu.com" }] }))
  const response = await loader.fetch(`${GATEWAY_BASE}/images/edits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "group/image", prompt: "参考这张图生成新图", image: "data:image/jpeg;base64,AAAA", size: "1024x1024", response_format: "url" }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data[0].url, "https://cdn.example.com/edited.png")
  assert.ok(!calls.some((url) => url.includes("/images/edits")))
})


function makeDesktopAuthPayload({ accountId, name, cookieValue }) {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const cookies = [{ name: "bce-sessionid", value: cookieValue, domain: ".baidu.com" }]
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(cookies), "utf8"), cipher.final()])
  const envelope = Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  return {
    authJson: JSON.stringify({
      cookies: envelope.toString("base64"),
      activeProfileId: "p1",
      accountProfiles: [{ profileId: "p1", bceAccountId: accountId, displayName: name }],
    }),
    cookieKey: key.toString("base64"),
  }
}

function makeDesktopLoginDir({ accountId, name, cookieValue }) {
  const dir = mkdtempSync(join(tmpdir(), "dumate-refresh-"))
  const payload = makeDesktopAuthPayload({ accountId, name, cookieValue })
  writeFileSync(join(dir, ".cookie-key"), Buffer.from(payload.cookieKey, "base64"))
  writeFileSync(join(dir, "auth.json"), payload.authJson)
  return dir
}

test("stale gateway token refreshes once before the account is marked expired", async () => {
  let tokenCalls = 0
  let gatewayCalls = 0
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/api/dumate/app/token/get")) {
      tokenCalls++
      return json({ code: 0, result: { token: `token-${tokenCalls}`, expired_at: new Date(Date.now() + 3600_000).toISOString() } })
    }
    if (String(url).includes(`${GATEWAY_BASE}/chat/completions`)) {
      gatewayCalls++
      assert.equal(String(init?.headers?.Authorization), `Bearer token-${gatewayCalls}`)
      if (gatewayCalls === 1) return json({ error: { message: "stale token" } }, 401)
      return json({ id: "chat-ok", model: "model-text", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const plugin = await DuMateProxyPlugin({ config: {}, catalog, fetchImpl })
  const loader = await plugin.loader(async () => ({
    type: "oauth",
    cookies: [{ name: "bce-sessionid", value: "stale-token-retry", domain: ".baidu.com" }],
  }))
  const response = await loader.fetch(`${GATEWAY_BASE}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "model-text", messages: [] }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, "ok")
  assert.equal(tokenCalls, 2)
  assert.equal(gatewayCalls, 2)
})

test("repeated gateway 401 still marks the account expired", async () => {
  let tokenCalls = 0
  let gatewayCalls = 0
  const fetchImpl = async (url) => {
    if (String(url).includes("/api/dumate/app/token/get")) {
      tokenCalls++
      return json({ code: 0, result: { token: `token-${tokenCalls}`, expired_at: new Date(Date.now() + 3600_000).toISOString() } })
    }
    if (String(url).includes(`${GATEWAY_BASE}/chat/completions`)) {
      gatewayCalls++
      return json({ error: { message: "still unauthorized" } }, 401)
    }
    throw new Error(`unexpected url ${url}`)
  }
  const plugin = await DuMateProxyPlugin({ config: {}, catalog, fetchImpl })
  const loader = await plugin.loader(async () => ({
    type: "oauth",
    cookies: [{ name: "bce-sessionid", value: "stale-token-expired", domain: ".baidu.com" }],
  }))
  const response = await loader.fetch(`${GATEWAY_BASE}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "model-text", messages: [] }),
  })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("X-Magpie-Sign-In"), "expired")
  assert.equal(tokenCalls, 2)
  assert.equal(gatewayCalls, 2)
})

test("browser seats adopt the desktop login when the same account is active", async () => {
  const userDataDir = makeDesktopLoginDir({ accountId: "acct-desktop", name: "EFate8", cookieValue: "desktop-cookie" })
  const plugin = await DuMateProxyPlugin({ config: { userDataDir }, catalog })
  const refreshed = await plugin.auth.refresh({
    type: "success",
    source: "browser",
    uid: "acct-desktop",
    accountId: "EFate8",
    cookies: [{ name: "bce-sessionid", value: "old-cookie", domain: ".baidu.com" }],
  })
  assert.equal(refreshed.type, "success")
  assert.equal(refreshed.source, "desktop")
  assert.equal(refreshed.uid, "acct-desktop")
  assert.equal(refreshed.cookies[0].value, "desktop-cookie")

  const other = await plugin.auth.refresh({
    type: "success",
    source: "manual",
    uid: "acct-other",
    accountId: "Other",
    cookies: [{ name: "bce-sessionid", value: "old-cookie", domain: ".baidu.com" }],
  })
  assert.equal(other, undefined)
})


test("auth.import reads uploaded auth.json and key text files", async () => {
  const payload = makeDesktopAuthPayload({ accountId: "acct-import", name: "EFateImport", cookieValue: "imported-auth-cookie" })
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/api/dumate/user/info")) {
      const cookie = String(init?.headers?.Cookie ?? "")
      assert.ok(cookie.includes("bce-sessionid=imported-auth-cookie"))
      return json({ code: 0, result: { bceAccountId: "acct-import", displayName: "EFateImport" } })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const plugin = await DuMateProxyPlugin({ config: {}, catalog, fetchImpl })
  assert.ok(plugin.auth.importFrom.includes("auth.json"))
  assert.ok(plugin.auth.importFroms.zh.includes("两个文件"))

  const seat = await plugin.auth.import([payload.cookieKey, payload.authJson])
  assert.equal(seat.type, "success")
  assert.equal(seat.source, "imported-auth")
  assert.equal(seat.accountId, "EFateImport")
  assert.equal(seat.uid, "acct-import")
  assert.equal(seat.cookies[0].value, "imported-auth-cookie")

  const missingKey = await plugin.auth.import([payload.authJson])
  assert.equal(missingKey.type, "failed")
  assert.ok(missingKey.error.includes("cookie-key"))
})


test("upload sign-in receives auth.json and raw key from the browser page", async () => {
  const payload = makeDesktopAuthPayload({ accountId: "acct-upload", name: "EFateUpload", cookieValue: "uploaded-cookie" })
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/api/dumate/user/info")) {
      const cookie = String(init?.headers?.Cookie ?? "")
      assert.ok(cookie.includes("bce-sessionid=uploaded-cookie"))
      return json({ code: 0, result: { bceAccountId: "acct-upload", displayName: "EFateUpload" } })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const plugin = await DuMateProxyPlugin({
    config: { importBind: "127.0.0.1", importPort: 0 },
    catalog,
    fetchImpl,
  })
  const method = plugin.auth.methods[0]
  assert.ok(method.label.includes("上传两个文件"))
  const auth = await method.authorize()
  assert.equal(auth.method, "auto")

  const uploadUrl = new URL(auth.url)
  const page = await fetch(auth.url)
  assert.equal(page.status, 200)
  assert.ok((await page.text()).includes("auth.json"))

  const token = uploadUrl.searchParams.get("token")
  assert.ok(token)
  const uploaded = await fetch(`${uploadUrl.origin}/dumate-import/upload?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  assert.equal(uploaded.status, 200)

  const seat = await auth.callback()
  assert.equal(seat.type, "success")
  assert.equal(seat.source, "uploaded-auth")
  assert.equal(seat.accountId, "EFateUpload")
  assert.equal(seat.uid, "acct-upload")
  assert.equal(seat.cookies[0].value, "uploaded-cookie")
  await plugin.auth.closeImportServer()
})
