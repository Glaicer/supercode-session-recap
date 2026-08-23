/**
 * Pure Recap Staleness helpers: no @opentui/* imports, so this file runs
 * standalone under `node --test` away from the TUI.
 */
import { unwrapMessage } from "./recap-model.ts"

/**
 * Count of the session's OWN prompts: messages with `info.role === "user"`.
 * Recap Staleness compares this against the snapshot taken when a Recap
 * succeeded — never `session.status` transitions, which also fire for
 * compaction, subagents and retries.
 */
export function countUserMessages(messages: ReadonlyArray<unknown>): number {
  let count = 0
  for (const message of messages) {
    if (unwrapMessage(message)?.role === "user") count++
  }
  return count
}

/**
 * True once at least `staleAfter` own messages arrived after the snapshot.
 * A non-positive `staleAfter` (misconfiguration) still requires ONE new
 * message — a fresh Recap must never be born stale.
 */
export function isRecapStale(current: number, baseline: number, staleAfter: number): boolean {
  return current - baseline >= Math.max(1, staleAfter)
}
