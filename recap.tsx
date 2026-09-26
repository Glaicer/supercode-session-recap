/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { SyntaxStyle, type RGBA } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"
import { Recap, type RecapSettingsOutput, type RecapSummarizeOutput } from "./rpc.ts"
import { buildRecapDigest, buildRecapRequest } from "./recap-digest.ts"
import { parseRecapOptions, type RecapWarningSource } from "./recap-model.ts"
import { LruMap, RECAP_SESSION_STATE_LIMIT, type RecapSessionState } from "./recap-state.ts"

const errorText = (error: unknown): string => {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === "string" && message ? message : String(error)
}

// The sidebar reads these theme tokens. The host keeps its markdown
// SyntaxStyle private, so the plugin derives its own from the visible tokens —
// enough for the inline markup a Recap can carry.
type RecapTheme = {
  readonly text: { readonly base: RGBA; readonly muted: RGBA }
  readonly markdown: {
    readonly heading: RGBA
    readonly strong: RGBA
    readonly emphasis: RGBA
    readonly code: RGBA
    readonly listItem: RGBA
    readonly blockQuote: RGBA
    readonly link: RGBA
    readonly linkText: RGBA
  }
}

const syntaxStyleFor = (theme: RecapTheme) => SyntaxStyle.fromStyles({
  // Body text follows the sidebar's muted secondary text; accent tokens keep
  // their theme colors.
  "default": { fg: theme.text.muted },
  "conceal": { fg: theme.text.muted },
  "markup.heading": { fg: theme.markdown.heading, bold: true },
  "markup.strong": { fg: theme.markdown.strong, bold: true },
  "markup.italic": { fg: theme.markdown.emphasis, italic: true },
  "markup.list": { fg: theme.markdown.listItem },
  "markup.quote": { fg: theme.markdown.blockQuote, italic: true },
  "markup.raw": { fg: theme.markdown.code },
  "markup.link": { fg: theme.markdown.link, underline: true },
  "markup.link.url": { fg: theme.markdown.link, underline: true },
  "markup.link.label": { fg: theme.markdown.linkText },
  "markup.strikethrough": { fg: theme.text.muted },
})

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
    // Only the collapsed/expanded choice is durable; the Recap text itself
    // stays in the bounded in-memory state above.
    const [sidebar, setSidebar] = context.storage.store("sidebar", { initial: { expanded: true } })
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
      // `after`, not `append`: a replace takeover of this path (e.g. a
      // sidebar plugin's hideMcp mode) suppresses every append/prepend claim
      // targeting the boundary. Sibling placements stay outside it.
      after: "sidebar.content",
      render: ({ sessionID }) => {
        let current: SyntaxStyle | undefined
        // A theme switch swaps the style; the old one is released once the
        // renderer has painted the replacement, mirroring the host's own
        // SyntaxStyle release.
        const release = (style: SyntaxStyle) => {
          void context.renderer.idle().catch(() => {}).finally(() => style.destroy())
        }
        const syntax = createMemo(() => {
          const theme: RecapTheme = context.theme
          const previous = current
          current = syntaxStyleFor(theme)
          if (previous) release(previous)
          return current
        })
        onCleanup(() => { if (current) release(current) })
        const toggle = () => void setSidebar((draft) => { draft.expanded = !draft.expanded })
        return (
          <box>
            <box flexDirection="row" gap={1} onMouseDown={toggle}>
              <text fg={context.theme.text.base}>{sidebar.expanded ? "▼" : "▶"}</text>
              <text fg={context.theme.text.base}><b>Recap</b></text>
            </box>
            <Show when={sidebar.expanded}>
              <Show
                when={recapOf(sessionID)}
                fallback={
                  <Show when={!isGenerating(sessionID)}>
                    <text fg={context.theme.text.muted}>Recap appears after the session's next run.</text>
                  </Show>
                }
              >
                <markdown
                  syntaxStyle={syntax()}
                  content={recapOf(sessionID)?.text ?? ""}
                  conceal={true}
                  internalBlockMode="top-level"
                  fg={context.theme.text.muted}
                />
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
