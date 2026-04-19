import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelExport } from "../../bin/load-model";
import { lookupLimit } from "../_models-dev";

// opencode.ai's hosted OpenAI-compatible gateway (mnemonic/025).
// `public` is the free-tier key; set `OPENCODE_API_KEY` to use your own.
const zen = createOpenAICompatible({
  name: "opencode-zen",
  apiKey: process.env.OPENCODE_API_KEY ?? "public",
  baseURL: "https://opencode.ai/zen/v1",
});

/**
 * Usage: `opencode("big-pickle")`. No cache-control wrap — `@ai-sdk/openai-compatible`
 * drops non-`openaiCompatible` providerOptions, so the anthropic/bedrock markers
 * don't reach the wire. See `_cache.ts` follow-up notes.
 *
 * `limit` resolved from models.dev. opencode zen isn't a first-class
 * provider on models.dev — left as a best-effort lookup under the `opencode`
 * key; undefined if unlisted (fail-open, universal 40K threshold applies).
 * No `systemPrompt` — runtime falls back to its default.
 */
export default async function opencode(modelId: string): Promise<ModelExport> {
  return Object.assign(zen(modelId), {
    limit: await lookupLimit("opencode", modelId),
  });
}
