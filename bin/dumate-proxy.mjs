#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs"
import { loadCatalog } from "../src/catalog.mjs"
import { DuMateAuth } from "../src/auth.mjs"
import { GatewayClient } from "../src/gateway.mjs"
import { _internal } from "../src/server.mjs"
const { createProxyServer } = _internal

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`dumate-proxy — OpenAI-compatible DuMate reverse proxy

Usage:
  node bin/dumate-proxy.mjs

Important environment variables:
  DUMATE_HOST                 listen host (default 127.0.0.1)
  DUMATE_PORT                 listen port (default 8787)
  DUMATE_USER_DATA_DIR        DuMate desktop data dir override
  DUMATE_OPENCODE_CONFIG      DuMate opencode.json override
  DUMATE_COOKIE               pasted cookie header
  DUMATE_COOKIE_FILE          file containing a cookie header
  DUMATE_PROXY_API_KEY        optional client API key
  DUMATE_MODEL                default chat model
  DUMATE_IMAGE_MODEL          default image model
  DUMATE_STATE_DIR            metadata snapshot directory

Endpoints:
  GET  /v1/models
  POST /v1/chat/completions
  POST /v1/images/generations
  POST /v1/images/edits
  GET  /healthz
`)
  process.exit(0)
}

const config = loadConfig()
const auth = new DuMateAuth(config)
const catalog = loadCatalog(config)
const gateway = new GatewayClient(config, auth)
const server = createProxyServer({ config, auth, gateway, catalog })

let loginState = "ok"
try {
  await auth.cookieHeader()
} catch {
  loginState = "missing"
}

server.listen(config.port, config.host, () => {
  const base = `http://${config.host}:${config.port}/v1`
  console.log(`[dumate-proxy] listening on http://${config.host}:${config.port}`)
  console.log(`[dumate-proxy] DuMate login: ${loginState}`)
  console.log(`[dumate-proxy] catalog: ${catalog.source} (${catalog.chatModels.length} chat / ${catalog.imageModels.length} image)`)
  console.log(`[dumate-proxy] chat: ${base}/chat/completions`)
  console.log(`[dumate-proxy] images: ${base}/images/generations`)
  console.log(`[dumate-proxy] models: ${base}/models`)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[dumate-proxy] received ${signal}, closing`)
    server.close(() => process.exit(0))
  })
}
