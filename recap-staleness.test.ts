import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { countUserMessages, isRecapStale } from "./recap-staleness.ts"

const user = (id: string) => ({ info: { id, role: "user" } })
const assistant = (id: string) => ({ info: { id, role: "assistant" } })

describe("countUserMessages", () => {
  it("counts only messages with info.role === 'user'", () => {
    const messages = [
      user("m1"),
      assistant("m2"),
      user("m3"),
      { info: { id: "m4", role: "tool" } },
      assistant("m5"),
    ]
    assert.equal(countUserMessages(messages), 2)
  })
  it("returns 0 for an empty session", () => {
    assert.equal(countUserMessages([]), 0)
  })
  it("survives junk entries and flat shapes", () => {
    const messages = [null, undefined, 42, "junk", { role: "user" }, { info: null }]
    assert.equal(countUserMessages(messages), 1)
  })
})

describe("isRecapStale", () => {
  it("not stale below the threshold", () => {
    // baseline 5, threshold 3: one or two own messages keep the Recap fresh
    assert.equal(isRecapStale(6, 5, 3), false)
    assert.equal(isRecapStale(7, 5, 3), false)
  })
  it("stale exactly at the threshold", () => {
    assert.equal(isRecapStale(8, 5, 3), true)
  })
  it("stale past the threshold", () => {
    assert.equal(isRecapStale(20, 5, 3), true)
  })
  it("compaction shrinking history never marks stale (negative delta)", () => {
    assert.equal(isRecapStale(4, 10, 3), false)
  })
  it("zero threshold marks stale on any new message but not on none", () => {
    assert.equal(isRecapStale(5, 5, 0), false)
    assert.equal(isRecapStale(6, 5, 0), true)
  })
})
