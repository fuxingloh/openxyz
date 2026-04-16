import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

// Vercel AI Gateway — routes provider-prefixed model ids (e.g. "anthropic/claude-sonnet-4-5").
// Requires `AI_GATEWAY_API_KEY`. TODO: swap to `@ai-sdk/gateway` when added as a dep.
const gateway = createOpenAICompatible({
  name: "vercel-ai-gateway",
  apiKey: process.env.AI_GATEWAY_API_KEY ?? "",
  baseURL: "https://ai-gateway.vercel.sh/v1",
});

/** Usage: `vercel("anthropic/claude-sonnet-4-5")`. */
export default function vercel(modelId: string): LanguageModel {
  return gateway(modelId);
}
