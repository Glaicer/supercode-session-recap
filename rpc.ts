import { Rpc } from "@opencode/plugin/rpc"

export const Recap = Rpc.define({
  id: "supercode.recap",
  methods: {
    summarize: {
      input: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
