import test from "node:test"
import assert from "node:assert/strict"
import { importCatalog } from "../src/catalog.mjs"

const raw = {
  provider: {
    QianfanPersonalQuota: {
      models: {
        "model-text": { id: "model-text", limit: { context: 1_000_000, output: 384_000 }, modalities: { input: ["text", "image"], output: ["text"] } },
        "dumate-image0.1": { id: "dumate-image0.1", limit: { context: 200_000, output: 32_000 }, modalities: { input: ["text"], output: ["image"] } },
        "embedding-x": { id: "embedding-x", limit: { context: 1000, output: 100 }, modalities: { input: ["text"], output: ["text"] } },
        "model-gui-use": { id: "model-gui-use", limit: { context: 1000, output: 100 }, modalities: { input: ["text"], output: ["text"] } },
        "tmp1-model-text": { id: "tmp1-model-text", limit: { input: 1000, output: 100 }, modalities: { input: ["text"], output: ["image", "audio"] } },
      },
    },
  },
}

test("catalog imports chat and image models with metadata", () => {
  const catalog = importCatalog(raw, { source: "test", env: {} })
  assert.ok(catalog.models["model-text"])
  assert.equal(catalog.models["model-text"].kind, "chat")
  assert.deepEqual(catalog.models["model-text"].modalities.output, ["text"])
  assert.equal(catalog.models["dumate-image0.1"].kind, "image")
  assert.deepEqual(catalog.models["dumate-image0.1"].modalities.output, ["image"])
  assert.equal(catalog.models["tmp1-model-text"].kind, "image")
  assert.equal(catalog.models["embedding-x"], undefined)
  assert.equal(catalog.models["model-gui-use"], undefined)
  assert.equal(catalog.defaultChatModel, "model-text")
  assert.equal(catalog.defaultImageModel, "dumate-image0.1")
})
