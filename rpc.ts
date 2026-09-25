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
        properties: {
          text: { type: "string" },
          warnings: {
            type: "array",
            items: {
              type: "object",
              properties: { source: { type: "string" }, message: { type: "string" } },
              required: ["source", "message"],
              additionalProperties: false,
            },
          },
        },
        required: ["text", "warnings"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
