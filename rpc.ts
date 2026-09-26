import { Rpc } from "@opencode/plugin/rpc"
import type { RecapWarning } from "./recap-model.ts"

export type RecapSummarizeOutput = { text: string; warnings: RecapWarning[] }
export type RecapSettingsOutput = { budget: number; timeout_ms: number }

export const Recap = Rpc.define({
  id: "supercode.recap",
  methods: {
    settings: {
      input: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          budget: { type: "number" },
          timeout_ms: { type: "number" },
        },
        required: ["budget", "timeout_ms"],
        additionalProperties: false,
      },
    },
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
