import type { LanguageModelMiddleware } from "ai";

/**
 * Providers whose SDK packages actually read the marker we stamp.
 *
 * Marker shape is **wire-protocol-scoped, not model-family-scoped** — Bedrock's
 * `cachePoint` works for any Bedrock-hosted model regardless of underlying
 * family (Claude, Nova, Llama, ...), so dispatch is per provider package, not
 * per model.
 *
 * `@ai-sdk/openai-compatible` backends (OpenRouter, Vercel Gateway,
 * opencode-zen) don't belong here — they silently drop unknown
 * `providerOptions`. See `../../../../ai/packages/openai-compatible/src/chat/
 * convert-to-openai-compatible-chat-messages.ts:16`.
 */
export type CacheProvider = "anthropic" | "bedrock";

const TAIL_BREAKPOINTS = 2;

/**
 * Stamp cache breakpoints on `params.prompt`:
 *
 * 1. **Last consecutive system at head** — the instructions frame
 *    (basePrompt + AGENTS.md + skills + agent body, built in
 *    `AgentFactory.#buildInstructions`). Largest stable prefix.
 * 2. **Last 2 non-system messages** — sliding tail. On turn N+1 the prefix
 *    through turn N is identical → cache hit on the entire history,
 *    including tool results. Re-stamping is free; only the new tail
 *    position pays a write.
 *
 * Total ≤ 3 breakpoints, well under Anthropic's 4 cap. Mirrors opencode's
 * `slice(-2)` shape (`mnemonic/093`).
 *
 * Default 5m TTL on both providers (Bedrock's `cachePoint` with no `ttl`,
 * Anthropic's `ephemeral`). Cache hits slide the TTL forward.
 *
 * Roadmap (env frame, token accounting, OpenAI `prompt_cache_key`, hard
 * 4-breakpoint counter cap) lives in `mnemonic/073` + `mnemonic/093`.
 */
export function cacheMiddleware(provider: CacheProvider): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    transformParams: async ({ params }) => {
      const prompt = params.prompt;
      if (!Array.isArray(prompt) || prompt.length === 0) return params;

      const targets = new Set<number>();

      // Instructions frame: last consecutive system at the head.
      for (let i = 0; i < prompt.length; i++) {
        if (prompt[i]!.role !== "system") break;
        targets.clear();
        targets.add(i);
      }

      // Sliding tail: last N non-system messages. Captures the growing
      // conversation prefix so subsequent turns hit cache for everything
      // before the new tail position.
      let tailFound = 0;
      for (let i = prompt.length - 1; i >= 0 && tailFound < TAIL_BREAKPOINTS; i--) {
        if (prompt[i]!.role === "system") continue;
        targets.add(i);
        tailFound++;
      }

      if (targets.size === 0) return params;

      const stamped = prompt.map((msg, i) => (targets.has(i) ? withMarker(msg, provider) : msg));
      return { ...params, prompt: stamped };
    },
  };
}

type WithProviderOptions = { providerOptions?: Record<string, Record<string, unknown>> };

/**
 * Per-provider marker dialect:
 * - bedrock    → `providerOptions.bedrock.cachePoint = { type: "default" }`
 * - anthropic  → `providerOptions.anthropic.cacheControl = { type: "ephemeral" }`
 *
 * Merged into existing `providerOptions[provider]` so it composes with other
 * per-provider hints (reasoning, beta flags) the model wrapper may have set.
 */
function withMarker<M extends WithProviderOptions>(msg: M, provider: CacheProvider): M {
  const marker = provider === "bedrock" ? { cachePoint: { type: "default" } } : { cacheControl: { type: "ephemeral" } };

  return {
    ...msg,
    providerOptions: {
      ...(msg.providerOptions ?? {}),
      [provider]: { ...(msg.providerOptions?.[provider] ?? {}), ...marker },
    },
  };
}
