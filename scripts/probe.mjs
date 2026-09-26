import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import { Recap } from "../dist/rpc.js"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const probeRoot = join(tmpdir(), "opencode")
await mkdir(probeRoot, { recursive: true })
const temp = await mkdtemp(join(probeRoot, "recap-v2-probe-"))
const project = join(temp, "project")
const config = join(temp, "config")
const requests = []
let toolCalls = 0
const mock = createServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  requests.push(input)
  const prompt = JSON.stringify(input)
  const toolDigest = prompt.includes("[tool] read")
  const text = prompt.includes("SESSION DIGEST:")
    ? toolDigest ? "Tool work recap." : "Recap from project model."
    : "The sidebar is fixed."
  res.setHeader("content-type", "text/event-stream")
  const event = (delta, finish_reason = null) => ({ id: "mock", object: "chat.completion.chunk", created: 1,
    model: input.model, choices: [{ index: 0, delta, finish_reason }] })
  if (prompt.includes("Use read tool") && !prompt.includes("SESSION DIGEST:") && toolCalls === 0) {
    toolCalls++
    const names = Array.isArray(input.tools)
      ? input.tools.map((tool) => tool.function?.name ?? tool.name)
      : Object.keys(input.tools ?? {})
    const name = names.find((key) => key === "read" || key.endsWith("_read"))
    assert(name, `Read tool missing from model request: ${names}`)
    res.write(`data: ${JSON.stringify(event({ tool_calls: [{ index: 0, id: "call_recap_probe", type: "function",
      function: { name, arguments: JSON.stringify({ path: "README.md" }) } }] }))}\n\n`)
    res.write(`data: ${JSON.stringify(event({}, "tool_calls"))}\n\n`)
  } else {
    res.write(`data: ${JSON.stringify(event({ role: "assistant", content: text }))}\n\n`)
    res.write(`data: ${JSON.stringify(event({}, "stop"))}\n\n`)
  }
  res.end("data: [DONE]\n\n")
})
await new Promise((ok) => mock.listen(0, "127.0.0.1", ok))
const modelPort = mock.address().port
await mkdir(project, { recursive: true })
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
let onSuccess
let childCalls = 0
const disposeChild = tuiPlugin.setup({
  options: {},
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
  plugins: [{ package: installed, options: {} }],
  providers: { "recap-probe": { name: "Recap probe", env: ["RECAP_PROBE_KEY"],
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${modelPort}/v1` },
    models: { "project-only": { name: "Project only" } } } },
}))
const password = "recap-probe-password"
const env = { ...process.env, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(temp, "data"),
  XDG_CACHE_HOME: join(temp, "cache"), XDG_STATE_HOME: join(temp, "state"),
  OPENCODE_DB: join(temp, "database.sqlite"), OPENCODE_SERVER_PASSWORD: password,
  RECAP_PROBE_KEY: "test-only", TERM: "xterm-256color" }
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
    try { await client.server.info(); break } catch { await new Promise((ok) => setTimeout(ok, 200)) }
    if (i === 99) throw new Error(`Server did not start: ${logs}`)
  }
  const location = { directory: project }
  const before = await client.session.list({ location })
  const output = await client.rpc(Recap).summarize({ prompt: "SESSION DIGEST:\nuser: Fix sidebar" }, { location })
  const plugins = await client.plugin.list({ location })
  assert(plugins.data.some((p) => p.id === "supercode.recap.server"), `${JSON.stringify(plugins)}\n${logs}`)
  assert.deepEqual(output, { text: "Recap from project model.", warnings: [] })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, "project-only")
  assert.equal(requests[0].tools, undefined)
  const after = await client.session.list({ location })
  assert.deepEqual(after.data, before.data)
  const session = await client.session.create({ location })
  const tui = spawn("python3", [join(root, "scripts", "probe-pty.py"), "opencode", "--server",
    `http://127.0.0.1:${port}`, "--session", session.id, project], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
  let screen = ""
  let toolShown = false
  const recordScreen = (bytes) => {
    screen = (screen + bytes).slice(-500_000)
    const start = screen.lastIndexOf("Tool wo")
    if (start >= 0) toolShown ||= /Tool wo\x1b\[0m\x1b\[6;129H[^\n]*k recap\./.test(screen.slice(start, start + 200))
  }
  tui.stdout.on("data", recordScreen)
  tui.stderr.on("data", recordScreen)
  const waitFor = async (value) => {
    for (let i = 0; i < 100; i++) {
      if (screen.includes(value) || (value === "Tool work recap." && toolShown)) return
      if (tui.exitCode !== null) break
      await new Promise((ok) => setTimeout(ok, 200))
    }
    throw new Error(`TUI did not show ${value}: ${screen.slice(-1500)}`)
  }
  try {
    await waitFor("Recap")
    const transferred = await client.session.export({ sessionID: session.id, location })
    const child = await client.session.import({
      ...transferred,
      info: { ...transferred.info, id: `ses_${randomBytes(12).toString("hex")}`, parentID: session.id },
      location,
    })
    await client.session.prompt({ sessionID: child.id, text: "Inspect the child session", location })
    await client.session.wait({ sessionID: child.id, location })
    await new Promise((ok) => setTimeout(ok, 500))
    assert.equal(requests.filter((request) => JSON.stringify(request).includes("SESSION DIGEST:")).length, 1)
    await client.session.prompt({ sessionID: session.id, text: "Fix the sidebar", location })
    await waitFor("Recap from project model.")
    const history = await client.session.context({ sessionID: session.id, location })
    assert(history.some((message) => message.type === "assistant" && message.content.some((p) => p.type === "text" && p.text === "The sidebar is fixed.")))
    assert(!history.some((message) => message.type === "assistant" && message.content.some((p) => p.type === "text" && p.text === "Recap from project model.")))
    assert.equal((await client.session.list({ location })).data.length, 2)
    const recaps = requests.filter((request) => JSON.stringify(request).includes("SESSION DIGEST:"))
    assert.equal(recaps.length, 2)
    assert(recaps.every((request) => request.tools === undefined))
    assert.equal(recaps.at(-1).model, "project-only")
    assert(JSON.stringify(recaps.at(-1)).includes("user: Fix the sidebar"))
    assert(JSON.stringify(recaps.at(-1)).includes("assistant: The sidebar is fixed."))
    await client.session.prompt({ sessionID: session.id, text: "Use read tool to inspect README.md", location })
    await client.session.wait({ sessionID: session.id, location })
    const toolHistoryLive = await client.session.context({ sessionID: session.id, location })
    assert(toolHistoryLive.some((message) => message.type === "assistant" && message.content.some(
      (part) => part.type === "tool" && part.name === "read" && part.state.status === "completed",
    )), JSON.stringify(toolHistoryLive.slice(-3)).slice(-3000))
    for (let i = 0; i < 50 && requests.filter((request) => JSON.stringify(request).includes("SESSION DIGEST:")).length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const liveToolRecap = requests.filter((request) => JSON.stringify(request).includes("SESSION DIGEST:")).at(-1)
    assert(JSON.stringify(liveToolRecap).includes("[tool] read"), JSON.stringify({
      count: requests.filter((request) => JSON.stringify(request).includes("SESSION DIGEST:")).length,
      last: JSON.stringify(liveToolRecap).slice(-1800),
    }))
    await waitFor("Tool work recap.")
    assert.equal(toolCalls, 1)
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
      client: { rpc: () => ({ summarize: async (input, options) => {
        calls++
        try {
          if (fail) throw new Error("temporary generation failure")
          if (empty) return { text: "", warnings: [] }
          const response = await client.rpc(Recap).summarize(input, options)
          return calls === 1 ? { ...response, text: `${response.text} ${"x".repeat(300)} LAST-CONTEXT` } : response
        } finally { completed() }
      } }) },
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
        : new Promise((resolve) => setTimeout(resolve, 50))
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
      assert(!retryRequest.includes("Recap from project model."), retryRequest)
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
    let timeoutCalls = 0
    let releaseLate
    let onTimeoutSuccess
    const timeoutPrompts = []
    const timeoutToasts = []
    const disposeTimeout = tuiPlugin.setup({
      options: { budget: 160, timeout_ms: 150 },
      client: { rpc: () => ({ summarize: (input) => {
        timeoutCalls++
        timeoutPrompts.push(input.prompt)
        if (timeoutCalls === 1) return new Promise((resolve) => { releaseLate = () => resolve({ text: "late recap", warnings: [] }) })
        return { text: "Recap after timeout.", warnings: [] }
      } }) },
      data: {
        on: (type, handler) => { if (type === "session.execution.succeeded") onTimeoutSuccess = handler; return () => {} },
        session: {
          get: () => ({ id: session.id, location }),
          message: { sync: async () => {}, list: () => toolHistory },
        },
      },
      ui: { slot: () => () => {}, toast: { show: (toast) => timeoutToasts.push(toast) } },
    })
    try {
      onTimeoutSuccess({ data: { sessionID: session.id } })
      for (let i = 0; i < 50 && !timeoutToasts.some((toast) => toast.message.includes("timed out")); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert(timeoutToasts.some((toast) => toast.variant === "error" && toast.message.includes("timed out")), JSON.stringify(timeoutToasts))
      assert.equal(timeoutCalls, 1)
      releaseLate()
      await new Promise((resolve) => setImmediate(resolve))
      onTimeoutSuccess({ data: { sessionID: session.id } })
      for (let i = 0; i < 50 && timeoutCalls < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.equal(timeoutCalls, 2)
      const afterTimeout = timeoutPrompts.at(-1)
      assert(afterTimeout.includes("Follow-up"), afterTimeout)
      assert(!afterTimeout.includes("late recap"), afterTimeout)
      assert(!afterTimeout.includes("PREVIOUS RECAP"), afterTimeout)
    } finally { disposeTimeout() }
    console.log(JSON.stringify({ installed, model: recaps.at(-1).model, text: "Recap from project model.",
      sessions: 2, childIgnored: true, historyMessages: history.length, providerRequests: requests.length, sidebarUpdated: true,
      deletionClearedState: true, timeoutEndedLocalWait: true }, null, 2))
  } finally {
    tui.kill()
  }
} catch (error) {
  console.error(logs.slice(-3000))
  throw error
} finally {
  server.kill()
  mock.close()
}
