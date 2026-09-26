/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { Recap, type RecapSettingsOutput, type RecapSummarizeOutput } from "./rpc.ts"
import { buildRecapDigest, buildRecapRequest } from "./recap-digest.ts"
import { parseRecapOptions, type RecapWarningSource } from "./recap-model.ts"
import { LruMap, RECAP_SESSION_STATE_LIMIT, type RecapSessionState } from "./recap-state.ts"

const errorText = (error: unknown): string => {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === "string" && message ? message : String(error)
}

export default Plugin.define({
  id: "supercode.recap.tui",
  setup(context) {
    const options = parseRecapOptions(context.options)
    const recap = context.client.rpc(Recap)
    // The V2 host discovers the TUI entry through the server inventory without
    // the package entry's options, so budget/timeout come from the server
    // companion at this location; local options are the fallback when it
    // cannot answer.
    const settings = new Map<string, Promise<RecapSettingsOutput | undefined>>()
    const recapOptions = async (location: { directory: string }, signal: AbortSignal) => {
      const key = location.directory
      let cached = settings.get(key)
      if (!cached) {
        cached = recap.settings({}, { location, signal })
          .then((value) => value as RecapSettingsOutput)
          .catch(() => {
            settings.delete(key)
            return undefined
          })
        settings.set(key, cached)
      }
      const remote = await cached
      return {
        budget: Math.max(1, Math.floor(remote?.budget ?? options.budget)),
        timeout_ms: Math.max(1, remote?.timeout_ms ?? options.timeout_ms),
      }
    }
    const recaps = new LruMap<string, RecapSessionState>(RECAP_SESSION_STATE_LIMIT)
    const warned = new LruMap<string, Set<RecapWarningSource>>(RECAP_SESSION_STATE_LIMIT)
    const [revision, setRevision] = createSignal(0)
    const [generatingRevision, setGeneratingRevision] = createSignal(0)
    const inflight = new Map<string, AbortController>()
    let disposed = false

    const recapOf = (sessionID: string) => {
      revision()
      return recaps.get(sessionID)
    }

    const isGenerating = (sessionID: string) => {
      generatingRevision()
      return inflight.has(sessionID)
    }

    const setInflight = (sessionID: string, controller: AbortController | undefined) => {
      if (controller) inflight.set(sessionID, controller)
      else inflight.delete(sessionID)
      setGeneratingRevision((value) => value + 1)
    }

    const stop = context.data.on("session.execution.succeeded", (event) => {
      const sessionID = event.data.sessionID
      const session = context.data.session.get(sessionID)
      if (!session || session.parentID || isGenerating(sessionID)) return
      const controller = new AbortController()
      setInflight(sessionID, controller)
      void (async () => {
        let timedOut = false
        let timeoutMs = Math.max(1, options.timeout_ms)
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = (() => {
          let fail = () => {}
          const promise = new Promise<never>((_, reject) => {
            fail = () => {
              timedOut = true
              controller.abort()
              reject(new Error("Recap timed out"))
            }
          })
          // The provisional timer can fire while the settings fetch is still
          // pending; keep the rejection observed until the race attaches.
          promise.catch(() => {})
          return {
            promise,
            arm: (ms: number) => {
              clearTimeout(timer)
              timer = setTimeout(fail, ms)
            },
          }
        })()
        try {
          // The provisional local bound covers the settings fetch itself; the
          // configured value replaces it once the companion answers.
          timeout.arm(timeoutMs)
          await context.data.session.message.sync(sessionID)
          const resolved = await recapOptions(session.location, controller.signal)
          if (timedOut) throw new Error("Recap timed out")
          if (controller.signal.aborted) return
          timeoutMs = resolved.timeout_ms
          timeout.arm(timeoutMs)
          const budget = resolved.budget
          const previous = recaps.get(sessionID)
          const { digest, truncated, lastIncludedID } = buildRecapDigest(context.data.session.message.list(sessionID), {
            budget,
            afterMessageID: previous?.anchor,
            previousRecap: previous?.text,
          })
          if (!digest || disposed) return
          const location = session.location
          const response = await Promise.race([
            recap.summarize({ prompt: buildRecapRequest({
              digest, truncated, previousRecap: previous?.text, budget,
            }) }, { location, signal: controller.signal }),
            timeout.promise,
          ]) as RecapSummarizeOutput
          for (const warning of response.warnings) {
            const sources = warned.get(location.directory) ?? new Set<RecapWarningSource>()
            if (sources.has(warning.source) || disposed) continue
            sources.add(warning.source)
            warned.set(location.directory, sources)
            context.ui.toast.show({ title: "Recap", variant: "warning", message: warning.message })
          }
          if (disposed) return
          if (!response.text.trim()) {
            context.ui.toast.show({ title: "Recap", variant: "error", message: "Recap failed: empty response" })
            return
          }
          if (!context.data.session.get(sessionID)) return
          recaps.set(sessionID, { text: response.text.trim(), anchor: lastIncludedID })
          setRevision((value) => value + 1)
        } catch (error) {
          if (disposed) return
          // An abort without the timeout means the session or the plugin is
          // gone: there is no one left to notify.
          if (controller.signal.aborted && !timedOut) return
          context.ui.toast.show({
            title: "Recap",
            variant: "error",
            message: timedOut
              ? `Recap failed: timed out after ${timeoutMs}ms`
              : `Recap failed: ${errorText(error)}`,
          })
        } finally {
          clearTimeout(timer)
          if (inflight.get(sessionID) === controller) setInflight(sessionID, undefined)
        }
      })()
    })

    const stopDeleted = context.data.on("session.deleted", (event) => {
      const sessionID = event.data.sessionID
      inflight.get(sessionID)?.abort()
      setInflight(sessionID, undefined)
      recaps.delete(sessionID)
      setRevision((value) => value + 1)
    })

    const removeSlot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const [expanded, setExpanded] = createSignal(true)
        return (
          <box>
            <box flexDirection="row" gap={1} onMouseDown={() => setExpanded(!expanded())}>
              <text fg={context.theme.text.base}>{expanded() ? "▼" : "▶"}</text>
              <text fg={context.theme.text.base}><b>Recap</b></text>
            </box>
            <Show when={expanded()}>
              <Show when={recapOf(sessionID)}>
                <text fg={context.theme.text.muted}>{recapOf(sessionID)?.text}</text>
              </Show>
              <Show when={isGenerating(sessionID)}>
                <text fg={context.theme.text.muted}>Generating recap…</text>
              </Show>
            </Show>
          </box>
        )
      },
    })
    return () => {
      disposed = true
      for (const controller of inflight.values()) controller.abort()
      inflight.clear()
      stop()
      stopDeleted()
      removeSlot()
    }
  },
})
