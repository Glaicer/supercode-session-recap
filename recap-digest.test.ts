import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  DIGEST_DEFAULT_BUDGET,
  buildRecapDigest,
  buildRecapRequest,
  type DigestMessage,
} from "./recap-digest.ts"

const msg = (id: string, role: string, parts: unknown[] = []): DigestMessage => ({
  info: { id, role },
  parts,
})

const textPart = (text: string) => ({ type: "text", text })

const toolCompleted = (
  tool: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
) => ({
  type: "tool",
  callID: "call-1",
  tool,
  state: { status: "completed", input, output: "x".repeat(5000), title: "t", metadata },
})

const toolError = (tool: string, input: Record<string, unknown>, error: string) => ({
  type: "tool",
  callID: "call-1",
  tool,
  state: { status: "error", input, error },
})

describe("buildRecapDigest — tool calls", () => {
  it("folds one line per completed call: name, short argument, ok", () => {
    const built = buildRecapDigest([
      msg("m1", "user", [textPart("run the tests")]),
      msg("m2", "assistant", [toolCompleted("bash", { command: "npm test" })]),
    ])
    assert.ok(built.digest.includes("[tool] bash npm test -> ok"), built.digest)
  })
  it("picks a path-like argument when present", () => {
    const built = buildRecapDigest([
      msg("m1", "assistant", [toolCompleted("read", { filePath: "src/app.ts" })]),
    ])
    assert.ok(built.digest.includes("[tool] read src/app.ts -> ok"), built.digest)
  })
  it("error outcome carries only the FIRST line of the error", () => {
    const built = buildRecapDigest([
      msg(
        "m1",
        "assistant",
        [toolError("bash", { command: "exit 1" }, "Permission denied\n    at /usr/bin/bash:1")],
      ),
    ])
    assert.ok(built.digest.includes("-> error: Permission denied"), built.digest)
    assert.ok(!built.digest.includes("/usr/bin/bash"), built.digest)
  })
  it("giant tool OUTPUT never enters the digest and budget still holds", () => {
    const messages = Array.from({ length: 50 }, (_, i) =>
      msg(`m${i}`, "assistant", [toolCompleted("bash", { command: `cmd ${i}` })]),
    )
    const built = buildRecapDigest(messages, { budget: DIGEST_DEFAULT_BUDGET })
    assert.ok(built.digest.length <= DIGEST_DEFAULT_BUDGET, String(built.digest.length))
    assert.ok(built.digest.length > 0)
    assert.ok(!built.digest.includes("xxxxx"), "raw tool output leaked")
  })
})

describe("buildRecapDigest — file edits", () => {
  it("edit with diff metadata gives path and +/- counts, no diff content", () => {
    const diff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "-BETA-LINE",
      "-beta2",
      "+ALPHA-LINE",
      "+alpha2",
      "+alpha3",
      " context",
    ].join("\n")
    const built = buildRecapDigest([
      msg("m1", "assistant", [toolCompleted("edit", { filePath: "src/a.ts" }, { diff })]),
    ])
    assert.ok(built.digest.includes("src/a.ts"), built.digest)
    assert.ok(built.digest.includes("+3 -2"), built.digest)
    assert.ok(!built.digest.includes("ALPHA-LINE"), "diff content leaked")
    assert.ok(!built.digest.includes("BETA-LINE"), "diff content leaked")
  })
  it("write without diff metadata falls back to the + sign", () => {
    const built = buildRecapDigest([
      msg("m1", "assistant", [toolCompleted("write", { filePath: "new.ts" })]),
    ])
    assert.ok(built.digest.includes("(+)"), built.digest)
  })
})

describe("buildRecapDigest — text and reasoning", () => {
  it("reasoning parts are dropped entirely", () => {
    const built = buildRecapDigest([
      msg("m1", "assistant", [{ type: "reasoning", text: "CLASSIFIED-THOUGHT" }, textPart("visible")]),
    ])
    assert.ok(built.digest.includes("visible"))
    assert.ok(!built.digest.includes("CLASSIFIED-THOUGHT"))
  })
  it("long text parts are cut with a visible truncation marker", () => {
    const long = "a".repeat(1000)
    const built = buildRecapDigest([msg("m1", "user", [textPart(long)])])
    assert.ok(built.digest.includes("truncated"), built.digest)
    assert.ok(!built.digest.includes("a".repeat(500)), "full text survived")
  })
  it("non-user/assistant roles and empty folds are skipped", () => {
    const built = buildRecapDigest([
      msg("m0", "system", [textPart("sys")]),
      msg("m1", "assistant", [{ type: "step-start" }]),
      msg("m2", "user", [textPart("hello")]),
    ])
    assert.ok(built.digest.includes("hello"))
    assert.ok(!built.digest.includes("sys"))
    assert.equal(built.lastIncludedID, "m2")
  })
})

const markerMsg = (i: number): DigestMessage =>
  msg(`m${i}`, "user", [textPart(`MARKER-${i} ${"b".repeat(60)}`)])

describe("buildRecapDigest — budget window", () => {
  it("overflow drops the HEAD of the window, tail survives; survivors are checkable", () => {
    const built = buildRecapDigest(
      [markerMsg(1), markerMsg(2), markerMsg(3), markerMsg(4), markerMsg(5)],
      { budget: 160 },
    )
    assert.ok(built.truncated)
    assert.ok(!built.digest.includes("MARKER-1"))
    assert.ok(!built.digest.includes("MARKER-2"))
    assert.ok(!built.digest.includes("MARKER-3"))
    assert.ok(built.digest.includes("MARKER-4"))
    assert.ok(built.digest.includes("MARKER-5"))
    assert.equal(built.lastIncludedID, "m5")
  })
  it("everything fitting is not reported as truncated", () => {
    const built = buildRecapDigest([markerMsg(1)], { budget: 10000 })
    assert.equal(built.truncated, false)
    assert.ok(built.digest.includes("MARKER-1"))
  })
  it("result never exceeds budget even when one message alone is giant", () => {
    const giant = msg("giant", "assistant", [
      textPart("z".repeat(5000)),
      ...Array.from({ length: 100 }, () => toolCompleted("bash", { command: "c" })),
    ])
    const built = buildRecapDigest([giant], { budget: 1000 })
    assert.ok(built.digest.length <= 1000, String(built.digest.length))
    assert.ok(built.digest.length > 0)
    assert.ok(built.truncated)
    assert.equal(built.lastIncludedID, "giant")
  })
  it("defaults to the 12000-char budget when options omit it", () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg(`m${i}`, "user", [textPart("c".repeat(400))]),
    )
    const built = buildRecapDigest(messages)
    assert.ok(built.truncated)
    assert.ok(built.digest.length <= 12000, String(built.digest.length))
  })
})

describe("buildRecapDigest — incremental window", () => {
  it("takes only messages AFTER the anchored messageID", () => {
    const built = buildRecapDigest(
      [markerMsg(1), markerMsg(2), markerMsg(3)],
      { afterMessageID: "m2" },
    )
    assert.ok(!built.digest.includes("MARKER-1"))
    assert.ok(!built.digest.includes("MARKER-2"))
    assert.ok(built.digest.includes("MARKER-3"))
    assert.equal(built.lastIncludedID, "m3")
  })
  it("without an anchor the window is the session tail within budget", () => {
    const built = buildRecapDigest(
      [markerMsg(1), markerMsg(2), markerMsg(3)],
      { budget: 10000 },
    )
    for (const i of [1, 2, 3]) assert.ok(built.digest.includes(`MARKER-${i}`))
    assert.equal(built.lastIncludedID, "m3")
  })
  it("anchor missing from the list (e.g. compacted away) falls back to the full tail", () => {
    const built = buildRecapDigest(
      [markerMsg(1), markerMsg(2)],
      { afterMessageID: "ghost", budget: 10000 },
    )
    assert.ok(built.digest.includes("MARKER-1"))
    assert.ok(built.digest.includes("MARKER-2"))
  })
  it("empty window yields an empty digest without truncation", () => {
    const built = buildRecapDigest([markerMsg(1)], { afterMessageID: "m1" })
    assert.equal(built.digest, "")
    assert.equal(built.truncated, false)
    assert.equal(built.lastIncludedID, undefined)
  })
  it("survives junk entries and flat message shapes", () => {
    const built = buildRecapDigest([
      null,
      42,
      "junk",
      { role: "user", id: "flat", parts: [textPart("flat-shape")] },
    ] as unknown as ReadonlyArray<DigestMessage>)
    assert.ok(built.digest.includes("flat-shape"))
    assert.equal(built.lastIncludedID, "flat")
  })
})

describe("buildRecapRequest", () => {
  it("instructs at most two plain sentences with no lists or sections", () => {
    const prompt = buildRecapRequest({ digest: "user: hello" })
    assert.match(prompt, /at most two short sentences/)
    assert.match(prompt, /no headings, no bullets, no lists/)
    assert.ok(prompt.includes("SESSION DIGEST:"))
    assert.ok(prompt.includes("user: hello"))
  })
  it("feeds the previous Recap as its own labeled context block, verbatim", () => {
    const prompt = buildRecapRequest({
      digest: "user: new stuff",
      previousRecap: "**Working on:** earlier thread",
    })
    assert.ok(prompt.includes("PREVIOUS RECAP"))
    assert.ok(prompt.includes("**Working on:** earlier thread"))
    assert.ok(prompt.indexOf("PREVIOUS RECAP") < prompt.indexOf("SESSION DIGEST:"))
  })
  it("marks truncation in the prompt with an explicit line when it happened", () => {
    const withMark = buildRecapRequest({ digest: "d", truncated: true })
    const withoutMark = buildRecapRequest({ digest: "d", truncated: false })
    assert.match(withMark, /truncated/i)
    assert.doesNotMatch(withoutMark, /truncat/i)
  })
})
