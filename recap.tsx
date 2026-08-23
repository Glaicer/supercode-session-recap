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
 *
 * Recap Model comes from configuration (tuple options in tui.json) and resolves
 * by chain, first successfully resolved wins: plugin `model` option →
 * `small_model` from config → model of the last assistant message. Every
 * candidate is validated against api.state.provider BEFORE the prompt call; an
 * invalid or unknown value gets one error toast per failing source per process,
 * then the next chain level is tried. Parsing lives in ./recap-model.ts — pure,
 * unit-tested away from the TUI.
 */
/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js"
import { SyntaxStyle, TextAttributes } from "@opentui/core"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import {
  type ModelRef,
  type ModelSource,
  isKnownModel,
  parseModelRef,
  parseRecapOptions,
  sessionModelRef,
  unwrapMessage,
} from "./recap-model.ts"

const RECAP_TITLE = "Recap"
const COLLAPSE_KEY = "supercode.recap.collapsed"
// shortcut: fixed tail window instead of the budgeted Digest (ticket 03)
const TAIL_MESSAGES = 20

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  const data = (err as { data?: { message?: string } })?.data
  return data?.message ?? String(err)
}

// Recap Model chain, first successfully resolved candidate wins:
// plugin `model` option (tui.json) -> config.small_model -> model of the
// session's last assistant message. Every parsed candidate is validated
// against api.state.provider before it can win; a failing source gets ONE
// error toast per process (keyed by source, not per click) and the next
// level is tried. With nothing resolved the prompt goes out without a
// `model` field and the server applies its default.
function createModelResolver(api: TuiPluginApi, optionModel: string | undefined) {
  // Once-per-process-per-source suppression lives in this closure: one
  // registered instance per file is the documented setup.
  const toastedSources = new Set<ModelSource>()

  // Read live at each call: the provider list populates after TUI startup and
  // may be replaced wholesale — an init-time snapshot could stay empty forever.
  const validate = (ref: ModelRef): boolean => {
    const providers = api.state.provider
    // Empty list means TUI state has not loaded yet — validating then would
    // false-fail every level, so candidates that at least PARSE are trusted.
    return !providers.length || isKnownModel(ref, providers)
  }

  const toastInvalid = (source: ModelSource, raw: string) => {
    if (toastedSources.has(source)) return
    toastedSources.add(source)
    api.ui.toast({
      variant: "error",
      title: RECAP_TITLE,
      message: `Recap model "${raw}" from ${source} is invalid or unknown — falling back`,
    })
  }

  // A level is skipped silently when unset; only a PRESENT bad value toasts.
  const fromConfigValue = (raw: string | undefined, source: ModelSource): ModelRef | undefined => {
    if (raw === undefined) return undefined
    const ref = parseModelRef(raw)
    if (!ref || !validate(ref)) {
      toastInvalid(source, raw)
      return undefined
    }
    return ref
  }

  return (sessionID: string): ModelRef | undefined => {
    const configured =
      fromConfigValue(optionModel, "tui.json") ??
      fromConfigValue(api.state.config.small_model, "small_model")
    if (configured) return configured
    const fromSession = sessionModelRef(api.state.session.messages(sessionID))
    if (!fromSession) return undefined
    if (!validate(fromSession)) {
      toastInvalid("session", `${fromSession.providerID}/${fromSession.modelID}`)
      return undefined
    }
    return fromSession
  }
}

function messageInfo(message: unknown): Record<string, unknown> {
  return unwrapMessage(message) ?? {}
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

const tui: TuiPlugin = async (api, rawOptions) => {
  const { client } = api

  const toast = (variant: "error" | "warning", message: string) =>
    api.ui.toast({ variant, title: RECAP_TITLE, message })

  // Tuple options from tui.json: recognized keys typed here; unknown keys are
  // ignored silently; a recognized key of the wrong type gets one toast and its
  // default. No tui.json at all is a normal mode — all defaults.
  // stale_after/budget/timeout_ms are held for tickets 03/04 (their consumers).
  const recapOptions = parseRecapOptions(rawOptions)
  if (recapOptions.badKeys.length) {
    toast(
      "warning",
      `Ignoring option${recapOptions.badKeys.length > 1 ? "s" : ""} of wrong type: ${recapOptions.badKeys.join(", ")} — using defaults`,
    )
  }
  const resolveRecapModel = createModelResolver(api, recapOptions.model)

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
      const model = resolveRecapModel(sessionID)
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
      toast("error", `Recap failed: ${errorMessage(err)}`)
    } finally {
      if (recapSessionID) {
        try {
          await client.session.delete({ sessionID: recapSessionID })
        } catch (err) {
          toast("error", `Failed to delete Recap Session ${recapSessionID}: ${errorMessage(err)}`)
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
