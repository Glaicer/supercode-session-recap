/**
 * Pure Recap Digest builder: folds session messages into a size-bounded
 * transcript that keeps tool work visible. No @opentui/* imports — runs under
 * `node --test` away from the TUI.
 */
import { DIGEST_DEFAULT_BUDGET, unwrapMessage } from "./recap-model.ts"

export { DIGEST_DEFAULT_BUDGET }

// Per-part caps bound one message's fold so the budget walk can drop whole
// messages and still guarantee the final digest never exceeds the budget.
const TEXT_PART_LIMIT = 400
const TOOL_ARG_LIMIT = 80
const TOOL_ERROR_LIMIT = 160

// First matching key wins: path-like inputs identify read/glob/edit calls,
// command identifies bash, pattern identifies grep/glob.
const TOOL_ARG_KEYS = [
  "filePath",
  "path",
  "file",
  "command",
  "pattern",
  "query",
  "url",
  "description",
] as const
const FILE_EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"])

export type DigestMessage = {
  info?: unknown
  parts?: ReadonlyArray<unknown>
}

export type DigestBuild = {
  /** Assembled window text; "" when there is nothing to fold. */
  digest: string
  /** True when material was dropped: head-of-window cut or a within-message cut. */
  truncated: boolean
  /**
   * messageID of the last message this build covered — stored as the anchor
   * so the next Recap folds only what came after it.
   */
  lastIncludedID: string | undefined
}

function shorten(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > limit ? clean.slice(0, limit - 1) + "…" : clean
}

function messageId(entry: DigestMessage): string | undefined {
  const info = unwrapMessage(entry) as { id?: unknown } | undefined
  const id = info?.id
  return typeof id === "string" && id ? id : undefined
}

function shortToolArg(input: Record<string, unknown>): string {
  for (const key of TOOL_ARG_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return shorten(value, TOOL_ARG_LIMIT)
    if (typeof value === "number") return String(value)
  }
  return ""
}

// Sign of change for file edits: added/removed line counts derived from the
// diff metadata when present — the diff CONTENT itself never enters the digest.
function changeSign(tool: string, metadata: Record<string, unknown> | undefined): string {
  const diff = metadata?.diff
  if (typeof diff === "string" && diff.trim()) {
    let added = 0
    let removed = 0
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue
      if (line.startsWith("+")) added++
      else if (line.startsWith("-")) removed++
    }
    if (added + removed > 0) return `(+${added} -${removed})`
  }
  return tool === "write" ? "(+)" : "(~)"
}

function foldToolPart(part: Record<string, unknown>): string {
  const state = (part.state ?? {}) as {
    status?: unknown
    input?: Record<string, unknown>
    error?: unknown
  }
  const name = typeof part.tool === "string" && part.tool ? part.tool : "tool"
  const input = state.input && typeof state.input === "object" ? state.input : {}
  const arg = shortToolArg(input)
  const sign = FILE_EDIT_TOOLS.has(name) ? " " + changeSign(name, state.metadata as Record<string, unknown> | undefined) : ""
  let outcome: string
  if (state.status === "completed") {
    outcome = "ok"
  } else if (state.status === "error") {
    const firstLine = String(state.error ?? "").split("\n")[0] ?? ""
    outcome = `error: ${shorten(firstLine, TOOL_ERROR_LIMIT)}`
  } else {
    outcome = String(state.status ?? "unknown")
  }
  return `[tool] ${name}${arg ? ` ${arg}` : ""}${sign} -> ${outcome}`
}

function foldTextPart(part: Record<string, unknown>): string {
  const raw = typeof part.text === "string" ? part.text : ""
  const body = raw.trim()
  if (!body) return ""
  if (body.length <= TEXT_PART_LIMIT) return body
  return `${body.slice(0, TEXT_PART_LIMIT)}\n[…text truncated — ${body.length - TEXT_PART_LIMIT} more characters cut]`
}

// One message -> one block. reasoning parts are dropped entirely; text parts
// are kept with long ones cut visibly; each tool call becomes one line.
function foldMessage(entry: DigestMessage): string {
  const info = unwrapMessage(entry)
  if (!info) return ""
  const role = info.role
  if (role !== "user" && role !== "assistant") return ""
  const lines: string[] = []
  for (const part of Array.isArray(entry.parts) ? entry.parts : []) {
    const p = (part ?? {}) as Record<string, unknown>
    if (p.type === "text") {
      if (p.ignored === true) continue
      const folded = foldTextPart(p)
      if (folded) lines.push(folded)
    } else if (p.type === "tool") {
      lines.push(foldToolPart(p))
    }
  }
  if (!lines.length) return ""
  return `${role}: ${lines.join("\n")}`
}

export function buildRecapDigest(
  messages: ReadonlyArray<DigestMessage>,
  opts: { budget?: number; afterMessageID?: string } = {},
): DigestBuild {
  const budget = opts.budget ?? DIGEST_DEFAULT_BUDGET

  // Incremental window: everything AFTER the anchored message. An anchor no
  // longer present in the list (compacted away, refetched) means the tail
  // logic applies anyway — fall back to the full list.
  let start = 0
  if (opts.afterMessageID !== undefined) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messageId(messages[i]) === opts.afterMessageID) {
        start = i + 1
        break
      }
    }
  }
  const window = messages.slice(start)
  const folded = window.map(foldMessage).filter((text) => text.length > 0)

  // Budget walk from the tail: the newest material survives, overflow drops
  // from the head of the window — the tail is what is forgotten least.
  const keptReversed: string[] = []
  let total = 0
  let truncated = false
  for (let i = folded.length - 1; i >= 0; i--) {
    const cost = folded[i].length + (keptReversed.length > 0 ? 1 : 0)
    if (total + cost > budget) {
      truncated = true
      break
    }
    total += cost
    keptReversed.push(folded[i])
  }
  const kept = keptReversed.reverse()

  // A single fold bigger than the whole budget keeps its TAIL under budget:
  // zero whole messages fitting must not produce an empty digest.
  if (!kept.length && folded.length > 0) {
    const last = folded[folded.length - 1]
    kept.push(last.slice(Math.max(0, last.length - budget)))
    truncated = true
  }

  // Anchor covers the end of the window even when its own fold was empty or
  // partially cut: the next Recap takes messages strictly after it.
  let lastIncludedID: string | undefined
  for (let i = window.length - 1; i >= 0; i--) {
    const id = messageId(window[i])
    if (id !== undefined) {
      lastIncludedID = id
      break
    }
  }

  return { digest: kept.join("\n"), truncated, lastIncludedID }
}

export function buildRecapRequest(args: {
  digest: string
  previousRecap?: string | null
  truncated?: boolean
}): string {
  const blocks = [
    "Summarize the coding session below. Answer with exactly three sections, in this order:\n" +
      "**Working on:** one sentence — what is being built or explored right now\n" +
      "**Done:** up to 3 short bullets of what is already finished (skip if nothing yet)\n" +
      "**Next:** one bullet — the immediate next step\n" +
      "No intro, no outro, no other sections.",
  ]
  if (args.previousRecap) {
    blocks.push("PREVIOUS RECAP — context from earlier session history:\n" + args.previousRecap)
  }
  if (args.truncated) {
    blocks.push(
      "NOTE: the digest below was truncated from its beginning to fit the size budget — older activity is missing, so treat it as partial rather than complete history.",
    )
  }
  blocks.push(`SESSION DIGEST:\n${args.digest}`)
  return blocks.join("\n\n")
}
