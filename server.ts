import { Plugin } from "@opencode/plugin"
import { Recap } from "./rpc.ts"
import { parseRecapOptions, selectRecapModel } from "./recap-model.ts"

export default Plugin.define({
  id: "supercode.recap.server",
  async setup(ctx) {
    const options = parseRecapOptions(ctx.options)
    await ctx.rpc.register(Recap, {
      summarize: async (input) => {
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
            title: title ? { providerID: title.providerID, modelID: title.id } : undefined,
            fallback: selected.data ? { providerID: selected.data.providerID, modelID: selected.data.id } : undefined,
            available: models.data.map((model) => ({ providerID: model.providerID, modelID: model.id })),
          })
        } catch (error) {
          const cause = error instanceof Error ? error.message : String(error)
          throw new Error(`${badOptions.map((item) => item.message).join(" ")} ${cause}`.trim())
        }
        const generated = await ctx.generate.text({
          prompt: (input as { prompt: string }).prompt,
          model: { providerID: choice.model.providerID, id: choice.model.modelID },
        })
        return { text: generated.text, warnings: [...badOptions, ...choice.warnings] }
      },
    })
  },
})
