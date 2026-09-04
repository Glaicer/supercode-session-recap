import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { LruMap, RECAP_SESSION_STATE_LIMIT, createRecapRecord } from "./recap-state.ts"

describe("LruMap", () => {
  it("stores and returns values", () => {
    const lru = new LruMap<string, number>(3)
    lru.set("a", 1)
    assert.equal(lru.get("a"), 1)
    assert.equal(lru.size, 1)
  })
  it("evicts the least recently USED entry over the cap", () => {
    const lru = new LruMap<string, number>(2)
    lru.set("a", 1)
    lru.set("b", 2)
    assert.equal(lru.get("a"), 1)
    lru.set("c", 3)
    assert.equal(lru.has("b"), false)
    assert.equal(lru.has("a"), true)
    assert.equal(lru.has("c"), true)
    assert.equal(lru.size, 2)
  })
  it("set of an existing key refreshes recency without growing", () => {
    const lru = new LruMap<string, number>(2)
    lru.set("a", 1)
    lru.set("b", 2)
    lru.set("a", 10)
    lru.set("c", 3)
    assert.equal(lru.has("b"), false)
    assert.equal(lru.get("a"), 10)
    assert.equal(lru.size, 2)
  })
  it("delete removes an entry; clear empties everything", () => {
    const lru = new LruMap<string, number>(4)
    lru.set("a", 1)
    lru.set("b", 2)
    lru.delete("a")
    assert.equal(lru.has("a"), false)
    lru.clear()
    assert.equal(lru.size, 0)
    assert.equal(lru.get("b"), undefined)
  })
  it("cap is at least 1 whatever is requested", () => {
    const lru = new LruMap<string, number>(0)
    lru.set("a", 1)
    lru.set("b", 2)
    assert.equal(lru.size, 1)
    assert.equal(lru.has("a"), false)
  })
})

describe("createRecapRecord", () => {
  it("starts with no anchor, no lastRecap, nothing queued and no signals", () => {
    const record = createRecapRecord()
    assert.equal(record.anchor, undefined)
    assert.equal(record.lastRecap, undefined)
    assert.equal(record.autoQueued, false)
    assert.equal(record.recap, undefined)
    assert.equal(record.loading, undefined)
  })
})

describe("RECAP_SESSION_STATE_LIMIT", () => {
  it("is a hard positive bound", () => {
    assert.ok(Number.isInteger(RECAP_SESSION_STATE_LIMIT))
    // pinned so a silent retune of the cap is a visible change
    assert.equal(RECAP_SESSION_STATE_LIMIT, 64)
  })
})
