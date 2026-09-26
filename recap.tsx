/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { Recap } from "./rpc.ts"
import { buildRecapDigest, buildRecapRequest } from "./recap-digest.ts"
import { parseRecapOptions } from "./recap-model.ts"

export default Plugin.define({
  id: "supercode.recap.tui",
  setup(context) {
    const options = parseRecapOptions(context.options)
    const recap = context.client.rpc(Recap)
    const [state, setState] = createSignal<Record<string, { text: string; anchor?: string }>>({})
    const running = new Set<string>()
    const warned = new Set<string>()
    let disposed = false

    const stop = context.data.on("session.execution.succeeded", (event) => {
      const sessionID = event.data.sessionID
      const session = context.data.session.get(sessionID)
      if (!session || session.parentID || running.has(sessionID)) return
      running.add(sessionID)
      void (async () => {
        try {
          await context.data.session.message.sync(sessionID)
          const previous = state()[sessionID]
          const budget = Math.max(1, Math.floor(options.budget))
          const reserved = previous?.text ? Math.min(previous.text.length, Math.floor(budget / 4)) : 0
          const { digest, truncated, lastIncludedID } = buildRecapDigest(context.data.session.message.list(sessionID), {
            budget: budget - reserved,
            afterMessageID: previous?.anchor,
          })
          if (!digest || disposed) return
          const location = session.location
          const response = await recap.summarize({ prompt: buildRecapRequest({
            digest, truncated, previousRecap: previous?.text, budget,
          }) }, { location }) as {
            text: string
            warnings: Array<{ source: string; message: string }>
          }
          for (const warning of response.warnings) {
            const key = `${location.directory}:${warning.source}`
            if (warned.has(key) || disposed) continue
            warned.add(key)
            context.ui.toast.show({ title: "Recap", variant: "warning", message: warning.message })
          }
          if (disposed) return
          if (!response.text.trim()) {
            context.ui.toast.show({ title: "Recap", variant: "error", message: "Recap failed: empty response" })
            return
          }
          setState((current) => ({
            ...current, [sessionID]: { text: response.text.trim(), anchor: lastIncludedID },
          }))
        } catch (error) {
          if (!disposed) context.ui.toast.show({ title: "Recap", variant: "error", message: `Recap failed: ${String(error)}` })
        } finally {
          running.delete(sessionID)
        }
      })()
    })

    const slot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const [expanded, setExpanded] = createSignal(true)
        return (
          <box>
            <box flexDirection="row" gap={1} onMouseDown={() => setExpanded(!expanded())}>
              <text fg={context.theme.text.base}>{expanded() ? "▼" : "▶"}</text>
              <text fg={context.theme.text.base}><b>Recap</b></text>
            </box>
            <Show when={expanded() && state()[sessionID]}>
              <text fg={context.theme.text.muted}>{state()[sessionID].text}</text>
            </Show>
          </box>
        )
      },
    })
    return () => {
      disposed = true
      stop()
      slot()
    }
  },
})
