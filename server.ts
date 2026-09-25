import { Plugin } from "@opencode/plugin"
import { Recap } from "./rpc.ts"

export default Plugin.define({
  id: "supercode.recap.server",
  async setup(ctx) {
    await ctx.rpc.register(Recap, {
      summarize: async (input) => {
        const selected = await ctx.model.default()
        const model = selected.data
        if (!model) throw new Error("No available Recap model at this location")
        const generated = await ctx.generate.text({
          prompt: (input as { prompt: string }).prompt,
          model: { providerID: model.providerID, id: model.id },
        })
        return { text: generated.text }
      },
    })
  },
})
