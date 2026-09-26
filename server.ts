import { Plugin } from "@opencode/plugin"
import { Recap } from "./rpc.ts"
import { parseRecapOptions, selectRecapModel, type ModelRef } from "./recap-model.ts"

const toRef = (model: { providerID: string; id: string }): ModelRef => ({
  providerID: model.providerID,
  modelID: model.id,
})

export default Plugin.define({
  id: "supercode.recap.server",
  async setup(ctx) {
    const options = parseRecapOptions(ctx.options)
    await ctx.rpc.register(Recap, {
      // The TUI component is discovered through the server inventory without the
      // package entry's options, so the server answers with its own resolved
      // budget/timeout for the TUI to follow.
      settings: async () => ({
        budget: options.budget,
        timeout_ms: options.timeout_ms,
      }),
      summarize: async (input, context) => {
        const [models, agents, selected] = await Promise.all([
          ctx.model.list(), ctx.agent.list(), ctx.model.default(),
        ])
        const title = agents.data.find((agent) => agent.id === "title")?.model
        const badOptions = options.badKeys.map((key) => ({
          source: key, message: `Invalid Recap option "${key}"; using its default.`,
        }))
        let choice
        try {
          choice = selectRecapModel({
            explicit: options.model,
            title: title ? toRef(title) : undefined,
            fallback: selected.data ? toRef(selected.data) : undefined,
            available: models.data.map((model) => toRef(model)),
          })
        } catch (error) {
          const cause = error instanceof Error ? error.message : String(error)
          throw new Error(`${badOptions.map((item) => item.message).join(" ")} ${cause}`.trim())
        }
        const generated = await ctx.generate.text({
          prompt: (input as { prompt: string }).prompt,
          model: { providerID: choice.model.providerID, id: choice.model.modelID },
        }, { signal: context.signal })
        return { text: generated.text, warnings: [...badOptions, ...choice.warnings] }
      },
    })
  },
})
