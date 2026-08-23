/**
 * supercode.recap — TUI sidebar section showing a Recap of the current session.
 *
 * Click `Recap` → the plugin folds the session into a Recap Digest (one line
 * per tool call, reasoning dropped, long text cut visibly, budgeted with
 * overflow dropped from the head), runs ONE synchronous `session.prompt`
 * against a throwaway child session with every tool disabled, renders the
 * Markdown reply in the sidebar and deletes the session.
 *
 * The window is incremental: a successful Recap stores the messageID it
 * covered, so the next Digest folds only messages after it and feeds the
 * stored Recap back as the PREVIOUS RECAP context block.
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
import { buildRecapDigest, buildRecapRequest } from "./recap-digest.ts"

const RECAP_TITLE = "Recap"
const COLLAPSE_KEY = "supercode.recap.collapsed"

// Per-session messageID of the last message covered by a SUCCESSFUL Recap:
// the next Digest folds only what came after it, and the stored Recap itself
// is fed back as the PREVIOUS RECAP context block. Failed attempts touch
// neither — a failed Recap must never become the context of the next one.
const digestAnchors = new Map<string, string>()

// Real Recap Markdown per session — the ONLY source of the PREVIOUS RECAP
// block. Placeholders shown in the sidebar ("_No Recap material yet._",
// "_No Recap generated._", error text) live outside this map, so a failed or
// empty attempt can never become the context of the next one.
const realRecaps = new Map<string, string>()

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
  // budget feeds buildRecapDigest here; stale_after/timeout_ms are held for
  // ticket 04 (their consumers).
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
      // Recap Digest from reactive TUI state: tool calls folded to one line
      // each, reasoning dropped, long text cut visibly. Window is incremental —
      // messages after the last successful Recap's anchor — and bounded by the
      // configured budget with overflow dropped from the head.
      const entries = api.state.session.messages(sessionID).map((message) => ({
        info: messageInfo(message),
        parts: messageParts(api, message),
      }))
      const built = buildRecapDigest(entries, {
        budget: recapOptions.budget,
        afterMessageID: digestAnchors.get(sessionID),
      })
      if (!built.digest) {
        recapSignal(sessionID)[1]("_No Recap material yet._")
        return
      }
      const request = buildRecapRequest({
        digest: built.digest,
        previousRecap: realRecaps.get(sessionID),
        truncated: built.truncated,
      })

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
        parts: [{ type: "text", text: request }],
      })

      const markdown = (response.data?.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => (p as { text?: string }).text ?? "")
        .join("")
        .trim()
      if (!markdown) {
        // Empty reply: neither the anchor nor PREVIOUS RECAP may advance, so
        // the next click retries the same window.
        recapSignal(sessionID)[1]("_No Recap generated._")
        return
      }
      if (built.lastIncludedID !== undefined) digestAnchors.set(sessionID, built.lastIncludedID)
      realRecaps.set(sessionID, markdown)
      recapSignal(sessionID)[1](markdown)
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
