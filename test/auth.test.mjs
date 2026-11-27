import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCipheriv, randomBytes } from "node:crypto"
import { buildCookieHeader, extractCsrfToken, parseCookieKey, parseCookieString, readDesktopLogin, DuMateAuth } from "../src/auth.mjs"

test("cookie header follows DuMate domain filtering and quoting", () => {
  const cookies = [
    { name: "a", value: "1", domain: ".baidu.com" },
    { name: "b", value: "x y", domain: "console.bce.baidu.com" },
    { name: "c", value: "2", domain: "example.com" },
  ]
  assert.equal(buildCookieHeader(cookies, "console.bce.baidu.com"), 'a=1; b="x y"')
  assert.equal(extractCsrfToken(cookies, "console.bce.baidu.com"), "")
})

test("pasted cookie string is parsed", () => {
  assert.deepEqual(parseCookieString('a=1; b="x y"'), [
    { name: "a", value: "1", domain: ".baidu.com" },
    { name: "b", value: "x y", domain: ".baidu.com" },
  ])
})

test("desktop login is decrypted read-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "dumate-auth-"))
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const plain = JSON.stringify([{ name: "bce-sessionid", value: "abc", domain: ".baidu.com" }])
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const envelope = Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  writeFileSync(join(dir, ".cookie-key"), key)
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    cookies: envelope.toString("base64"),
    activeProfileId: "p1",
    accountProfiles: [{ profileId: "p1", bceAccountId: "acct", displayName: "test" }],
  }))
  const login = readDesktopLogin({ userDataDir: dir })
  assert.equal(login.source, "desktop")
  assert.equal(login.accountId, "acct")
  assert.equal(login.cookies[0].name, "bce-sessionid")
})

test("gateway token calls are single-flight", async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return new Response(JSON.stringify({ code: 0, result: { token: "tok", expired_at: new Date(Date.now() + 3600_000).toISOString() } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  const auth = new DuMateAuth({ consoleBase: "https://console.bce.baidu.com", cookie: "a=1", userAgent: "test", requestTimeoutMs: 5000 }, { fetchImpl })
  const [a, b] = await Promise.all([auth.gatewayToken("a=1"), auth.gatewayToken("a=1")])
  assert.equal(a, "tok")
  assert.equal(b, "tok")
  assert.equal(calls, 1)
})

test("refreshGatewayToken forces a new gateway token", async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return new Response(JSON.stringify({
      code: 0,
      result: { token: `tok-${calls}`, expired_at: new Date(Date.now() + 3600_000).toISOString() },
    }), { status: 200, headers: { "content-type": "application/json" } })
  }
  const auth = new DuMateAuth({ consoleBase: "https://console.bce.baidu.com", cookie: "a=1", userAgent: "test", requestTimeoutMs: 5000 }, { fetchImpl })
  const first = await auth.gatewayToken("a=1")
  await auth.gatewayToken("a=1")
  assert.equal(calls, 1)
  const refreshed = await auth.refreshGatewayToken("a=1")
  assert.equal(first, "tok-1")
  assert.equal(refreshed, "tok-2")
  assert.equal(calls, 2)
})

test("runtime cookie survives a new DuMateAuth instance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dumate-runtime-"))
  const config = { consoleBase: "https://console.bce.baidu.com", stateDir: dir, userAgent: "test", requestTimeoutMs: 5000 }
  const first = new DuMateAuth(config)
  await first.setCookie("bce-sessionid=abc; BDUSS=xyz", "manual")
  const second = new DuMateAuth(config)
  assert.equal(await second.cookieHeader(), "bce-sessionid=abc; BDUSS=xyz")
})

test("pasteable cookie key accepts certutil base64 text", () => {
  const key = randomBytes(32)
  const body = key.toString("base64").match(/.{1,64}/g).join("\n")
  const wrapped = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`
  assert.deepEqual(parseCookieKey(wrapped), key)
  assert.deepEqual(parseCookieKey(key.toString("hex")), key)
})
