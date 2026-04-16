import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

// OpenRouter's OpenAI-compatible gateway. Requires `OPENROUTER_API_KEY`.
// See https://openrouter.ai/docs for available model ids.
const or = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  baseURL: "https://openrouter.ai/api/v1",
});

/** Usage: `openrouter("z-ai/glm-4.6")`. */
export default function openrouter(modelId: string): LanguageModel {
  return or(modelId);
}
