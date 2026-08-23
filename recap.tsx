/**
 * supercode.recap — TUI sidebar section that summarizes the current session.
 *
 * Click `Recap` → the plugin folds the session tail into a transcript, runs ONE
 * synchronous `session.prompt` against a throwaway child session with every tool
 * disabled, renders the Markdown reply in the sidebar and deletes the session.
 *
 * Tool suppression is proven by probe (see .scratch/039-tui-session-recap/probe/):
 * explicit `false` for every id from client.tool.ids() kills core tools, but MCP
 * tools leak past it — `"*": false` covers those.
 */
/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js"
import { SyntaxStyle, TextAttributes } from "@opentui/core"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

const RECAP_TITLE = "Recap"
const COLLAPSE_KEY = "supercode.recap.collapsed"
// shortcut: fixed tail window instead of the budgeted Digest (ticket 03)
const TAIL_MESSAGES = 20

type ModelRef = { providerID: string; modelID: string }

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  const data = (err as { data?: { message?: string } })?.data
  return data?.message ?? String(err)
}

// Strictly by the FIRST slash: gonka-proxy/deepseek-ai/deepseek-v4-flash-0731
// has two slashes and the modelID keeps the second segment.
function parseModelRef(value: unknown): ModelRef | undefined {
  if (typeof value !== "string") return undefined
  const cut = value.indexOf("/")
  if (cut <= 0 || cut === value.length - 1) return undefined
  return { providerID: value.slice(0, cut), modelID: value.slice(cut + 1) }
}

// Recap Model, short chain (full chain with options + validation is ticket 02):
// config.small_model -> model of the session's last assistant message -> none.
function resolveRecapModel(api: TuiPluginApi, sessionID: string): ModelRef | undefined {
  const fromConfig = parseModelRef(api.state.config.small_model)
  if (fromConfig) return fromConfig
  const messages = api.state.session.messages(sessionID)
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messageInfo(messages[i])
    if (info.role !== "assistant") continue
    const providerID = info.providerID
    const modelID = info.modelID
    if (typeof providerID === "string" && providerID && typeof modelID === "string" && modelID) {
      return { providerID, modelID }
    }
  }
  return undefined
}

function messageInfo(message: unknown): Record<string, unknown> {
  const m = message as { info?: Record<string, unknown> }
  return m.info ?? (message as Record<string, unknown>)
}

function messageParts(api: TuiPluginApi, message: unknown): ReadonlyArray<Record<string, unknown>> {
  const m = message as { parts?: ReadonlyArray<Record<string, unknown>> }
  if (Array.isArray(m.parts)) return m.parts
  return api.state.part(String((message as { id?: string }).id)) as ReadonlyArray<Record<string, unknown>>
}

// Transcript: tail of the session, text parts only — reasoning and tool output
// stay out (rich Digest is ticket 03). Read from reactive TUI state, not HTTP.
function buildTranscript(api: TuiPluginApi, sessionID: string): string {
  const rows: string[] = []
  for (const message of api.state.session.messages(sessionID).slice(-TAIL_MESSAGES)) {
    const info = messageInfo(message)
    const role = info.role === "user" ? "user" : info.role === "assistant" ? "assistant" : null
    if (!role) continue
    const text = messageParts(api, message)
      .filter((p) => p.type === "text" && !(p as { ignored?: boolean }).ignored)
      .map((p) => String((p as { text?: string }).text ?? "").trim())
      .filter(Boolean)
      .join(" ")
      .trim()
    if (text) rows.push(`${role}: ${text}`)
  }
  return rows.join("\n\n")
}

function buildSyntaxStyle(api: TuiPluginApi): SyntaxStyle {
  const c = api.theme.current
  return SyntaxStyle.fromStyles({
    comment: { fg: c.syntaxComment },
    keyword: { fg: c.syntaxKeyword },
    function: { fg: c.syntaxFunction },
    variable: { fg: c.syntaxVariable },
    string: { fg: c.syntaxString },
    number: { fg: c.syntaxNumber },
    type: { fg: c.syntaxType },
    operator: { fg: c.syntaxOperator },
    punctuation: { fg: c.syntaxPunctuation },
  })
}

const recapSignals = new Map<string, unknown>()
const loadingSignals = new Map<string, unknown>()

function lazySignal<Value>(map: Map<string, unknown>, sessionID: string, initial: Value) {
  let s = map.get(sessionID) as ReturnType<typeof createSignal<Value>> | undefined
  if (!s) {
    s = createSignal(initial)
    map.set(sessionID, s)
  }
  return s as [() => Value, (value: Value) => Value]
}

function recapSignal(sessionID: string) {
  return lazySignal(recapSignals, sessionID, null as string | null)
}

function loadingSignal(sessionID: string) {
  return lazySignal(loadingSignals, sessionID, false)
}

function View(props: { api: TuiPluginApi; session_id: string; onRecap: () => void }) {
  const theme = () => props.api.theme.current
  // api.kv is a plain get/set store — keep a local signal for redraws and write through.
  const [collapsed, setCollapsed] = createSignal(props.api.kv.get(COLLAPSE_KEY, false))
  const toggleCollapsed = () => {
    const next = !collapsed()
    setCollapsed(next)
    props.api.kv.set(COLLAPSE_KEY, next)
  }
  const recap = () => recapSignal(props.session_id)[0]()
  const loading = () => loadingSignal(props.session_id)[0]()
  const syntaxStyle = () => buildSyntaxStyle(props.api)

  return (
    <box>
      <text fg={theme().primary} attributes={TextAttributes.BOLD} onMouseDown={toggleCollapsed}>
        {collapsed() ? "▸" : "▾"} {RECAP_TITLE}
      </text>
      <Show when={!collapsed()}>
        <text
          fg={loading() ? theme().textMuted : theme().text}
          attributes={TextAttributes.BOLD}
          onMouseDown={() => {
            if (!loading()) props.onRecap()
          }}
        >
          {loading() ? "Generating…" : "Recap"}
        </text>
        <Show when={recap() !== null && !loading()}>
          <markdown content={recap()!} syntaxStyle={syntaxStyle()} fg={theme().text} />
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const { client } = api

  // Fetched ONCE at init and cached; core ids go into `tools` all-false.
  // Probe finding: MCP tools are NOT in this list and need the "*" entry.
  const toolIds = (((await client.tool.ids()).data as string[] | undefined) ?? [])

  function suppressAllTools(): Record<string, boolean> {
    return { ...Object.fromEntries(toolIds.map((id) => [id, false])), "*": false }
  }

  async function generateRecap(sessionID: string) {
    const [, setLoading] = loadingSignal(sessionID)
    setLoading(true)
    let recapSessionID: string | undefined
    try {
      const transcript = buildTranscript(api, sessionID)
      if (!transcript) {
        recapSignal(sessionID)[1]("_Nothing to summarize yet._")
        return
      }

      // Recap Session: throwaway child so it stays out of the top-level list.
      const created = await client.session.create({ parentID: sessionID, title: "recap" })
      recapSessionID = created.data?.id
      if (!recapSessionID) throw new Error("Failed to create Recap Session")

      // One synchronous call; the answer carries ready parts — no session.idle,
      // no re-fetch, no prompt sniffing.
      const model = resolveRecapModel(api, sessionID)
      const response = await client.session.prompt({
        sessionID: recapSessionID,
        ...(model ? { model } : {}),
        system:
          "You are a summarization assistant. Output only Markdown — no tools, no files, no questions.",
        tools: suppressAllTools(),
        parts: [
          {
            type: "text",
            text:
              "Summarize the coding session below. Answer with exactly three sections, in this order:\n" +
              "**Working on:** one sentence — what is being built or explored right now\n" +
              "**Done:** up to 3 short bullets of what is already finished (skip if nothing yet)\n" +
              "**Next:** one bullet — the immediate next step\n" +
              "No intro, no outro, no other sections.\n\n" +
              `SESSION TRANSCRIPT:\n${transcript}`,
          },
        ],
      })

      const markdown = (response.data?.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => (p as { text?: string }).text ?? "")
        .join("")
        .trim()
      recapSignal(sessionID)[1](markdown || "_No Recap generated._")
    } catch (err) {
      api.ui.toast({ variant: "error", title: RECAP_TITLE, message: `Recap failed: ${errorMessage(err)}` })
    } finally {
      if (recapSessionID) {
        try {
          await client.session.delete({ sessionID: recapSessionID })
        } catch (err) {
          api.ui.toast({
            variant: "error",
            title: RECAP_TITLE,
            message: `Failed to delete Recap Session ${recapSessionID}: ${errorMessage(err)}`,
          })
        }
      }
      setLoading(false)
    }
  }

  api.slots.register({
    order: 250,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} onRecap={() => generateRecap(props.session_id)} />
      },
    },
  })
}

const plugin: TuiPluginModule = {
  id: "supercode.recap",
  tui,
}

export default plugin
