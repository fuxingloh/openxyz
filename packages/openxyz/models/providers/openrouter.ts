import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelExport } from "../../bin/load-model";
import { lookupLimit } from "../_models-dev";

// OpenRouter's OpenAI-compatible gateway. Requires `OPENROUTER_API_KEY`.
// See https://openrouter.ai/docs for available model ids.
const or = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  baseURL: "https://openrouter.ai/api/v1",
});

/**
 * Usage: `openrouter("z-ai/glm-4.6")`. No cache-control wrap — routed through
 * `@ai-sdk/openai-compatible`, which drops anthropic-style markers. Prompt
 * caching here would need `providerOptions.openaiCompatible.cache_control` and
 * verification that OpenRouter forwards it upstream.
 *
 * `limit` resolved from models.dev (`openrouter` provider key). No
 * `systemPrompt` — runtime falls back to its default.
 */
export default async function openrouter(modelId: string): Promise<ModelExport> {
  return Object.assign(or(modelId), {
    limit: await lookupLimit("openrouter", modelId),
  });
}
