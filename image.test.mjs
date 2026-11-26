import test from "node:test"
import assert from "node:assert/strict"
import {
  buildImageUpstreamBody,
  chatMessagesToPrompt,
  extractImages,
  parseSize,
  toChatCompletion,
  toOpenAIImages,
} from "../src/image.mjs"

const config = { imageFetchTimeoutMs: 1000, maxImageBytes: 1024, userAgent: "test" }

test("size parsing supports common formats", () => {
  assert.deepEqual(parseSize("1024x768"), { width: 1024, height: 768 })
  assert.deepEqual(parseSize("512×512"), { width: 512, height: 512 })
  assert.deepEqual(parseSize("bad"), {})
})

test("chat messages are flattened to a prompt", () => {
  const prompt = chatMessagesToPrompt([
    { role: "system", content: "ignored" },
    { role: "user", content: [
      { type: "text", text: "画一只猫" },
      { type: "image_url", image_url: { url: "https://example.com/ref.png" } },
    ] },
  ])
  assert.match(prompt, /画一只猫/)
  assert.match(prompt, /ref\.png/)
})

test("image upstream body uses prompt and excludes OpenAI-only fields", () => {
  const body = buildImageUpstreamBody({
    prompt: "red circle",
    n: 2,
    size: "1024x1024",
    response_format: "b64_json",
    user: "u1",
    negative_prompt: "blue",
  }, { id: "dumate-image0.1", upstreamId: "dumate-image0.1" })
  assert.equal(body.model, "dumate-image0.1")
  assert.equal(body.prompt, "red circle")
  assert.equal(body.width, 1024)
  assert.equal(body.height, 1024)
  assert.equal(body.negative_prompt, "blue")
  assert.equal("response_format" in body, false)
  assert.equal("user" in body, false)
})

test("images are extracted from OpenAI, markdown and text payloads", () => {
  const images = extractImages({
    data: [{ url: "https://cdn.example.com/a.png" }],
    choices: [{ message: { content: "结果 ![img](https://cdn.example.com/b.jpg?x=1)" } }],
  })
  assert.deepEqual(images.map((item) => item.url).sort(), [
    "https://cdn.example.com/a.png",
    "https://cdn.example.com/b.jpg?x=1",
  ])
})

test("OpenAI image response converts URLs to b64_json", async () => {
  const fetchImpl = async () => new Response(Buffer.from("fake-image"), {
    status: 200,
    headers: { "content-type": "image/png" },
  })
  const result = await toOpenAIImages(
    { data: [{ url: "https://cdn.example.com/a.png" }] },
    { model: "dumate-image0.1", responseFormat: "b64_json" },
    config,
    fetchImpl,
  )
  assert.equal(result.status, 200)
  assert.equal(result.body.data[0].b64_json, Buffer.from("fake-image").toString("base64"))
})

test("pending image payload is preserved", async () => {
  const result = await toOpenAIImages(
    { task_id: "t-1", status: "pending" },
    { model: "dumate-image0.1", responseFormat: "url" },
    config,
    fetch,
  )
  assert.equal(result.status, 202)
  assert.equal(result.body.task_id, "t-1")
})

test("chat completion wraps generated images as markdown", () => {
  const completion = toChatCompletion(
    { data: [{ url: "https://cdn.example.com/a.png" }] },
    "dumate-image0.1",
    { model: "dumate-image0.1" },
  )
  assert.match(completion.choices[0].message.content, /!\[image-1\]\(https:\/\/cdn\.example\.com\/a\.png\)/)
})
