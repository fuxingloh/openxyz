import type { LanguageModel } from "ai";

/**
 * Picks a provider at call time based on `OPENXYZ_MODEL`, e.g.:
 *
 * ```env
 * OPENXYZ_MODEL=openrouter/z-ai/glm-4.6
 * OPENXYZ_MODEL=vercel/anthropic/claude-sonnet-4-5
 * OPENXYZ_MODEL=bedrock/zai.glm-5.0
 * OPENXYZ_MODEL=opencode/big-pickle
 *```
 *
 * Splits on the first `/` only — the provider is the left half, the rest
 * (which may itself contain `/`) is passed through as the model id. Provider
 * modules are dynamic-imported so only the chosen one loads.
 */
export default async function auto(): Promise<LanguageModel> {
  if (process.env.OPENXYZ_MODEL === undefined) {
    throw new Error("OPENXYZ_MODEL environment variable is not set");
  }

  const sep = process.env.OPENXYZ_MODEL.indexOf("/");
  const provider = sep === -1 ? process.env.OPENXYZ_MODEL : process.env.OPENXYZ_MODEL.slice(0, sep);
  const modelId = sep === -1 ? "" : process.env.OPENXYZ_MODEL.slice(sep + 1);

  switch (provider) {
    case "opencode":
      return (await import("./providers/opencode")).default(modelId);
    case "bedrock":
      return (await import("./providers/bedrock")).default(modelId);
    case "openrouter":
      return (await import("./providers/openrouter")).default(modelId);
    case "vercel":
      return (await import("./providers/vercel")).default(modelId);
    default:
      throw new Error(`Unsupported OPENXYZ_MODEL provider: ${provider}`);
  }
}
