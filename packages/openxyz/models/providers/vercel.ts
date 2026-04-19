import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelExport } from "../../bin/load-model";
import { lookupLimit } from "../_models-dev";

// Vercel AI Gateway — routes provider-prefixed model ids (e.g. "anthropic/claude-sonnet-4-5").
// Requires `AI_GATEWAY_API_KEY`. TODO: swap to `@ai-sdk/gateway` when added as a dep.
const gateway = createOpenAICompatible({
  name: "vercel-ai-gateway",
  apiKey: process.env.AI_GATEWAY_API_KEY ?? "",
  baseURL: "https://ai-gateway.vercel.sh/v1",
});

/**
 * Usage: `vercel("anthropic/claude-sonnet-4-5")`. No cache-control wrap —
 * routed through `@ai-sdk/openai-compatible`, which drops anthropic markers.
 * Swap to `@ai-sdk/gateway` and re-wire caching there when that migration lands.
 *
 * `limit` resolved from models.dev (`vercel` provider key). No
 * `systemPrompt` — runtime falls back to its default.
 */
export default async function vercel(modelId: string): Promise<ModelExport> {
  return Object.assign(gateway(modelId), {
    limit: await lookupLimit("vercel", modelId),
  });
}
