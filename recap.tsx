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
 * Recap Model comes from configuration (tuple options in tui.json) or a
 * RUNTIME pick (ticket 05): a DialogSelect over api.state.provider, grouped by
 * provider, writes the chosen `provider/model-id` string to api.kv under
 * "recap.model", so it survives TUI restarts and overrides configuration;
 * picking "Follow configuration" clears the key and the chain of ticket 02
 * applies again on the very next click, no restart. The chain resolves by
 * first successfully resolved candidate wins: runtime (api.kv) → plugin
 * `model` option → `small_model` from config → model of the last assistant
 * message. Every candidate is validated against api.state.provider BEFORE the
 * prompt call; an invalid or unknown value gets one error toast per failing
 * source per process, then the next chain level is tried. Parsing lives in
 * ./recap-model.ts — pure, unit-tested away from the TUI.
 *
 * Resilience (ticket 04): a click while a Recap runs returns the SAME promise
 * instead of starting a second Recap Session; a run is raced against an
 * AbortController linked to api.lifecycle.signal plus a timeout_ms timer that
 * stops the Recap Session via session.abort before deletion; failures go to an
 * error toast and never touch the previous Recap; per-session state lives in an
 * LRU-bounded map, dropped on session.deleted and on dispose. Recap Staleness
 * counts the session's OWN messages after a successful Recap (never
 * session.status transitions — compaction, subagents and retries must not
 * count) and marks the Recap stale without erasing it.
 *
 * The section header folds the whole section into one line (ticket 05); the
 * collapsed flag lives in api.kv and survives restarts. The `Model:` line
 * opens the runtime picker; it also shows what the chain would resolve to now.
 */
/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, Show } from "solid-js"
import { SyntaxStyle, TextAttributes } from "@opentui/core"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import {
  type ModelRef,
  type ModelSource,
  isKnownModel,
  modelPickerOptions,
  modelRefString,
  parseModelRef,
  parseRecapOptions,
  RECAP_MODEL_KV_KEY,
  sessionModelRef,
  unwrapMessage,
} from "./recap-model.ts"
import { buildRecapDigest, buildRecapRequest } from "./recap-digest.ts"
import { countUserMessages, isRecapStale } from "./recap-staleness.ts"
import {
  createRecapRecord,
  LruMap,
  RECAP_SESSION_STATE_LIMIT,
  type RecapSessionRecord,
  type ValueSignal,
} from "./recap-state.ts"

const RECAP_TITLE = "Recap"
const COLLAPSE_KEY = "supercode.recap.collapsed"

// Runtime picker: first entry clears the runtime choice; the rest come from
// modelPickerOptions(api.state.provider), grouped by provider via `category`.
const PICK_RESET_VALUE = "__follow-configuration__"
const PICK_RESET_TITLE = "Follow configuration"

// Per-session Recap state, LRU-bounded by session count. The anchor marks the
// last message covered by a SUCCESSFUL Recap (next Digest folds only what came
// after it); lastRecap is the stored Recap itself fed back as the PREVIOUS
// RECAP context block. Failed attempts touch neither — a failed Recap must
// never become the context of the next one.
const sessionRecords = new LruMap<string, RecapSessionRecord>(RECAP_SESSION_STATE_LIMIT)

// In-flight guard keyed by sessionID: a second click returns THE SAME promise
// instead of creating another Recap Session. The guard deliberately lives in
// generateRecap, not in the component's loading() check.
const inFlight = new Map<string, Promise<void>>()

// AbortControllers of running Recaps — aborted by session.deleted for the
// deleted session and by dispose for all. Self-cleaning: removed when the run settles.
const inFlightControllers = new Map<string, AbortController>()

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

function baselineSignalOf(record: RecapSessionRecord): ValueSignal<number | null> {
  record.baseline ??= createSignal<number | null>(null) as ValueSignal<number | null>
  return record.baseline
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  const data = (err as { data?: { message?: string } })?.data
  return data?.message ?? String(err)
}

// Recap Model chain, first successfully resolved candidate wins:
// RUNTIME pick (api.kv "recap.model", ticket 05) -> plugin `model` option
// (tui.json) -> config.small_model -> model of the session's last assistant
// message. Every parsed candidate is validated against api.state.provider
// before it can win; a failing source gets ONE error toast per process (keyed
// by source, not per click) and the next level is tried. With nothing resolved
// the prompt goes out without a `model` field and the server applies its default.

// api.kv has no delete: null is our written "no runtime choice" marker and the
// fallback for a never-set key, so both states read identically as unset.
function runtimeModelRaw(api: TuiPluginApi): string | undefined {
  const raw = api.kv.get<string | null>(RECAP_MODEL_KV_KEY, null)
  return typeof raw === "string" && raw ? raw : undefined
}

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
  const fromConfigValue = (
    raw: string | undefined,
    source: ModelSource,
    notifyInvalid: boolean,
  ): ModelRef | undefined => {
    if (raw === undefined) return undefined
    const ref = parseModelRef(raw)
    if (!ref || !validate(ref)) {
      if (notifyInvalid) toastInvalid(source, raw)
      return undefined
    }
    return ref
  }

  return (sessionID: string, notifyInvalid = true): ModelRef | undefined => {
    const configured =
      fromConfigValue(runtimeModelRaw(api), "runtime", notifyInvalid) ??
      fromConfigValue(optionModel, "tui.json", notifyInvalid) ??
      fromConfigValue(api.state.config.small_model, "small_model", notifyInvalid)
    if (configured) return configured
    const fromSession = sessionModelRef(api.state.session.messages(sessionID))
    if (!fromSession) return undefined
    if (!validate(fromSession)) {
      if (notifyInvalid) toastInvalid("session", `${fromSession.providerID}/${fromSession.modelID}`)
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

function View(props: {
  api: TuiPluginApi
  session_id: string
  staleAfter: number
  onRecap: () => void
  /** What the chain would resolve to now — shown and handed to the picker as `current`. */
  currentModelRaw: () => string | undefined
  onPickModel: () => void
}) {
  const theme = () => props.api.theme.current
  // api.kv is a plain get/set store — keep a local signal for redraws and write through.
  const [collapsed, setCollapsed] = createSignal(props.api.kv.get(COLLAPSE_KEY, false) === true)
  const toggleCollapsed = () => {
    const next = !collapsed()
    setCollapsed(next)
    props.api.kv.set(COLLAPSE_KEY, next)
  }
  const record = () => sessionRecord(props.session_id)
  const recap = () => recapSignalOf(record())[0]()
  const loading = () => loadingSignalOf(record())[0]()

  // Recap Staleness over reactive TUI state: own messages counted in a memo,
  // compared with the snapshot taken when the last Recap succeeded. No event
  // subscriptions; compaction/subagents/retries never move it.
  const userCount = createMemo(() => countUserMessages(props.api.state.session.messages(props.session_id)))
  const stale = createMemo(() => {
    const baseline = baselineSignalOf(record())[0]()
    return baseline !== null && isRecapStale(userCount(), baseline, props.staleAfter)
  })
  const messagesSinceRecap = () => {
    const baseline = baselineSignalOf(record())[0]()
    return baseline === null ? null : userCount() - baseline
  }
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
        {/* Runtime picker entry (ticket 05): click to open the DialogSelect. */}
        <text fg={theme().textMuted} onMouseDown={props.onPickModel}>
          {`Model: ${props.currentModelRaw() ?? "auto (session)"}`}
        </text>
        {/* Marked stale, not erased: an old Recap still orients. */}
        <Show when={!loading() && recap() !== null && stale()}>
          <text fg={theme().textMuted}>
            {`stale — ${messagesSinceRecap()} messages since Recap (click to refresh)`}
          </text>
        </Show>
        <Show when={!loading() && recap() !== null}>
          <markdown content={recap()!} syntaxStyle={syntaxStyle()} fg={theme().text} />
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const { client } = api

  const toast = (variant: "error" | "success" | "warning", message: string) =>
    api.ui.toast({ variant, title: RECAP_TITLE, message })

  // Tuple options from tui.json: recognized keys typed here; unknown keys are
  // ignored silently; a recognized key of the wrong type gets one toast and its
  // default. No tui.json at all is a normal mode — all defaults.
  const recapOptions = parseRecapOptions(rawOptions)
  if (recapOptions.badKeys.length) {
    toast(
      "warning",
      `Ignoring option${recapOptions.badKeys.length > 1 ? "s" : ""} of wrong type: ${recapOptions.badKeys.join(", ")} — using defaults`,
    )
  }
  const resolveRecapModel = createModelResolver(api, recapOptions.model)

  // Runtime pick (ticket 05): the chosen ref lives in api.kv under
  // RECAP_MODEL_KV_KEY and survives restarts. api.kv itself is not reactive,
  // so the sidebar explicitly tracks runtimeVersion — bumped by every
  // pick/reset; reads stay LIVE for the resolver regardless.
  const [runtimeVersion, bumpRuntimeVersion] = createSignal(0)
  const setRuntimeModel = (raw: string | null): void => {
    api.kv.set(RECAP_MODEL_KV_KEY, raw)
    bumpRuntimeVersion((v) => v + 1)
  }

  // The line and DialogSelect `current` marker show the same validated model
  // that the next Recap call will use. Previewing is side-effect-free so an
  // invalid config does not toast merely because the sidebar rendered.
  const currentModelRaw = (sessionID: string): string | undefined => {
    runtimeVersion()
    const ref = resolveRecapModel(sessionID, false)
    return ref ? modelRefString(ref) : undefined
  }

  // The dialog opens synchronously DURING the opening mousedown, so the paired
  // mouseup lands inside the fresh dialog — on an option row (ghost pick) or on
  // the backdrop (dismiss). Ignore selections within GHOST_CLICK_MS of
  // opening: a deliberate pick (Enter or a second click) always comes later.
  const GHOST_CLICK_MS = 350
  let pickerOpenedAt = 0

  function openModelPicker(sessionID: string): void {
    const options = modelPickerOptions(api.state.provider)
    if (!options.length) {
      toast("warning", "Provider list is not loaded yet — cannot pick a Recap Model")
      return
    }
    api.ui.dialog.setSize("large")
    pickerOpenedAt = Date.now()
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect<string>
        title="Recap Model"
        flat={false}
        current={currentModelRaw(sessionID)}
        options={[
          {
            title: PICK_RESET_TITLE,
            value: PICK_RESET_VALUE,
            description: "Clear the runtime choice — configuration chain applies again",
            category: "Reset",
          },
          ...options,
        ]}
        onSelect={(option) => {
          if (Date.now() - pickerOpenedAt < GHOST_CLICK_MS) return
          if (option.value === PICK_RESET_VALUE) {
            setRuntimeModel(null)
            toast("success", "Recap model reset — following configuration")
            api.ui.dialog.clear()
            return
          }

          // Re-check the live provider map at selection time. The dialog may
          // have stayed open while provider availability changed.
          const ref = parseModelRef(option.value)
          if (!ref || !isKnownModel(ref, api.state.provider)) {
            toast("error", `Recap model "${option.value}" is no longer available`)
            return
          }
          setRuntimeModel(option.value)
          toast("success", `Recap model set to ${option.value}`)
          api.ui.dialog.clear()
        }}
      />
    ))
  }

  // Fetched ONCE at init and cached; core ids go into `tools` all-false.
  // Probe finding: MCP tools are NOT in this list and need the "*" entry.
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

    // Spec order on timeout/shutdown: the Recap Session is asked to stop, and
    // deletion waits for that request to complete (enforced in the finally).
    // Idempotent: one abort POST per run no matter who triggers it.
    let stopRequest: Promise<unknown> | undefined
    const stopRecapSession = (): Promise<void> => {
      if (!recapSessionID) return Promise.resolve()
      stopRequest ??= client.session.abort({ sessionID: recapSessionID }).catch(() => {
        // deletion below reports its own failures; an abort error adds nothing
      })
      return stopRequest
    }

    // Linked to the plugin lifecycle: deactivation or TUI shutdown aborts the run.
    const onLifecycleAbort = () => controller.abort()
    api.lifecycle.signal.addEventListener("abort", onLifecycleAbort)
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      void stopRecapSession()
    }, recapOptions.timeout_ms)

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

      // One synchronous call; the answer carries ready parts — no session.idle,
      // no re-fetch, no prompt sniffing. Raced against the controller so a
      // timeout or lifecycle shutdown ALWAYS releases the button even if the
      // transport hangs past the server-side abort.
      const model = resolveRecapModel(sessionID)
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
        // the next click retries the same window.
        recapSignalOf(record)[1]("_No Recap generated._")
        return
      }
      if (built.lastIncludedID !== undefined) record.anchor = built.lastIncludedID
      record.lastRecap = markdown
      // Staleness snapshot taken NOW, on success, over reactive TUI state;
      // failures above never moved it. A stale Recap is marked, not erased.
      baselineSignalOf(record)[1](countUserMessages(api.state.session.messages(sessionID)))
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

  // Re-entrancy guard: five rapid clicks hand back ONE promise → one Recap
  // Session created and deleted. The component's loading() check is cosmetic.
  function generateRecap(sessionID: string): Promise<void> {
    const running = inFlight.get(sessionID)
    if (running) return running
    const run = runRecap(sessionID).finally(() => inFlight.delete(sessionID))
    inFlight.set(sessionID, run)
    return run
  }

  // Bug 5 of the reference fixed: per-session state does not grow forever.
  const offSessionDeleted = api.event.on("session.deleted", (event) => {
    const sessionID = event.properties.info.id
    inFlightControllers.get(sessionID)?.abort()
    inFlightControllers.delete(sessionID)
    sessionRecords.delete(sessionID)
  })
  api.lifecycle.onDispose(offSessionDeleted)

  // Deactivation / TUI shutdown (US 25): subscriptions released, runs aborted,
  // all state dropped.
  api.lifecycle.onDispose(() => {
    for (const controller of inFlightControllers.values()) controller.abort()
    inFlightControllers.clear()
    sessionRecords.clear()
  })

  api.slots.register({
    order: 250,
    slots: {
      sidebar_content(_ctx, props) {
        return (
          <View
            api={api}
            session_id={props.session_id}
            staleAfter={recapOptions.stale_after}
            onRecap={() => generateRecap(props.session_id)}
            currentModelRaw={() => currentModelRaw(props.session_id)}
            onPickModel={() => openModelPicker(props.session_id)}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule = {
  id: "supercode.recap",
  tui,
}

export default plugin
