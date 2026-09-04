/**
 * No @opentui/* and no solid-js imports (signals are typed structurally), so
 * this file runs standalone under `node --test` away from the TUI.
 */

/** Hard cap on sessions holding Recap state, so it can't grow without bound. */
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
  recap: ValueSignal<string | null> | undefined
  loading: ValueSignal<boolean> | undefined
}

export function createRecapRecord(): RecapSessionRecord {
  return {
    anchor: undefined,
    lastRecap: undefined,
    recap: undefined,
    loading: undefined,
  }
}

/**
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
