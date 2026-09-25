import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  modelRefString,
  parseModelRef,
  parseRecapOptions,
  selectRecapModel,
} from "./recap-model.ts"

describe("parseModelRef", () => {
  it("slices strictly by the FIRST slash", () => {
    assert.deepEqual(parseModelRef("gonka-proxy/deepseek-ai/deepseek-v4-flash-0731"), {
      providerID: "gonka-proxy",
      modelID: "deepseek-ai/deepseek-v4-flash-0731",
    })
  })
  it("parses a plain provider/model pair", () => {
    assert.deepEqual(parseModelRef("opencode/nemotron"), {
      providerID: "opencode",
      modelID: "nemotron",
    })
  })
  it("rejects a string without a slash", () => {
    assert.equal(parseModelRef("just-a-name"), undefined)
  })
  it("rejects an empty providerID", () => {
    assert.equal(parseModelRef("/model"), undefined)
  })
  it("rejects an empty modelID", () => {
    assert.equal(parseModelRef("provider/"), undefined)
  })
  it("rejects an empty string", () => {
    assert.equal(parseModelRef(""), undefined)
  })
  it("rejects non-strings", () => {
    for (const bad of [undefined, null, 42, true, {}, [], ["a/b"]]) {
      assert.equal(parseModelRef(bad), undefined, String(bad))
    }
  })
})

describe("parseRecapOptions", () => {
  it("returns defaults for undefined options (no tui.json is normal)", () => {
    assert.deepEqual(parseRecapOptions(undefined), {
      model: undefined,
      budget: 12000,
      timeout_ms: 60000,
      badKeys: [],
    })
  })
  it("returns defaults for any non-object garbage without toasting keys", () => {
    for (const bad of [null, 42, "x", [], true]) {
      const parsed = parseRecapOptions(bad)
      assert.equal(parsed.badKeys.length, 0, String(bad))
      assert.deepEqual(
        { ...parsed, badKeys: undefined },
        { model: undefined, budget: 12000, timeout_ms: 60000, badKeys: undefined },
      )
    }
  })
  it("reads recognized keys of correct type", () => {
    const parsed = parseRecapOptions({
      model: "gonka-proxy/deepseek-ai/deepseek-v4-flash-0731",
      budget: 999,
      timeout_ms: 1234,
    })
    assert.deepEqual({ ...parsed, badKeys: [] }, {
      model: "gonka-proxy/deepseek-ai/deepseek-v4-flash-0731",
      budget: 999,
      timeout_ms: 1234,
      badKeys: [],
    })
  })
  it("treats a blank model option as no explicit model", () => {
    assert.equal(parseRecapOptions({ model: "  " }).model, undefined)
    assert.deepEqual(parseRecapOptions({ model: "" }).badKeys, [])
  })
  it("ignores unrecognized keys silently", () => {
    const parsed = parseRecapOptions({ whatever: "x", another: 1, nested: { a: 2 } })
    assert.deepEqual(parsed.badKeys, [])
    assert.equal(parsed.budget, 12000)
  })
  it("reports recognized keys of wrong type and keeps defaults", () => {
    const parsed = parseRecapOptions({
      model: 42,
      budget: null,
      timeout_ms: {},
    })
    assert.deepEqual(parsed.badKeys.sort(), ["budget", "model", "timeout_ms"])
    assert.equal(parsed.model, undefined)
    assert.equal(parsed.budget, 12000)
    assert.equal(parsed.timeout_ms, 60000)
  })
  it("accepts partial options mixing valid and invalid keys", () => {
    const parsed = parseRecapOptions({ budget: 500, timeout_ms: false })
    assert.equal(parsed.budget, 500)
    assert.equal(parsed.timeout_ms, 60000)
    assert.deepEqual(parsed.badKeys, ["timeout_ms"])
  })
})

describe("modelRefString", () => {
  it("round-trips through parseModelRef by the FIRST slash", () => {
    const raw = modelRefString({ providerID: "gonka-proxy", modelID: "deepseek-ai/deepseek-v4-flash-0731" })
    assert.equal(raw, "gonka-proxy/deepseek-ai/deepseek-v4-flash-0731")
    assert.deepEqual(parseModelRef(raw), {
      providerID: "gonka-proxy",
      modelID: "deepseek-ai/deepseek-v4-flash-0731",
    })
  })
})

describe("selectRecapModel", () => {
  const available = [
    { providerID: "project", modelID: "main" },
    { providerID: "project", modelID: "small" },
    { providerID: "project", modelID: "team/namespaced" },
  ]
  const fallback = available[0]

  it("uses the explicit model before the title agent model, preserving namespaced IDs", () => {
    assert.deepEqual(selectRecapModel({
      explicit: "project/team/namespaced", title: available[1], fallback, available,
    }), { model: available[2], warnings: [] })
  })

  it("uses the configured title agent model and then the default", () => {
    assert.deepEqual(selectRecapModel({ title: available[1], fallback, available }), {
      model: available[1], warnings: [],
    })
    assert.deepEqual(selectRecapModel({ fallback, available }), { model: fallback, warnings: [] })
  })

  it("warns for each unavailable configured source and falls through", () => {
    assert.deepEqual(selectRecapModel({
      explicit: "missing/model", title: { providerID: "project", modelID: "gone" }, fallback, available,
    }), {
      model: fallback,
      warnings: [
        { source: "model", message: 'Recap option model "missing/model" is unavailable; trying the next model.' },
        { source: "title", message: 'Title agent model "project/gone" is unavailable; trying the default model.' },
      ],
    })
  })

  it("warns for a malformed explicit reference and uses the title model", () => {
    assert.deepEqual(selectRecapModel({ explicit: "bad", title: available[1], fallback, available }), {
      model: available[1],
      warnings: [{ source: "model", message: 'Recap option model "bad" must be provider/model-id; trying the next model.' }],
    })
  })

  it("fails visibly when no available default remains", () => {
    assert.throws(() => selectRecapModel({ available: [] }), /No available Recap model at this location/)
    assert.throws(() => selectRecapModel({ fallback, available: [] }), /No available Recap model at this location/)
  })
})
