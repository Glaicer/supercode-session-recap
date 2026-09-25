/**
 * No @opentui/* imports, so this file runs standalone under `node --test`
 * (or bun test) away from the TUI.
 *
 * The Recap Model comes from the plugin option, the configured title agent
 * (including V1 small_model normalized by V2), or the location's default.
 */

export type ModelRef = { providerID: string; modelID: string }
export type RecapWarning = { source: string; message: string }

export function modelRefString(ref: ModelRef): string {
  return `${ref.providerID}/${ref.modelID}`
}

export const DIGEST_DEFAULT_BUDGET = 12000

export const RECAP_OPTION_DEFAULTS = {
  budget: DIGEST_DEFAULT_BUDGET,
  timeout_ms: 60000,
} as const

export type RecapOptions = {
  /** Raw configured model ref; parsed/validated later against live providers. */
  model: string | undefined
  budget: number
  timeout_ms: number
}

export type ParsedRecapOptions = RecapOptions & {
  /** Recognized keys whose value had the wrong type; defaulted + toasted once. */
  badKeys: string[]
}

// Strictly by the FIRST slash: gonka-proxy/deepseek-ai/deepseek-v4-flash-0731
// has two slashes and the modelID keeps the second segment.
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
// the package options — a non-object bag means "all defaults", never a crash.
export function parseRecapOptions(raw: unknown): ParsedRecapOptions {
  const bag = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
  const badKeys: string[] = []
  let model: string | undefined
  if (typeof bag.model === "string") {
    model = bag.model.trim() ? bag.model : undefined
  } else if (bag.model !== undefined) {
    badKeys.push("model")
  }
  const numberKey = (key: "budget" | "timeout_ms"): number => {
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

export function selectRecapModel(input: {
  explicit?: string
  title?: ModelRef
  fallback?: ModelRef
  available: ReadonlyArray<ModelRef>
}): { model: ModelRef; warnings: RecapWarning[] } {
  const warnings: RecapWarning[] = []
  const known = (ref: ModelRef) => input.available.some(
    (model) => model.providerID === ref.providerID && model.modelID === ref.modelID,
  )
  if (input.explicit !== undefined) {
    const ref = parseModelRef(input.explicit)
    if (ref && known(ref)) return { model: ref, warnings }
    warnings.push({ source: "model", message: ref
      ? `Recap option model "${input.explicit}" is unavailable; trying the next model.`
      : `Recap option model "${input.explicit}" must be provider/model-id; trying the next model.` })
  }
  if (input.title) {
    if (known(input.title)) return { model: input.title, warnings }
    warnings.push({ source: "title", message: `Title agent model "${modelRefString(input.title)}" is unavailable; trying the default model.` })
  }
  if (input.fallback && known(input.fallback)) return { model: input.fallback, warnings }
  throw new Error(`No available Recap model at this location. ${warnings.map((item) => item.message).join(" ")}`.trim())
}
