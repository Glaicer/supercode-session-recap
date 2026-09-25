import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
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
const temp = await mkdtemp(join(probeRoot, "recap-model-probe-"))
const install = join(temp, "install")
const config = join(temp, "config")
const globalProject = join(temp, "global-project")
const projectTitle = join(temp, "project-title")
const projectLegacy = join(temp, "project-legacy")
const projectExplicit = join(temp, "project-explicit")
const projectInvalid = join(temp, "project-invalid")
const requests = []

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const listen = (server) => new Promise((resolve, reject) => {
  const onError = (error) => reject(error)
  server.once("error", onError)
  server.listen(0, "127.0.0.1", () => {
    server.off("error", onError)
    resolve(server.address().port)
  })
})

const mock = createServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  requests.push({ path: req.url, input })
  const text = `Recap from ${input.model}.`
  const event = (delta, finish_reason = null) => ({
    id: "model-selection-probe",
    object: "chat.completion.chunk",
    created: 1,
    model: input.model,
    choices: [{ index: 0, delta, finish_reason }],
  })
  res.setHeader("content-type", "text/event-stream")
  res.write(`data: ${JSON.stringify(event({ role: "assistant", content: text }))}\n\n`)
  res.write(`data: ${JSON.stringify(event({}, "stop"))}\n\n`)
  res.end("data: [DONE]\n\n")
})

let server
const modelPort = await listen(mock)
try {
  await mkdir(install, { recursive: true })
  await mkdir(join(config, "opencode"), { recursive: true })
  await mkdir(globalProject, { recursive: true })
  await mkdir(projectTitle, { recursive: true })
  await mkdir(projectLegacy, { recursive: true })
  await mkdir(projectExplicit, { recursive: true })
  await mkdir(projectInvalid, { recursive: true })

  // Build and pack the artifact consumed by OpenCode. The package's existing
  // prepack checks also verify that the installed TUI entry is compiled.
  execFileSync("npm", ["pack", "--pack-destination", install], { cwd: root, stdio: "ignore" })
  const archives = (await readdir(install)).filter((name) => name.endsWith(".tgz"))
  assert.equal(archives.length, 1, `expected one packed archive, found ${archives.join(", ")}`)
  const archive = join(install, archives[0])
  const installed = join(temp, "node_modules", "@glaicer", "supercode-session-recap")
  await mkdir(installed, { recursive: true })
  execFileSync("tar", ["-xzf", archive, "-C", installed, "--strip-components=1"], { stdio: "pipe" })
  await symlink(join(root, "node_modules"), join(installed, "node_modules"), "dir")
  const { default: tuiPlugin } = await import(pathToFileURL(join(installed, "tui.js")).href)
  assert.equal(tuiPlugin.id, "supercode.recap.tui")

  const endpoint = `http://127.0.0.1:${modelPort}/v1`
  const provider = (name, models) => ({
    name,
    env: ["RECAP_PROBE_KEY"],
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: endpoint },
    models: Object.fromEntries(models.map((id) => [id, { name: `${name} ${id}` }])),
  })

  // This is the global configuration. The default model is deliberately
  // different from the title model so the title-agent fallback is observable.
  await writeFile(join(config, "opencode", "opencode.json"), JSON.stringify({
    model: "recap-probe-global/global-default",
    agents: { title: { model: "recap-probe-global/global-title" } },
    plugins: [{ package: installed, options: {} }],
    providers: {
      "recap-probe-global": provider("Global", ["global-default", "global-title"]),
    },
  }, null, 2))

  // Project configuration is layered on top of the global configuration by
  // the server instance for that location. The project title model differs
  // from both the global title and the project default.
  await writeFile(join(projectTitle, "opencode.json"), JSON.stringify({
    model: "recap-probe-project/project-default",
    agents: { title: { model: "recap-probe-project/project-title" } },
    plugins: [{ package: installed, options: {} }],
    providers: {
      "recap-probe-project": provider("Project", ["project-default", "project-title"]),
    },
  }, null, 2))

  await writeFile(join(projectLegacy, "opencode.json"), JSON.stringify({
    model: "recap-probe-legacy/legacy-default",
    small_model: "recap-probe-legacy/legacy-small",
    plugins: [{ package: installed, options: {} }],
    providers: {
      "recap-probe-legacy": provider("Legacy", ["legacy-default", "legacy-small"]),
    },
  }, null, 2))

  // The model id contains another slash. The project plugin option must be
  // split at its first slash and beat the project title model.
  await writeFile(join(projectExplicit, "opencode.json"), JSON.stringify({
    model: "recap-probe-explicit/explicit-default",
    agents: { title: { model: "recap-probe-explicit/title-fallback" } },
    plugins: [{
      package: installed,
      options: { model: "recap-probe-explicit/namespaced/project-model" },
    }],
    providers: {
      "recap-probe-explicit": provider("Explicit", [
        "explicit-default",
        "title-fallback",
        "namespaced/project-model",
      ]),
    },
  }, null, 2))

  await writeFile(join(projectInvalid, "opencode.json"), JSON.stringify({
    model: "recap-probe-invalid/invalid-default",
    agents: { title: { model: "recap-probe-invalid/valid-title" } },
    plugins: [{ package: installed, options: {
      model: "missing/model", budget: "invalid", unknown_option: true,
    } }],
    providers: {
      "recap-probe-invalid": provider("Invalid", ["invalid-default", "valid-title"]),
    },
  }, null, 2))

  const password = "recap-model-probe-password"
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(temp, "data"),
    XDG_CACHE_HOME: join(temp, "cache"),
    XDG_STATE_HOME: join(temp, "state"),
    OPENCODE_DB: join(temp, "database.sqlite"),
    OPENCODE_SERVER_PASSWORD: password,
    RECAP_PROBE_KEY: "test-only",
    TERM: "xterm-256color",
  }
  delete env.OPENCODE_CONFIG_DIR
  delete env.ORCA_OPENCODE_CONFIG_DIR

  const port = 19000 + Math.floor(Math.random() * 10000)
  server = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "debug"],
    { cwd: globalProject, env, stdio: ["ignore", "pipe", "pipe"] },
  )
  let logs = ""
  server.stdout.on("data", (bytes) => { logs += bytes.toString() })
  server.stderr.on("data", (bytes) => { logs += bytes.toString() })

  const client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await client.server.info()
      break
    } catch {
      if (server.exitCode !== null) throw new Error(`Server exited before startup: ${logs}`)
      if (attempt === 99) throw new Error(`Server did not start: ${logs}`)
      await wait(200)
    }
  }

  const location = (directory) => ({ directory })
  const assertPluginActive = async (directory) => {
    const plugins = await client.plugin.list({ location: location(directory) })
    const entries = await client.config.get({ location: location(directory) })
    assert(
      plugins.data.some((plugin) => plugin.id === "supercode.recap.server"),
      `Recap server plugin is not active for ${directory}: plugins=${JSON.stringify(plugins.data)}, config=${JSON.stringify(entries)}, logs=${logs.slice(-4000)}`,
    )
  }

  const summarizeAt = async (name, directory, expectedModel, expectedWarnings = []) => {
    const scope = location(directory)
    const before = await client.session.list({ location: scope })
    const output = await client.rpc(Recap).summarize({
      prompt: `SESSION DIGEST:\nlocation: ${name}\nuser: select the Recap Model`,
    }, { location: scope })
    await assertPluginActive(directory)
    const after = await client.session.list({ location: scope })
    assert.deepEqual(after.data, before.data, `${name} generation created a session`)
    assert.deepEqual(output, { text: `Recap from ${expectedModel}.`, warnings: expectedWarnings })

    const matching = requests.filter(({ input }) => input.model === expectedModel)
    assert.equal(matching.length, 1, `${name} endpoint request count for ${expectedModel}`)
    const request = matching[0]
    assert.match(request.path, /chat\/completions$/, `${name} did not use the controlled chat endpoint`)
    assert(
      request.input.tools === undefined || (Array.isArray(request.input.tools) && request.input.tools.length === 0),
      `${name} generation unexpectedly supplied tools: ${JSON.stringify(request.input.tools)}`,
    )
    return request
  }

  const globalRequest = await summarizeAt(
    "global",
    globalProject,
    "global-title",
  )
  const projectTitleRequest = await summarizeAt(
    "project-title",
    projectTitle,
    "project-title",
  )
  const legacyRequest = await summarizeAt(
    "project-legacy",
    projectLegacy,
    "legacy-small",
  )
  const explicitRequest = await summarizeAt(
    "project-explicit",
    projectExplicit,
    "namespaced/project-model",
  )
  const invalidRequest = await summarizeAt(
    "project-invalid",
    projectInvalid,
    "valid-title",
    [
      { source: "budget", message: 'Invalid Recap option "budget"; using its default.' },
      { source: "model", message: 'Recap option model "missing/model" is unavailable; trying the next model.' },
    ],
  )

  assert.equal(globalRequest.input.model, "global-title")
  assert.equal(projectTitleRequest.input.model, "project-title")
  assert.equal(legacyRequest.input.model, "legacy-small")
  assert.equal(explicitRequest.input.model, "namespaced/project-model")
  assert.equal(invalidRequest.input.model, "valid-title")
  assert.equal(requests.length, 5, `unexpected controlled endpoint requests: ${JSON.stringify(requests)}`)

  console.log(JSON.stringify({
    locations: {
      global: { directory: "global-project", receivedModel: globalRequest.input.model },
      projectTitle: { directory: "project-title", receivedModel: projectTitleRequest.input.model },
      projectLegacy: { directory: "project-legacy", receivedModel: legacyRequest.input.model },
      projectExplicit: { directory: "project-explicit", receivedModel: explicitRequest.input.model },
      projectInvalid: { directory: "project-invalid", receivedModel: invalidRequest.input.model },
    },
    titleFallbackIsLocationScoped: true,
    explicitModelWins: true,
    firstSlashParsingObserved: true,
    invalidOptionAndModelWarnings: 2,
    sessionCountChanges: 0,
    toolCalls: 0,
    controlledRequests: requests.length,
  }, null, 2))
} finally {
  if (server && server.exitCode === null) server.kill()
  await new Promise((resolve) => mock.close(resolve))
}
