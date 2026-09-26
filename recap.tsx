/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { Recap, type RecapSummarizeOutput } from "./rpc.ts"
import { buildRecapDigest, buildRecapRequest } from "./recap-digest.ts"
import { parseRecapOptions, type RecapWarningSource } from "./recap-model.ts"
import { LruMap, RECAP_SESSION_STATE_LIMIT, type RecapSessionState } from "./recap-state.ts"

export default Plugin.define({
  id: "supercode.recap.tui",
  setup(context) {
    const options = parseRecapOptions(context.options)
    const timeoutMs = Math.max(1, options.timeout_ms)
    const recap = context.client.rpc(Recap)
    const recaps = new LruMap<string, RecapSessionState>(RECAP_SESSION_STATE_LIMIT)
    const warned = new LruMap<string, Set<RecapWarningSource>>(RECAP_SESSION_STATE_LIMIT)
    const [revision, setRevision] = createSignal(0)
    const running = new Set<string>()
    let disposed = false

    const recapOf = (sessionID: string) => {
      revision()
      return recaps.get(sessionID)
    }

    const stop = context.data.on("session.execution.succeeded", (event) => {
      const sessionID = event.data.sessionID
      const session = context.data.session.get(sessionID)
      if (!session || session.parentID || running.has(sessionID)) return
      running.add(sessionID)
      void (async () => {
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await context.data.session.message.sync(sessionID)
          const previous = recaps.get(sessionID)
          const budget = Math.max(1, Math.floor(options.budget))
          const { digest, truncated, lastIncludedID } = buildRecapDigest(context.data.session.message.list(sessionID), {
            budget,
            afterMessageID: previous?.anchor,
            previousRecap: previous?.text,
          })
          if (!digest || disposed) return
          const location = session.location
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new Error("Recap timed out"))
            }, timeoutMs)
          })
          const response = await Promise.race([
            recap.summarize({ prompt: buildRecapRequest({
              digest, truncated, previousRecap: previous?.text, budget,
            }) }, { location, signal: controller.signal }),
            timeout,
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
          context.ui.toast.show({
            title: "Recap",
            variant: "error",
            message: controller.signal.aborted
              ? `Recap failed: timed out after ${timeoutMs}ms`
              : `Recap failed: ${String(error)}`,
          })
        } finally {
          clearTimeout(timer)
          running.delete(sessionID)
        }
      })()
    })

    const stopDeleted = context.data.on("session.deleted", (event) => {
      recaps.delete(event.data.sessionID)
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
            <Show when={expanded() && recapOf(sessionID)}>
              <text fg={context.theme.text.muted}>{recapOf(sessionID)?.text}</text>
            </Show>
          </box>
        )
      },
    })
    return () => {
      disposed = true
      stop()
      stopDeleted()
      removeSlot()
    }
  },
})
