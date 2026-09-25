import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
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
const mock = createServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  requests.push(input)
  const text = JSON.stringify(input).includes("SESSION DIGEST:") ? "Recap from project model." : "The sidebar is fixed."
  res.setHeader("content-type", "text/event-stream")
  const event = (delta, finish_reason = null) => ({ id: "mock", object: "chat.completion.chunk", created: 1,
    model: input.model, choices: [{ index: 0, delta, finish_reason }] })
  res.write(`data: ${JSON.stringify(event({ role: "assistant", content: text }))}\n\n`)
  res.write(`data: ${JSON.stringify(event({}, "stop"))}\n\n`)
  res.end("data: [DONE]\n\n")
})
await new Promise((ok) => mock.listen(0, "127.0.0.1", ok))
const modelPort = mock.address().port
await mkdir(project, { recursive: true })
await mkdir(join(config, "opencode"), { recursive: true })
const archive = join(root, "glaicer-supercode-session-recap-0.1.0.tgz")
execFileSync("npm", ["install", "--ignore-scripts", "--prefix", temp, archive], { stdio: "pipe" })
const installed = join(temp, "node_modules", "@glaicer", "supercode-session-recap")
const { default: tuiPlugin } = await import(pathToFileURL(join(installed, "tui.js")).href)
let onSuccess
let childCalls = 0
const disposeChild = tuiPlugin.setup({
  options: {},
  client: { rpc: () => ({ summarize: () => { childCalls++; return { text: "unexpected" } } }) },
  data: {
    on: (_type, handler) => { onSuccess = handler; return () => {} },
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
  assert.deepEqual(output, { text: "Recap from project model." })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, "project-only")
  assert.equal(requests[0].tools, undefined)
  const after = await client.session.list({ location })
  assert.deepEqual(after.data, before.data)
  const session = await client.session.create({ location })
  const tui = spawn("python3", [join(root, "scripts", "probe-pty.py"), "opencode", "--server",
    `http://127.0.0.1:${port}`, "--session", session.id, project], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
  let screen = ""
  tui.stdout.on("data", (bytes) => screen = (screen + bytes).slice(-500_000))
  tui.stderr.on("data", (bytes) => screen = (screen + bytes).slice(-500_000))
  const waitFor = async (value) => {
    for (let i = 0; i < 100; i++) {
      if (screen.includes(value)) return
      if (tui.exitCode !== null) break
      await new Promise((ok) => setTimeout(ok, 200))
    }
    throw new Error(`TUI did not show ${value}: ${screen.slice(-5000)}`)
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
    console.log(JSON.stringify({ installed, model: recaps.at(-1).model, text: "Recap from project model.",
      sessions: 2, childIgnored: true, historyMessages: history.length, providerRequests: requests.length, sidebarUpdated: true }, null, 2))
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
