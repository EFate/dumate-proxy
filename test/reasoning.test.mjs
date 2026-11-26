import test from "node:test"
import assert from "node:assert/strict"
import { normalizeReasoningBody } from "../src/gateway.mjs"

test("reasoning effort is normalized for deepseek-v41-flash", () => {
  const raw = JSON.stringify({ model: "deepseek-v41-flash", reasoning_effort: "low" })
  const result = JSON.parse(normalizeReasoningBody(raw))
  assert.equal(result.reasoning_effort, "high")
  assert.equal(result.thinking.type, "enabled")
  assert.equal(result.enable_thinking, true)
})

test("reasoning none removes effort and disables thinking", () => {
  const raw = JSON.stringify({ model: "deepseek-v41-flash", reasoning_effort: "none" })
  const result = JSON.parse(normalizeReasoningBody(raw))
  assert.equal("reasoning_effort" in result, false)
  assert.equal(result.thinking.type, "disabled")
  assert.equal(result.enable_thinking, false)
})
