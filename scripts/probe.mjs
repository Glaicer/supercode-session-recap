import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { batch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { OpenCode } from "@opencode/client"
import { Recap } from "../dist/rpc.js"

// A file-backed stand-in for the host's plugin storage: the same
// load-mutate-persist-reconcile shape, so in-probe plugin instances can only
// keep state the real TUI would also keep. The directory must exist.
const makeStorage = (directory) => ({
  store: (key, options) => {
    const file = join(directory, `plugin.supercode.recap.tui.${key}.json`)
    const initial = structuredClone(options.initial)
    const load = () => {
      try { return JSON.parse(readFileSync(file, "utf8")) } catch { return structuredClone(initial) }
    }
    const [store, setStore] = createStore(load())
    const update = (mutation) => {
      const draft = load()
      mutation(draft)
      const next = JSON.parse(JSON.stringify(draft))
      writeFileSync(file, `${JSON.stringify(next)}\n`)
      batch(() => setStore(reconcile(next)))
      return Promise.resolve()
    }
    return [store, update]
  },
})


const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const probeRoot = join(tmpdir(), "opencode")
await mkdir(probeRoot, { recursive: true })
const temp = await mkdtemp(join(probeRoot, "recap-v2-probe-"))
const project = join(temp, "project")
const noPlugin = join(temp, "no-plugin")
const config = join(temp, "config")
const requests = []
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const digestRequests = () => requests.filter((request) => JSON.stringify(request).includes("SESSION DIGEST:"))
let toolCalls = 0
let digestCount = 0
const mock = createServer(async (req, res) => {
  // A timed-out or aborted generation leaves nobody to answer: writes to the
  // destroyed socket must stay silent so later mock phases keep working.
  res.on("error", () => {})
  let body = ""
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  requests.push(input)
  const prompt = JSON.stringify(input)
  const event = (delta, finish_reason = null) => ({ id: "mock", object: "chat.completion.chunk", created: 1,
    model: input.model, choices: [{ index: 0, delta, finish_reason }] })
  const send = (payload) => {
    try { res.write(payload) } catch { /* the client aborted the request */ }
  }
  const end = () => {
    try { res.end() } catch { /* the client aborted the request */ }
  }
  const stream = (text) => {
    res.setHeader("content-type", "text/event-stream")
    send(`data: ${JSON.stringify(event({ role: "assistant", content: text }))}\n\n`)
    send(`data: ${JSON.stringify(event({}, "stop"))}\n\n`)
    send("data: [DONE]\n\n")
    end()
  }
  if (prompt.includes("SESSION DIGEST:")) {
    digestCount++
    // Digests 1 and 2 are slow enough to observe the indicator and outlive the
    // timeout; digest 5 answers after the live deletion it was started by.
    // Digest 3 carries markdown so the sidebar's markdown rendering is real.
    if (digestCount === 1) { await sleep(1200); stream("First recap text") }
    else if (digestCount === 2) { await sleep(4000); stream("Late recap text") }
    else if (digestCount === 5) { await sleep(3000); stream("Fifth recap text") }
    else if (prompt.includes("[tool] read")) stream("Tool work recap.")
    else if (digestCount === 3) stream("Third **recap** text")
    else stream(`Recap text ${digestCount}`)
  } else if (prompt.includes("Use read tool") && toolCalls === 0) {
    toolCalls++
    const names = Array.isArray(input.tools)
      ? input.tools.map((tool) => tool.function?.name ?? tool.name)
      : Object.keys(input.tools ?? {})
    const name = names.find((key) => key === "read" || key.endsWith("_read"))
    assert(name, `Read tool missing from model request: ${names}`)
    res.setHeader("content-type", "text/event-stream")
    send(`data: ${JSON.stringify(event({ tool_calls: [{ index: 0, id: "call_recap_probe", type: "function",
      function: { name, arguments: JSON.stringify({ path: "README.md" }) } }] }))}\n\n`)
    send(`data: ${JSON.stringify(event({}, "tool_calls"))}\n\n`)
    send("data: [DONE]\n\n")
    end()
  } else {
    stream("The sidebar is fixed.")
  }
})
await new Promise((ok) => mock.listen(0, "127.0.0.1", ok))
const modelPort = mock.address().port
await mkdir(project, { recursive: true })
await mkdir(noPlugin, { recursive: true })
await writeFile(join(project, "README.md"), "Probe project fixture.\n")
await mkdir(join(config, "opencode"), { recursive: true })
const install = join(temp, "install")
await mkdir(install, { recursive: true })
execFileSync("npm", ["pack", "--pack-destination", install], { cwd: root, stdio: "ignore" })
const archives = (await readdir(install)).filter((name) => name.endsWith(".tgz"))
assert.equal(archives.length, 1)
const archive = join(install, archives[0])
const installed = join(temp, "node_modules", "@glaicer", "supercode-session-recap")
await mkdir(installed, { recursive: true })
execFileSync("tar", ["-xzf", archive, "-C", installed, "--strip-components=1"], { stdio: "pipe" })
await symlink(join(root, "node_modules"), join(installed, "node_modules"), "dir")
const { default: tuiPlugin } = await import(pathToFileURL(join(installed, "tui.js")).href)
const storages = join(temp, "storages")
await mkdir(join(storages, "child"), { recursive: true })
await mkdir(join(storages, "digest"), { recursive: true })
await mkdir(join(storages, "lifecycle"), { recursive: true })
await mkdir(join(storages, "reload"), { recursive: true })
await mkdir(join(storages, "hung"), { recursive: true })
let onSuccess
let childCalls = 0
const disposeChild = tuiPlugin.setup({
  options: {},
  storage: makeStorage(join(storages, "child")),
  client: { rpc: () => ({ summarize: () => { childCalls++; return { text: "unexpected" } } }) },
  data: {
    on: (type, handler) => { if (type === "session.execution.succeeded") onSuccess = handler; return () => {} },
    session: { get: () => ({ id: "child", parentID: "root" }) },
  },
  ui: { slot: () => () => {} },
})
onSuccess({ data: { sessionID: "child" } })
assert.equal(childCalls, 0)
disposeChild()
await writeFile(join(project, "opencode.json"), JSON.stringify({
  model: "recap-probe/project-only",
  plugins: [{ package: installed, options: { timeout_ms: 2000 } }],
  providers: { "recap-probe": { name: "Recap probe", env: ["RECAP_PROBE_KEY"],
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${modelPort}/v1` },
    models: { "project-only": { name: "Project only" } } } },
}))
const password = "recap-probe-password"
const env = { ...process.env, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(temp, "data"),
  XDG_CACHE_HOME: join(temp, "cache"), XDG_STATE_HOME: join(temp, "state"),
  OPENCODE_DB: join(temp, "database.sqlite"), OPENCODE_SERVER_PASSWORD: password,
  RECAP_PROBE_KEY: "test-only", TERM: "xterm-256color", COLORTERM: "truecolor" }
delete env.OPENCODE_CONFIG_DIR
delete env.ORCA_OPENCODE_CONFIG_DIR
const port = 19000 + Math.floor(Math.random() * 10000)
const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "debug"],
  { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
let logs = ""
server.stdout.on("data", (b) => logs += b)
server.stderr.on("data", (b) => logs += b)
try {
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
  for (let i = 0; i < 100; i++) {
    try { await client.server.info(); break } catch { await sleep(200) }
    if (i === 99) throw new Error(`Server did not start: ${logs}`)
  }
  const location = { directory: project }
  const before = await client.session.list({ location })
  const output = await client.rpc(Recap).summarize({ prompt: "SESSION DIGEST:\nuser: Fix sidebar" }, { location })
  const plugins = await client.plugin.list({ location })
  assert(plugins.data.some((p) => p.id === "supercode.recap.server"), `${JSON.stringify(plugins)}\n${logs}`)
  assert.deepEqual(output, { text: "First recap text", warnings: [] })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, "project-only")
  assert.equal(requests[0].tools, undefined)
  const after = await client.session.list({ location })
  assert.deepEqual(after.data, before.data)
  // Reset the controlled endpoint's digest numbering so the PTY phase sees a
  // known sequence starting at digest 1.
  requests.length = 0
  digestCount = 0
  // A location without the server component must fail loudly instead of
  // silently generating through some global or default model.
  const requestsBeforeUnavailable = requests.length
  await assert.rejects(
    client.rpc(Recap).summarize({ prompt: "SESSION DIGEST:\nuser: no companion" }, { location: { directory: noPlugin } }),
    // Host RPC failures arrive as plain { type, message } objects, not Errors.
    (error) => typeof error?.message === "string" && error.message.includes("RPC is unavailable"),
  )
  assert.equal(requests.length, requestsBeforeUnavailable, "an unavailable RPC must not fall back to a model call")
  const session = await client.session.create({ location })
  const startTui = () => {
    const child = spawn("python3", [join(root, "scripts", "probe-pty.py"), "opencode", "--server",
      `http://127.0.0.1:${port}`, "--session", session.id, project], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] })
    child.stdout.on("data", recordScreen)
    child.stderr.on("data", recordScreen)
    return child
  }
  let screen = ""
  let toolShown = false
  let historyMessages = 0
  const recordScreen = (bytes) => {
    screen = (screen + bytes).slice(-500_000)
    const start = screen.lastIndexOf("Tool wo")
    if (start >= 0) toolShown ||= /Tool wo\x1b\[0m\x1b\[6;129H[^\n]*k recap\./.test(screen.slice(start, start + 200))
  }
  let tui = startTui()
  // What the user actually sees: escape sequences (including the SGR color
  // changes inside a markdown-rendered recap) stripped away.
  const visible = (frame) => frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
  const waitFor = async (value) => {
    for (let i = 0; i < 150; i++) {
      if (visible(screen).includes(value) || (value === "Tool work recap." && toolShown)) return
      if (tui.exitCode !== null) break
      await sleep(200)
    }
    throw new Error(`TUI did not show ${value}: ${screen.slice(-6000)}`)
  }
  // The renderer emits diffs, so a changed sidebar line only contains its
  // changed cells. Resizing forces a full repaint: bytes captured after this
  // point are the whole current frame, which makes both presence and absence
  // checks meaningful. The value is first located, then captured again from a
  // single fresh repaint so stale frames cannot satisfy absence checks.
  const waitForRepaint = async (value, cols = 220) => {
    const shown = () => (typeof value === "function" ? value(screen) : visible(screen).includes(value))
    const deadline = Date.now() + 60_000
    let round = 0
    const capture = async () => {
      screen = ""
      tui.stdin.write(`resize ${round++ % 2 ? 50 : 49} ${cols}\n`)
      for (let i = 0; i < 25 && Date.now() < deadline; i++) {
        if (shown()) return true
        if (tui.exitCode !== null) return false
        await sleep(200)
      }
      return false
    }
    while (Date.now() < deadline) {
      if (!(await capture())) continue
      if (!(await capture())) continue
      // Let the rest of the frame flush before callers assert absence.
      await sleep(400)
      return
    }
    const failure = new Error(`TUI never repainted ${typeof value === "function" ? "the state" : value}: ${screen.slice(-6000)}`)
    // Diagnostic escape hatch: the whole last frame, for offline inspection.
    const { writeFileSync: dumpFrame } = await import("node:fs")
    try { dumpFrame("/tmp/opencode/probe-screen.bin", screen) } catch {}
    throw failure
  }
  // Full-repaint frames are positioned text: split one into (row, col, text)
  // runs so the probe can locate sidebar UI — and its colors — in the stream.
  const frameRuns = (frame) => {
    const marked = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, (sequence) => {
      const cup = /^\x1b\[(\d+);(\d+)H$/.exec(sequence)
      return cup ? `\x00${cup[1]},${cup[2]}\x00` : ""
    })
    const runs = []
    let row = 1
    let col = 1
    let text = ""
    const flush = () => {
      const clean = text.replace(/[\r\n]/g, "")
      if (clean) runs.push({ row, col, text: clean })
      text = ""
    }
    for (const piece of marked.split("\x00")) {
      const position = /^(\d+),(\d+)$/.exec(piece)
      if (position) { flush(); row = Number(position[1]); col = Number(position[2]) }
      else text += piece
    }
    flush()
    return runs
  }
  // The Recap header as painted: where the "Recap" label sits and which arrow
  // it shows, so a mouse click can target it. The box gap paints a space run
  // between arrow and label, so scan every run in the few columns left of the
  // label rather than just the immediately preceding one.
  const recapHeader = (frame) => {
    const runs = frameRuns(frame)
    const label = runs.find((run) => run.text.includes("Recap"))
    if (!label) return undefined
    const offset = label.text.indexOf("Recap")
    const left = runs
      .filter((run) => run.row === label.row
        && run.col + run.text.length > label.col + offset - 4
        && run.col < label.col + offset)
      .sort((a, b) => a.col - b.col)
    const around = `${left.map((run) => run.text).join("")}${label.text}`
    return {
      row: label.row,
      col: label.col + offset,
      arrow: around.includes("▼") ? "▼" : around.includes("▶") ? "▶" : undefined,
    }
  }
  // The SGR color active right before a pattern match in the raw frame —
  // truecolor or 256-color. The recap body interleaves escapes (bold spans),
  // so callers pass a regex, not a literal.
  const colorBefore = (frame, pattern) => {
    const at = pattern.exec(frame)?.index
    if (at === undefined) return undefined
    const colors = [...frame.slice(0, at).matchAll(/\x1b\[[0-9;]*(?:38;2;(\d+);(\d+);(\d+)|38;5;(\d+))[0-9;]*m/g)]
    const last = colors.at(-1)
    return last ? last.slice(1).filter(Boolean).join(".") : undefined
  }
  // The live TUI persists plugin storage under its isolated state root.
  const findTuiStorage = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name)
      if (entry.isFile() && entry.name === "plugin.supercode.recap.tui.sidebar.json") return path
      if (entry.isDirectory()) {
        const nested = await findTuiStorage(path)
        if (nested) return nested
      }
    }
    return undefined
  }
  try {
    await waitFor("Recap")
    // The slot is registered after the first paint; force one so the waiting
    // state (and everything else the section renders) is actually on screen.
    // The hint wraps in the ~40-column sidebar, so match its first line.
    await waitForRepaint("Recap appears after the session's")
    await client.session.prompt({ sessionID: session.id, text: "Fix the sidebar", location })
    await waitFor("Generating recap")
    await waitForRepaint("First recap text")
    assert(!screen.includes("Generating recap"), "the indicator must clear once the recap is stored")
    await client.session.prompt({ sessionID: session.id, text: "Second prompt", location })
    await waitFor("Generating recap")
    await waitFor("timed out after 2000ms")
    assert(screen.includes("First recap text"), "a timeout must keep the last successful recap")
    // Digest 2 answers at 4000ms — past the local timeout — and must be discarded.
    await sleep(3200)
    await waitForRepaint("First recap text")
    assert(!screen.includes("Generating recap"), "the indicator must clear on timeout")
    assert(!screen.includes("Late recap text"), "a late answer after the local timeout must never be shown")
    await client.session.prompt({ sessionID: session.id, text: "Third prompt", location })
    for (let i = 0; i < 25 && digestRequests().length < 3; i++) await sleep(200)
    await waitForRepaint("Third recap text")
    // Digest 3 carries markdown: the sidebar must render it (concealed
    // markers) rather than echoing the raw text.
    assert(!visible(screen).includes("**"), "markdown markers must be concealed in the sidebar")
    // "recap" is a bold span, so the color probe tolerates interleaved escapes.
    const recapColor = (frame) => colorBefore(frame, /Third (?:\x1b\[[0-9;?]*[A-Za-z])*recap/)
    const darkColor = recapColor(screen)
    assert(darkColor, "the recap must paint with a theme color")
    // Narrow and wide terminals must both keep the section readable. Below
    // ~120 columns the host turns the sidebar into a hidden overlay, so the
    // narrow check uses 130 — the narrowest width that still shows it inline.
    await waitForRepaint("Third recap text", 130)
    await waitForRepaint("Third recap text")
    // A live terminal theme switch must recolor the section, not break it.
    tui.stdin.write("theme light\n")
    await waitForRepaint("Third recap text")
    const lightColor = recapColor(screen)
    assert(lightColor, "the recap must still paint after the theme switch")
    assert.notEqual(lightColor, darkColor, `a theme switch must recolor the recap: ${darkColor} -> ${lightColor}`)
    const transferred = await client.session.export({ sessionID: session.id, location })
    // Import inserts message IDs verbatim, so reusing the parent's settled
    // history collides with its rows; the child only needs to exist and run.
    const child = await client.session.import({
      info: { ...transferred.info, id: `ses_${randomBytes(12).toString("hex")}`, parentID: session.id },
      messages: [],
      location,
    })
    await client.session.prompt({ sessionID: child.id, text: "Inspect the child session", location })
    await client.session.wait({ sessionID: child.id, location })
    await sleep(500)
    assert.equal(digestRequests().length, 3, "child execution must not trigger a digest")
    await client.session.prompt({ sessionID: session.id, text: "Use read tool to inspect README.md", location })
    await client.session.wait({ sessionID: session.id, location })
    const toolHistoryLive = await client.session.context({ sessionID: session.id, location })
    assert(toolHistoryLive.some((message) => message.type === "assistant" && message.content.some(
      (part) => part.type === "tool" && part.name === "read" && part.state.status === "completed",
    )), JSON.stringify(toolHistoryLive.slice(-3)).slice(-3000))
    for (let i = 0; i < 50 && digestRequests().length < 4; i++) await sleep(200)
    const liveToolRecap = digestRequests().at(-1)
    assert(JSON.stringify(liveToolRecap).includes("[tool] read"), JSON.stringify({
      count: digestRequests().length,
      last: JSON.stringify(liveToolRecap).slice(-1800),
    }))
    await waitForRepaint("Tool work recap.")
    assert.equal(toolCalls, 1)
    const history = await client.session.context({ sessionID: session.id, location })
    historyMessages = history.length
    assert(history.some((message) => message.type === "assistant" && message.content.some((p) => p.type === "text" && p.text === "The sidebar is fixed.")))
    const recapTexts = ["First recap text", "Late recap text", "Third recap text", "Tool work recap."]
    assert(!history.some((message) => message.type === "assistant" && message.content.some(
      (p) => p.type === "text" && recapTexts.includes(p.text),
    )), "no Recap text may enter History")
    assert.equal((await client.session.list({ location })).data.length, 2)
    const recaps = digestRequests()
    assert.equal(recaps.length, 4)
    assert(recaps.every((request) => request.tools === undefined))
    assert(recaps.every((request) => request.model === "project-only"))
    const first = JSON.stringify(recaps[0])
    assert(!first.includes("PREVIOUS RECAP"), first)
    const timedOut = JSON.stringify(recaps[1])
    assert(timedOut.includes("PREVIOUS RECAP"), timedOut)
    assert(timedOut.includes("First recap text"), timedOut)
    const third = JSON.stringify(recaps[2])
    assert(third.includes("PREVIOUS RECAP"), third)
    assert(third.includes("First recap text"), third)
    assert(third.includes("Second prompt"), "the timed-out window must stay in the next digest")
    assert(third.includes("Third prompt"), third)
    const toolRecap = JSON.stringify(recaps[3])
    assert(toolRecap.includes("[tool] read"), toolRecap)
    // --- sidebar: collapse, persisted choice, restart, waiting state ---
    await waitForRepaint("Tool work recap.")
    const header = recapHeader(screen)
    if (!header || header.arrow !== "▼") {
      const { writeFileSync: dumpFrame } = await import("node:fs")
      dumpFrame("/tmp/opencode/probe-header.bin", screen)
    }
    assert(header, `the sidebar must paint the Recap header: ${screen.slice(-1200)}`)
    assert.equal(header.arrow, "▼", `an untouched section starts expanded: ${JSON.stringify(header)}`)
    tui.stdin.write(`mouse ${header.col} ${header.row}\n`)
    await waitForRepaint((frame) => recapHeader(frame)?.arrow === "▶")
    assert(!visible(screen).includes("Tool work recap."), "collapsing must hide the recap body")
    // The choice is durable host storage; the recap text itself is not.
    const storageFile = await findTuiStorage(join(temp, "state"))
    assert(storageFile, "the collapse choice must be persisted by the TUI host")
    assert.deepEqual(JSON.parse(await readFile(storageFile, "utf8")), { expanded: false })
    // Restart the TUI against the same session: the choice survives, the
    // recap text does not.
    tui.kill()
    await new Promise((resolve) => { tui.once("exit", resolve); tui.once("error", resolve) })
    screen = ""
    tui = startTui()
    await waitFor("Recap")
    await waitForRepaint((frame) => recapHeader(frame)?.arrow === "▶")
    assert(!visible(screen).includes("Tool work recap."), "a restarted TUI must not resurrect the recap text")
    assert(!visible(screen).includes("Recap appears after"), "a collapsed section hides the waiting hint")
    const restarted = recapHeader(screen)
    assert(restarted, "the restarted TUI must paint the Recap header")
    tui.stdin.write(`mouse ${restarted.col} ${restarted.row}\n`)
    await waitForRepaint((frame) => recapHeader(frame)?.arrow === "▼")
    await waitFor("Recap appears after the session's")
    // In-flight deletion through the live host: the release must not wait for
    // the timeout, the late answer must be discarded and no failure reported.
    const deletionDigest = digestRequests().length + 1
    await client.session.prompt({ sessionID: session.id, text: "Delete me mid-flight", location })
    for (let i = 0; i < 25 && digestRequests().length < deletionDigest; i++) await sleep(200)
    assert.equal(digestRequests().length, deletionDigest, "the deletion prompt must start a digest")
    screen = ""
    await client.session.remove({ sessionID: session.id, location })
    // Digest 5 answers at 3000ms, after the deletion.
    await sleep(3500)
    assert(!screen.includes("Fifth recap text"), "a deleted session's late answer must not surface")
    assert(!screen.includes("timed out"), "deleting a session must release the wait without a timeout toast")
  } finally {
    tui.kill()
  }
  const toolHistory = [
    { id: "m1", type: "user", text: "Check the tests" },
    { id: "m2", type: "assistant", content: [{ type: "tool", name: "bash", state: {
      status: "completed", input: { command: "npm test" }, content: [{ type: "text", text: "47 tests passed\nlarge private output" }],
    } }], snapshot: { files: ["src/app.ts"] } },
  ]
  let completed
  let empty = false
  let fail = false
  let calls = 0
  const toasts = []
  let onDigestSuccess
  let onDeleted
  const stopDigest = tuiPlugin.setup({
    options: { budget: 160 },
    storage: makeStorage(join(storages, "digest")),
    client: { rpc: () => ({
      // Older servers may not answer settings; the local budget must then apply.
      settings: async () => { throw new Error("settings unavailable") },
      summarize: async (input, options) => {
        calls++
        try {
          if (fail) throw new Error("temporary generation failure")
          if (empty) return { text: "", warnings: [] }
          const response = await client.rpc(Recap).summarize(input, options)
          return calls === 1 ? { ...response, text: `${response.text} ${"x".repeat(300)} LAST-CONTEXT` } : response
        } finally { completed() }
      },
    }) },
    data: {
      on: (type, handler) => {
        if (type === "session.execution.succeeded") onDigestSuccess = handler
        if (type === "session.deleted") onDeleted = handler
        return () => {}
      },
      session: {
        get: () => ({ id: session.id, location }),
        message: { sync: async () => {}, list: () => toolHistory },
      },
    },
    ui: { slot: () => () => {}, toast: { show: (toast) => toasts.push(toast) } },
  })
  const triggerDigest = async (expectsCall = true) => {
    const done = expectsCall
      ? Promise.race([
        new Promise((resolve) => { completed = resolve }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Recap RPC was not called")), 5000)),
      ])
      : sleep(50)
    onDigestSuccess({ data: { sessionID: session.id } })
    await done
    await new Promise((resolve) => setImmediate(resolve))
  }
  try {
    await triggerDigest()
    const toolRequest = JSON.stringify(requests.at(-1))
    assert(toolRequest.includes("[tool] bash npm test -> ok: 47 tests passed"), toolRequest)
    assert(toolRequest.includes("[file] src/app.ts"), toolRequest)
    assert(!toolRequest.includes("large private output"), toolRequest)
    assert(!toolRequest.includes("PREVIOUS RECAP"), toolRequest)
    await triggerDigest(false)
    assert.equal(calls, 1, "empty incremental window must not call the model")
    toolHistory.push({ id: "m3", type: "user", text: "New task" })
    empty = true
    await triggerDigest()
    assert.equal(calls, 2)
    assert(toasts.some((toast) => toast.variant === "error" && toast.message.includes("empty response")))
    empty = false
    fail = true
    await triggerDigest()
    assert.equal(calls, 3)
    fail = false
    await triggerDigest()
    assert.equal(calls, 4)
    const retryRequest = JSON.stringify(requests.at(-1))
    assert(retryRequest.includes("New task"), retryRequest)
    assert(retryRequest.includes("PREVIOUS RECAP"), retryRequest)
    assert(retryRequest.includes("LAST-CONTEXT"), retryRequest)
    assert(retryRequest.includes("…"), retryRequest)
    assert(!retryRequest.includes("Recap text"), retryRequest)
    assert(!retryRequest.includes("Check the tests"), retryRequest)
    assert(!retryRequest.includes("[tool] bash"), retryRequest)
    onDeleted({ data: { sessionID: session.id } })
    toolHistory.push({ id: "m4", type: "user", text: "Follow-up" })
    await triggerDigest()
    assert.equal(calls, 5)
    const clearedRequest = JSON.stringify(requests.at(-1))
    assert(clearedRequest.includes("Check the tests"), clearedRequest)
    assert(clearedRequest.includes("Follow-up"), clearedRequest)
    assert(!clearedRequest.includes("PREVIOUS RECAP"), clearedRequest)
    assert(!clearedRequest.includes("LAST-CONTEXT"), clearedRequest)
  } finally { stopDigest() }
  // --- lifecycle: re-entry, per-session isolation, RPC loss, deletion, unload ---
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
  }
  const makeLifecycleHarness = (settingsImpl, storageKey = "lifecycle") => {
    const state = {
      toasts: [], calls: [], stops: { success: 0, deleted: 0, slot: 0 },
      settingsCalls: 0, settingsLocations: [], settingsOptions: undefined,
      sessions: new Map(), histories: new Map(), onSuccess: undefined, onDeleted: undefined,
      failNext: undefined, render: undefined,
    }
    const dispose = tuiPlugin.setup({
      // Local values are deliberately hostile: the server's settings, bound to
      // the generation timeout, must win over them.
      options: { budget: 1, timeout_ms: 500 },
      storage: makeStorage(join(storages, storageKey)),
      client: { rpc: () => ({
        settings: settingsImpl ?? (async (_input, rpcOptions) => {
          state.settingsCalls += 1
          state.settingsLocations.push(rpcOptions?.location?.directory)
          state.settingsOptions = rpcOptions
          return { budget: 1000, timeout_ms: 5000 }
        }),
        summarize: (input, rpcOptions) => new Promise((resolve, reject) => {
          if (state.failNext) {
            const message = state.failNext
            state.failNext = undefined
            reject({ type: "rpc.unavailable", message })
            return
          }
          state.calls.push({ prompt: input.prompt, rpcOptions, resolve, reject })
        }),
      }) },
      data: {
        on: (type, handler) => {
          if (type === "session.execution.succeeded") state.onSuccess = handler
          if (type === "session.deleted") state.onDeleted = handler
          return () => {
            if (type === "session.execution.succeeded") state.stops.success += 1
            if (type === "session.deleted") state.stops.deleted += 1
          }
        },
        session: {
          get: (id) => state.sessions.get(id),
          message: { sync: async () => {}, list: (id) => state.histories.get(id) ?? [] },
        },
      },
      ui: {
        slot: (claim) => { state.render = claim.render; return () => { state.stops.slot += 1 } },
        toast: { show: (toast) => state.toasts.push(toast) },
      },
    })
    return { state, dispose }
  }
  const lifecycle = makeLifecycleHarness(undefined, "lifecycle")
  const a = { id: "root-a", location }
  const b = { id: "root-b", location: { directory: join(project, "elsewhere") } }
  lifecycle.state.sessions.set(a.id, a)
  lifecycle.state.sessions.set(b.id, b)
  lifecycle.state.histories.set(a.id, [{ id: "a1", type: "user", text: "alpha work" }])
  lifecycle.state.histories.set(b.id, [{ id: "b1", type: "user", text: "beta work" }])
  lifecycle.state.onSuccess({ data: { sessionID: a.id } })
  lifecycle.state.onSuccess({ data: { sessionID: a.id } })
  await settle()
  assert.equal(lifecycle.state.calls.length, 1, "a repeated completion during generation must not start a second call")
  assert(lifecycle.state.calls[0].prompt.includes("alpha work"))
  assert.equal(lifecycle.state.settingsCalls, 1, "the server settings must be fetched once")
  assert.deepEqual(lifecycle.state.settingsLocations, [location.directory],
    "the settings call must be routed to the session's location")
  assert(lifecycle.state.settingsOptions.signal instanceof AbortSignal, "the settings call must carry an abort signal")
  await sleep(700)
  assert(!lifecycle.state.toasts.some((toast) => toast.message.includes("timed out")),
    "the server timeout_ms must win over the local option")
  assert.equal(lifecycle.state.calls.length, 1, "the generation must still be waiting on the model")
  lifecycle.state.onSuccess({ data: { sessionID: b.id } })
  await settle()
  assert.equal(lifecycle.state.calls.length, 2, "a second root session must generate in parallel")
  assert(lifecycle.state.calls[1].prompt.includes("beta work"))
  assert(!lifecycle.state.calls[1].prompt.includes("alpha work"))
  assert.deepEqual(lifecycle.state.settingsLocations, [location.directory, b.location.directory],
    "each location resolves its own settings once")
  lifecycle.state.calls[1].resolve({ text: "Recap B", warnings: [] })
  await settle()
  lifecycle.state.histories.get(b.id).push({ id: "b2", type: "user", text: "beta follow-up" })
  lifecycle.state.onSuccess({ data: { sessionID: b.id } })
  await settle()
  assert.equal(lifecycle.state.calls.length, 3, "one finished session must not block another")
  const bSecond = lifecycle.state.calls[2]
  assert(bSecond.prompt.includes("beta follow-up"))
  assert(bSecond.prompt.includes("PREVIOUS RECAP"))
  assert(bSecond.prompt.includes("Recap B"))
  assert(!bSecond.prompt.includes("alpha work"), "a session window must not leak another session's messages")
  bSecond.resolve({ text: "Recap B2", warnings: [] })
  await settle()
  lifecycle.state.calls[0].resolve({ text: "Recap A", warnings: [] })
  await settle()
  lifecycle.state.histories.get(a.id).push({ id: "a2", type: "user", text: "alpha follow-up" })
  lifecycle.state.onSuccess({ data: { sessionID: a.id } })
  await settle()
  const aSecond = lifecycle.state.calls[3]
  assert(aSecond.prompt.includes("Recap A"))
  assert(!aSecond.prompt.includes("beta work"))
  aSecond.resolve({ text: "Recap A2", warnings: [] })
  await settle()
  // an unavailable RPC reports itself and must not skip the window it failed on
  lifecycle.state.histories.get(a.id).push({ id: "a3", type: "user", text: "alpha after rpc loss" })
  lifecycle.state.failNext = "RPC is unavailable: supercode.recap"
  lifecycle.state.onSuccess({ data: { sessionID: a.id } })
  await settle()
  assert(lifecycle.state.toasts.some((toast) => toast.variant === "error" && toast.message.includes("RPC is unavailable")),
    JSON.stringify(lifecycle.state.toasts))
  assert.equal(lifecycle.state.calls.length, 4, "an unavailable RPC must not fall back to a model call")
  lifecycle.state.onSuccess({ data: { sessionID: a.id } })
  await settle()
  const aRecovery = lifecycle.state.calls[4]
  assert(aRecovery.prompt.includes("alpha after rpc loss"), "the failed window must not be skipped")
  assert(aRecovery.prompt.includes("PREVIOUS RECAP"))
  assert(aRecovery.prompt.includes("Recap A2"))
  aRecovery.resolve({ text: "Recap A3", warnings: [] })
  await settle()
  // deleting a session mid-generation releases the wait and drops its state
  const c = { id: "root-c", location }
  lifecycle.state.sessions.set(c.id, c)
  lifecycle.state.histories.set(c.id, [{ id: "c1", type: "user", text: "gamma work" }])
  lifecycle.state.onSuccess({ data: { sessionID: c.id } })
  await settle()
  const cFirst = lifecycle.state.calls.at(-1)
  const toastsBeforeDelete = lifecycle.state.toasts.length
  lifecycle.state.onDeleted({ data: { sessionID: c.id } })
  // The host stops serving a deleted session; the plugin must both abort its
  // local wait and refuse to store what the aborted call later returns.
  lifecycle.state.sessions.delete(c.id)
  assert.equal(cFirst.rpcOptions.signal.aborted, true, "deleting a session must release its local wait")
  cFirst.resolve({ text: "Late gamma", warnings: [] })
  await settle()
  assert.equal(lifecycle.state.toasts.length, toastsBeforeDelete, "a deleted session's answer must not be reported")
  lifecycle.state.sessions.set(c.id, c)
  lifecycle.state.histories.get(c.id).push({ id: "c2", type: "user", text: "gamma restart" })
  lifecycle.state.onSuccess({ data: { sessionID: c.id } })
  await settle()
  const cSecond = lifecycle.state.calls.at(-1)
  assert(cSecond.prompt.includes("gamma work"), "deleting a session must drop its anchor")
  assert(cSecond.prompt.includes("gamma restart"))
  assert(!cSecond.prompt.includes("PREVIOUS RECAP"), "deleting a session must drop its last successful recap")
  assert(!cSecond.prompt.includes("Late gamma"), "an aborted call's late answer must not become state")
  cSecond.resolve({ text: "Recap C", warnings: [] })
  await settle()
  // unloading releases subscriptions and the slot, and a late answer from the
  // old generation must not appear as state of the next one
  lifecycle.state.histories.get(a.id).push({ id: "a4", type: "user", text: "alpha before unload" })
  lifecycle.state.onSuccess({ data: { sessionID: a.id } })
  await settle()
  const aUnloaded = lifecycle.state.calls.at(-1)
  const reloaded = makeLifecycleHarness(undefined, "reload")
  reloaded.state.sessions.set(a.id, a)
  reloaded.state.histories.set(a.id, [{ id: "r1", type: "user", text: "fresh after reload" }])
  lifecycle.dispose()
  assert.equal(aUnloaded.rpcOptions.signal.aborted, true, "unloading must release the local wait")
  assert.deepEqual(lifecycle.state.stops, { success: 1, deleted: 1, slot: 1 },
    "unloading must release every subscription and the slot registration")
  const toastsAtUnload = lifecycle.state.toasts.length
  aUnloaded.resolve({ text: "Late reload text", warnings: [] })
  await settle()
  assert.equal(lifecycle.state.toasts.length, toastsAtUnload, "a disposed generation must stay silent")
  reloaded.state.onSuccess({ data: { sessionID: a.id } })
  await settle()
  const fresh = reloaded.state.calls[0]
  assert(fresh.prompt.includes("fresh after reload"))
  assert(!fresh.prompt.includes("PREVIOUS RECAP"), "a new generation must start with empty state")
  assert(!fresh.prompt.includes("Late reload text"), "the old generation must not write into the new one")
  fresh.resolve({ text: "Recap fresh", warnings: [] })
  await settle()
  reloaded.dispose()
  assert.equal(lifecycle.state.settingsCalls, 2, "server settings stay cached per location")
  // a settings fetch that never answers must end the local wait and retry later
  let hungSettings = 0
  const hung = makeLifecycleHarness((_input, rpcOptions) => {
    hungSettings += 1
    if (hungSettings > 1) return Promise.resolve({ budget: 1000, timeout_ms: 5000 })
    return new Promise((_, reject) => {
      rpcOptions.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    })
  }, "hung")
  hung.state.sessions.set(a.id, a)
  hung.state.histories.set(a.id, [{ id: "h1", type: "user", text: "hung settings" }])
  hung.state.onSuccess({ data: { sessionID: a.id } })
  await sleep(700)
  assert(hung.state.toasts.some((toast) => toast.message.includes("timed out")),
    "a hung settings fetch must end the local wait")
  assert.equal(hung.state.calls.length, 0, "a hung settings fetch must never reach the model")
  hung.state.onSuccess({ data: { sessionID: a.id } })
  await settle()
  assert.equal(hung.state.calls.length, 1, "a failed settings fetch must be retried")
  hung.state.calls[0].resolve({ text: "Recap after hung settings", warnings: [] })
  await settle()
  hung.dispose()
  console.log(JSON.stringify({ installed, model: digestRequests().at(-1).model, sidebarText: "Tool work recap.",
    sessions: 2, childIgnored: true, historyMessages, providerRequests: requests.length, sidebarUpdated: true,
    waitingStateShown: true, markdownConcealed: true, narrowTerminalReadable: true, themeSwitchRecolored: true,
    collapseClickWorked: true, choicePersistedAcrossRestart: true, recapTextNotPersisted: true,
    indicatorClearedOnSuccess: true, indicatorClearedOnTimeout: true, timedOutWindowRetried: true, lateAnswerDiscarded: true,
    liveDeletionReleasedWait: true, unavailableRpcRejected: true, deletionClearedState: true, timeoutEndedLocalWait: true,
    reentrySingleGeneration: true, sessionIsolation: true, settingsLocationRouted: true, settingsCachePerLocation: true,
    rpcUnavailableFeedback: true, deletedSessionLateAnswerSilent: true, unloadReleasedRegistrations: true,
    unloadAbortedWait: true, newGenerationStateClean: true, hungSettingsBounded: true }, null, 2))
} catch (error) {
  console.error(logs.slice(-3000))
  throw error
} finally {
  server.kill()
  mock.close()
}
