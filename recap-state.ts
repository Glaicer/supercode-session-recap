/**
 * Pure per-session Recap state: an LRU-bounded store plus the record shape.
 * No @opentui/* and no solid-js imports (signals are typed structurally), so
 * this file runs standalone under `node --test` away from the TUI.
 */

/** Hard cap on sessions holding Recap state; the reference leaked 3 Maps forever. */
export const RECAP_SESSION_STATE_LIMIT = 64

/**
 * Structural stand-in for solid's `[accessor, setter]` tuple — keeps this
 * module import-free while recap.tsx stores real createSignal tuples here.
 */
export type ValueSignal<T> = [get: () => T, set: (value: T) => T]

export type RecapSessionRecord = {
  /** messageID covered by the last SUCCESSFUL Recap — next Digest starts after it. */
  anchor: string | undefined
  /** Markdown of the last SUCCESSFUL Recap — the only source of PREVIOUS RECAP. */
  lastRecap: string | undefined
  /** Own-message count when the last Recap succeeded (reactive); null = never succeeded. */
  baseline: ValueSignal<number | null> | undefined
  /** Sidebar text signal for the Recap Markdown itself. */
  recap: ValueSignal<string | null> | undefined
  /** Sidebar busy flag for the Recap button. */
  loading: ValueSignal<boolean> | undefined
}

export function createRecapRecord(): RecapSessionRecord {
  return {
    anchor: undefined,
    lastRecap: undefined,
    baseline: undefined,
    recap: undefined,
    loading: undefined,
  }
}

/**
 * Map with get-refreshed recency and a hard cap: inserting beyond the cap
 * evicts the least recently used entry. Reads touch recency.
 * Note: stored `undefined` values are indistinguishable from absence and do
 * not refresh recency — store a sentinel instead.
 */
export class LruMap<Key, Value> {
  #cap: number
  #entries = new Map<Key, Value>()

  constructor(cap: number) {
    this.#cap = Math.max(1, Math.floor(cap))
  }

  get size(): number {
    return this.#entries.size
  }

  has(key: Key): boolean {
    return this.#entries.has(key)
  }

  /** Read with a recency touch — the normal access path. */
  get(key: Key): Value | undefined {
    const value = this.#entries.get(key)
    if (value !== undefined) this.#touch(key, value)
    return value
  }

  set(key: Key, value: Value): void {
    this.#touch(key, value)
    while (this.#entries.size > this.#cap) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      this.#entries.delete(oldest.value)
    }
  }

  delete(key: Key): void {
    this.#entries.delete(key)
  }

  clear(): void {
    this.#entries.clear()
  }

  #touch(key: Key, value: Value): void {
    // delete-then-set moves the key to the tail = most recently used
    this.#entries.delete(key)
    this.#entries.set(key, value)
  }
}
