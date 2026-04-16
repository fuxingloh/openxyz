import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

// opencode.ai's hosted OpenAI-compatible gateway (mnemonic/025).
// `public` is the free-tier key; set `OPENCODE_API_KEY` to use your own.
const zen = createOpenAICompatible({
  name: "opencode-zen",
  apiKey: process.env.OPENCODE_API_KEY ?? "public",
  baseURL: "https://opencode.ai/zen/v1",
});

/** Usage: `opencode("big-pickle")`. */
export default function opencode(modelId: string): LanguageModel {
  return zen(modelId);
}
