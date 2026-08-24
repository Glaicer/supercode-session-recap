/**
 * Pure Recap Model helpers: no @opentui/* imports, so this file runs standalone
 * under `node --test` (or bun test) away from the TUI.
 */

export type ModelRef = { providerID: string; modelID: string }

/** Where a failed candidate came from — named verbatim in the error toast. */
export type ModelSource = "runtime" | "tui.json" | "small_model" | "session"

/** api.kv key holding the runtime-picked Recap Model (ticket 05). */
export const RECAP_MODEL_KV_KEY = "recap.model"

/** `provider/model-id` — the one string shape used at every chain level. */
export function modelRefString(ref: ModelRef): string {
  return `${ref.providerID}/${ref.modelID}`
}

/** One DialogSelect entry for the runtime picker (rendering is recap.tsx's job). */
export type ModelPickOption = {
  title: string
  /** Raw `provider/model-id`, so a pick round-trips through api.kv verbatim. */
  value: string
  description?: string
  category?: string
}

export const DIGEST_DEFAULT_BUDGET = 12000

export const RECAP_OPTION_DEFAULTS = {
  stale_after: 3,
  budget: DIGEST_DEFAULT_BUDGET,
  timeout_ms: 60000,
} as const

export type RecapOptions = {
  /** Raw configured model ref; parsed/validated later against live providers. */
  model: string | undefined
  stale_after: number
  budget: number
  timeout_ms: number
}

export type ParsedRecapOptions = RecapOptions & {
  /** Recognized keys whose value had the wrong type; defaulted + toasted once. */
  badKeys: string[]
}

// Strictly by the FIRST slash: gonka-proxy/deepseek-ai/deepseek-v4-flash-0731
// has two slashes and the modelID keeps the second segment. A string without a
// slash, with an empty providerID or an empty modelID is invalid.
export function parseModelRef(value: unknown): ModelRef | undefined {
  if (typeof value !== "string") return undefined
  const cut = value.indexOf("/")
  if (cut <= 0 || cut === value.length - 1) return undefined
  return { providerID: value.slice(0, cut), modelID: value.slice(cut + 1) }
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

// Unknown keys are ignored silently; a recognized key of the wrong type lands
// in badKeys (one toast) and falls back to its default. Anything can arrive in
// the tuple — a non-object options bag just means "all defaults", never a crash.
export function parseRecapOptions(raw: unknown): ParsedRecapOptions {
  const bag = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
  const badKeys: string[] = []
  let model: string | undefined
  if (bag.model === undefined) {
    // absent is fine
  } else if (typeof bag.model === "string") {
    model = bag.model
  } else {
    badKeys.push("model")
  }
  const numberKey = (key: "stale_after" | "budget" | "timeout_ms"): number => {
    const value = bag[key]
    if (value === undefined) return RECAP_OPTION_DEFAULTS[key]
    if (!isNumber(value)) {
      badKeys.push(key)
      return RECAP_OPTION_DEFAULTS[key]
    }
    return value
  }
  return {
    model,
    stale_after: numberKey("stale_after"),
    budget: numberKey("budget"),
    timeout_ms: numberKey("timeout_ms"),
    badKeys,
  }
}

// Messages arrive as {info, parts} from TUI state but stay defensively loose:
// flat message shapes and junk entries must never throw here.
export function unwrapMessage(message: unknown): Record<string, unknown> | undefined {
  const wrapped = message as { info?: Record<string, unknown> } | null | undefined
  const info = (wrapped?.info ?? message) as Record<string, unknown> | null | undefined
  return info && typeof info === "object" ? info : undefined
}

export function sessionModelRef(messages: ReadonlyArray<unknown>): ModelRef | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = unwrapMessage(messages[i])
    if (!info) continue
    if (info.role !== "assistant") continue
    const providerID = info.providerID
    const modelID = info.modelID
    if (typeof providerID === "string" && providerID && typeof modelID === "string" && modelID) {
      return { providerID, modelID }
    }
  }
  return undefined
}

// Validation against api.state.provider happens BEFORE the prompt call. An
// empty provider list (state not loaded yet) validates nothing here — callers
// decide whether to trust the ref rather than false-fail every level.
export function isKnownModel(ref: ModelRef, providers: ReadonlyArray<unknown>): boolean {
  return providers.some((p) => {
    const provider = p as { id?: unknown; models?: Record<string, unknown> } | null | undefined
    return provider?.id === ref.providerID && Boolean(provider.models?.[ref.modelID])
  })
}

// Flatten api.state.provider into grouped picker options: one entry per model,
// DialogSelect's `category` carries the provider name so models render grouped
// by provider. Provider and model order are kept as given; title prefers the
// model's display name and falls back to the raw id. Junk entries and
// providers without models are skipped — a picker must never throw.
export function modelPickerOptions(providers: ReadonlyArray<unknown>): ModelPickOption[] {
  const options: ModelPickOption[] = []
  for (const entry of providers) {
    const provider = entry as
      | { id?: unknown; name?: unknown; models?: Record<string, unknown> }
      | null
      | undefined
    if (!provider || typeof provider !== "object") continue
    if (typeof provider.id !== "string" || !provider.id) continue
    const models = provider.models
    if (!models || typeof models !== "object") continue
    const providerName = typeof provider.name === "string" && provider.name ? provider.name : provider.id
    for (const [modelID, info] of Object.entries(models)) {
      if (!modelID) continue
      const model = info as { name?: unknown } | null | undefined
      const title = model && typeof model.name === "string" && model.name ? model.name : modelID
      options.push({
        title,
        value: modelRefString({ providerID: provider.id, modelID }),
        description: providerName,
        category: providerName,
      })
    }
  }
  return options
}
