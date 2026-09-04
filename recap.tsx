/**
 * supercode.recap — TUI sidebar section showing an automatic Recap of the current session.
 *
 * After every turn end (`session.idle`) the plugin folds the session into a
 * Recap Digest (one line per tool call, reasoning dropped, long text cut
 * visibly, budgeted with overflow dropped from the head), runs ONE synchronous
 * `session.prompt` against a throwaway child session with every tool disabled,
 * renders the Markdown reply in the sidebar and deletes the session. Nothing
 * runs on render or while a turn is still going — a session opened mid-history
 * gets its first Recap when its next turn finishes.
 *
 * The window is incremental: a successful Recap stores the messageID it
 * covered, so the next Digest folds only messages after it and feeds the
 * stored Recap back as the PREVIOUS RECAP context block.
 *
 * Tool suppression: explicit `false` for every id from client.tool.ids()
 * disables core tools, but MCP tools are not in that list — `"*": false`
 * covers those.
 *
 * The Recap Model is OpenCode's `small_model` — the same one used for session
 * title generation — with an explicit `model` option from tui.json as the only
 * override. The candidate is validated against api.state.provider BEFORE the
 * prompt call; an invalid or unknown value gets one error toast per source per
 * process and the prompt goes out without a `model` field (server default).
 * Parsing lives in ./recap-model.ts — pure, unit-tested away from the TUI.
 *
 * Resilience: an idle event while a Recap runs returns the SAME promise
 * instead of starting a second Recap Session; a run is raced against an
 * AbortController linked to api.lifecycle.signal plus a timeout_ms timer that
 * stops the Recap Session via session.abort before deletion; failures go to an
 * error toast and never touch the previous Recap; per-session state lives in an
 * LRU-bounded map, dropped on session.deleted and on dispose. Idle events for
 * child sessions (our own throwaway Recap Sessions, subagents) never trigger a
 * Recap — only parentless main sessions are recapped.
 *
 * The sidebar is display-only: a collapsible header (expanded by default, the
 * choice persists in api.kv), the latest Recap and a Generating indicator —
 * while no Recap has completed yet and the session is not idle, a
 * "Waiting for the first turn to finish." note is shown instead, because
 * generation only starts at session.idle.
 * There are no buttons, no picker and no model state.
 */
/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js"
import { SyntaxStyle } from "@opentui/core"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import {
  type ModelRef,
  type ModelSource,
  isKnownModel,
  parseModelRef,
  parseRecapOptions,
  unwrapMessage,
} from "./recap-model.ts"
import { buildRecapDigest, buildRecapRequest } from "./recap-digest.ts"
import {
  createRecapRecord,
  LruMap,
  RECAP_SESSION_STATE_LIMIT,
  type RecapSessionRecord,
  type ValueSignal,
} from "./recap-state.ts"

const RECAP_TITLE = "Recap"
const WAITING_FOR_FIRST_TURN = "Waiting for the first turn to finish."
// Fresh key: the old "supercode.recap.collapsed" key may still hold a stale
// `true` in kv.json — this starts everyone expanded again. Orphaned old keys
// in kv.json are inert and can be deleted by hand.
const EXPANDED_KEY = "supercode.recap.expanded"

// The anchor marks the last message covered by a SUCCESSFUL Recap (next Digest
// folds only what came after it); lastRecap is the stored Recap itself fed back
// as the PREVIOUS RECAP context block. Failed attempts touch neither — a failed
// Recap must never become the context of the next one.
const sessionRecords = new LruMap<string, RecapSessionRecord>(RECAP_SESSION_STATE_LIMIT)

// In-flight guard keyed by sessionID: a second trigger returns THE SAME promise
// instead of creating another Recap Session. The guard deliberately lives in
// generateRecap, not in the caller.
const inFlight = new Map<string, Promise<void>>()

// AbortControllers of running Recaps — aborted by session.deleted for the
// deleted session and by dispose for all.
const inFlightControllers = new Map<string, AbortController>()

// IDs of our own throwaway Recap Sessions (created with a parentID). Their
// session.idle — fired when the one prompt resolves — must never trigger a
// Recap of the Recap Session itself. Entries leave on session.deleted.
const recapChildIDs = new Set<string>()

function sessionRecord(sessionID: string): RecapSessionRecord {
  let record = sessionRecords.get(sessionID)
  if (!record) {
    record = createRecapRecord()
    sessionRecords.set(sessionID, record)
  }
  return record
}

function recapSignalOf(record: RecapSessionRecord): ValueSignal<string | null> {
  record.recap ??= createSignal<string | null>(null) as ValueSignal<string | null>
  return record.recap
}

function loadingSignalOf(record: RecapSessionRecord): ValueSignal<boolean> {
  record.loading ??= createSignal<boolean>(false) as ValueSignal<boolean>
  return record.loading
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  const data = (err as { data?: { message?: string } })?.data
  return data?.message ?? String(err)
}

// Recap Model: explicit `model` option (tui.json) wins, otherwise OpenCode's
// `small_model` — the same one used for session title generation. Every parsed
// candidate is validated against api.state.provider before it can win; a
// PRESENT bad value gets ONE error toast per process (keyed by source) and the
// next level is tried. With nothing resolved the prompt goes out without a
// `model` field and the server applies its default.
function createModelResolver(api: TuiPluginApi, optionModel: string | undefined) {
  // Once-per-process-per-source suppression lives in this closure, so the
  // file must be registered exactly once (see README).
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
      message: `Recap model "${raw}" from ${source} is invalid or unknown — continuing without an explicit model`,
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

  return (): ModelRef | undefined =>
    fromConfigValue(optionModel, "tui.json") ?? fromConfigValue(api.state.config.small_model, "small_model")
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

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  // api.kv is a plain get/set store — keep a local signal for redraws and write through.
  const [expanded, setExpanded] = createSignal(props.api.kv.get<boolean>(EXPANDED_KEY, true) !== false)
  const toggleExpanded = () => {
    const next = !expanded()
    setExpanded(next)
    props.api.kv.set(EXPANDED_KEY, next)
  }
  const record = () => sessionRecord(props.session_id)
  // Generation triggers only via session.idle (turn end) — never on render,
  // so no Recap runs while a turn is still going.
  const recap = () => recapSignalOf(record())[0]()
  const loading = () => loadingSignalOf(record())[0]()
  const syntaxStyle = () => buildSyntaxStyle(props.api)
  // Generation only starts at session.idle, so "Generating…" would lie while a
  // turn is still running. While no Recap has ever completed and the session
  // is not idle, show the waiting note instead.
  const hasCompletedRecap = () => record().anchor !== undefined || record().lastRecap !== undefined
  const sessionNotIdle = () => {
    try {
      return props.api.state.session.status(props.session_id)?.type !== "idle"
    } catch {
      return true
    }
  }
  const waitingForFirstTurn = () => !hasCompletedRecap() && sessionNotIdle()

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={toggleExpanded}>
        <text fg={theme().text}>{expanded() ? "▼" : "▶"}</text>
        <text fg={theme().text}>
          <b>{RECAP_TITLE}</b>
        </text>
      </box>
      <Show when={expanded()}>
        <Show when={waitingForFirstTurn()}>
          <text fg={theme().textMuted}>{WAITING_FOR_FIRST_TURN}</text>
        </Show>
        <Show when={loading() && !waitingForFirstTurn()}>
          <text fg={theme().textMuted}>Generating…</text>
        </Show>
        <Show when={!loading() && recap() !== null}>
          <markdown content={recap()!} syntaxStyle={syntaxStyle()} fg={theme().textMuted} />
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const { client } = api

  const toast = (variant: "error" | "success" | "warning", message: string) =>
    api.ui.toast({ variant, title: RECAP_TITLE, message })

  const recapOptions = parseRecapOptions(rawOptions)
  if (recapOptions.badKeys.length) {
    toast(
      "warning",
      `Ignoring option${recapOptions.badKeys.length > 1 ? "s" : ""} of wrong type: ${recapOptions.badKeys.join(", ")} — using defaults`,
    )
  }
  const resolveRecapModel = createModelResolver(api, recapOptions.model)

  // MCP tools are NOT in this list — the "*" entry covers them.
  const toolIds = (((await client.tool.ids()).data as string[] | undefined) ?? [])

  function suppressAllTools(): Record<string, boolean> {
    return { ...Object.fromEntries(toolIds.map((id) => [id, false])), "*": false }
  }

  async function runRecap(sessionID: string): Promise<void> {
    const record = sessionRecord(sessionID)
    loadingSignalOf(record)[1](true)
    let recapSessionID: string | undefined
    const controller = new AbortController()
    inFlightControllers.set(sessionID, controller)
    let timedOut = false

    // On timeout/shutdown the Recap Session is asked to stop first, and
    // deletion waits for that request to complete (enforced in the finally).
    // Idempotent: one abort POST per run no matter who triggers it.
    let stopRequest: Promise<unknown> | undefined
    const stopRecapSession = (): Promise<unknown> => {
      if (!recapSessionID) return Promise.resolve()
      stopRequest ??= client.session.abort({ sessionID: recapSessionID }).catch(() => {
        // deletion below reports its own failures; an abort error adds nothing
      })
      return stopRequest
    }

    const onLifecycleAbort = () => controller.abort()
    api.lifecycle.signal.addEventListener("abort", onLifecycleAbort)
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      void stopRecapSession()
    }, recapOptions.timeout_ms)

    try {
      const entries = api.state.session.messages(sessionID).map((message) => ({
        info: messageInfo(message),
        parts: messageParts(api, message),
      }))
      const built = buildRecapDigest(entries, {
        budget: recapOptions.budget,
        afterMessageID: record.anchor,
      })
      if (!built.digest) {
        recapSignalOf(record)[1]("_No Recap material yet._")
        return
      }
      const request = buildRecapRequest({
        digest: built.digest,
        previousRecap: record.lastRecap,
        truncated: built.truncated,
      })

      // Recap Session: throwaway child so it stays out of the top-level list.
      const created = await client.session.create({ parentID: sessionID, title: "recap" })
      recapSessionID = created.data?.id
      if (!recapSessionID) throw new Error("Failed to create Recap Session")
      recapChildIDs.add(recapSessionID)

      // One synchronous call; the answer carries ready parts — no session.idle,
      // no re-fetch, no prompt sniffing. Raced against the controller so a
      // timeout or lifecycle shutdown ALWAYS releases the run even if the
      // transport hangs past the server-side abort.
      const model = resolveRecapModel()
      const prompt = client.session.prompt({
        sessionID: recapSessionID,
        ...(model ? { model } : {}),
        system:
          "You are a summarization assistant. Output only Markdown — no tools, no files, no questions.",
        tools: suppressAllTools(),
        parts: [{ type: "text", text: request }],
      })
      // The losing race branch may reject late — never let that become unhandled.
      prompt.catch(() => {})
      const response = await Promise.race([
        prompt,
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error("Recap aborted")), { once: true }),
        ),
      ])

      const markdown = (response.data?.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => (p as { text?: string }).text ?? "")
        .join("")
        .trim()
      if (!markdown) {
        // Empty reply: neither the anchor nor PREVIOUS RECAP may advance, so
        // the next turn retries the same window.
        recapSignalOf(record)[1]("_No Recap generated._")
        return
      }
      if (built.lastIncludedID !== undefined) record.anchor = built.lastIncludedID
      record.lastRecap = markdown
      recapSignalOf(record)[1](markdown)
    } catch (err) {
      // Shutdown is not a Recap failure: deactivation/TUI exit aborts silently.
      if (!api.lifecycle.signal.aborted) {
        toast(
          "error",
          timedOut
            ? `Recap timed out after ${recapOptions.timeout_ms}ms`
            : `Recap failed: ${errorMessage(err)}`,
        )
      }
    } finally {
      clearTimeout(timer)
      api.lifecycle.signal.removeEventListener("abort", onLifecycleAbort)
      inFlightControllers.delete(sessionID)
      if (recapSessionID) {
        // Abort-before-delete on every aborted path; no-op if already requested.
        if (controller.signal.aborted) await stopRecapSession()
        try {
          await client.session.delete({ sessionID: recapSessionID })
        } catch (err) {
          toast("error", `Failed to delete Recap Session ${recapSessionID}: ${errorMessage(err)}`)
        }
      }
      loadingSignalOf(record)[1](false)
    }
  }

  function generateRecap(sessionID: string): Promise<void> {
    const running = inFlight.get(sessionID)
    if (running) return running
    const run = runRecap(sessionID).finally(() => inFlight.delete(sessionID))
    inFlight.set(sessionID, run)
    return run
  }

  // Turn end: every main session re-recaps itself. Child sessions (our own
  // throwaway Recap Sessions, subagents) idle too — never recap those. The
  // parentID check covers children known to TUI state; the ID set covers our
  // own children even if state has not synced them yet.
  const offSessionIdle = api.event.on("session.idle", (event) => {
    const sessionID = event.properties.sessionID
    if (recapChildIDs.has(sessionID)) return
    if (api.state.session.get(sessionID)?.parentID) return
    void generateRecap(sessionID)
  })
  api.lifecycle.onDispose(offSessionIdle)

  const offSessionDeleted = api.event.on("session.deleted", (event) => {
    const sessionID = event.properties.info.id
    inFlightControllers.get(sessionID)?.abort()
    inFlightControllers.delete(sessionID)
    sessionRecords.delete(sessionID)
    recapChildIDs.delete(sessionID)
  })
  api.lifecycle.onDispose(offSessionDeleted)

  api.lifecycle.onDispose(() => {
    for (const controller of inFlightControllers.values()) controller.abort()
    inFlightControllers.clear()
    sessionRecords.clear()
    recapChildIDs.clear()
  })

  api.slots.register({
    // Last in the sidebar: internal sections sit at 100-500, token-usage at
    // 150, goal at 550 — this stays below all of them.
    order: 900,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule = {
  id: "supercode.recap",
  tui,
}

export default plugin
