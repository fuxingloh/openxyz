/**
 * Shared models.dev HTTP + limit-lookup for shipped providers (underscore
 * prefix keeps it hidden from the scanner). Three-tier lookup for per-model
 * limits from `models.dev/api.json`:
 *
 * 1. **Build-time prefetch** — `models-dev-prefetch` Bun plugin replaces
 *    the empty `prefetched` literal below with a baked map during
 *    `openxyz build`. Covers the known-model case (OPENXYZ_MODEL set) or
 *    all tool-calling models in our supported providers (OPENXYZ_MODEL
 *    unset). Zero runtime HTTP for covered models.
 * 2. **Runtime short-TTL cache** — when tier 1 misses (template uses an
 *    unknown model, or start.ts without a build), one live fetch warms a
 *    cache that auto-clears after `CACHE_TTL_MS` via `setTimeout.unref`
 *    so we don't pin ~200 KB of parsed limits in RAM indefinitely.
 * 3. **Live fetch** — actual HTTP to models.dev, 5s timeout, fail-open.
 *
 * See mnemonic/087.
 */

export type ModelLimit = {
  context?: number;
};

type Registry = Record<string, ModelLimit>;

/**
 * Providers openxyz ships. Shared with the build-time prefetch plugin so
 * both the baked map and the runtime live-fetch fall-back filter against
 * the same list. Template-provided models using other ai-sdk providers
 * (anthropic-direct, openai-direct, …) fall through to the runtime
 * 200K default — see mnemonic/088.
 *
 * **When changing OPENXYZ_MODEL or when models.dev adds a new model,
 * rebuild** — the plugin bakes at build time; new entries only appear in
 * the bundle on a fresh build. Runtime live fetch covers them too but
 * costs one HTTP round-trip per fresh process.
 */
export const SUPPORTED_PROVIDERS = ["amazon-bedrock", "openrouter", "vercel", "opencode"] as const;

/**
 * Cleared automatically after `CACHE_TTL_MS`. Short enough that idle
 * processes don't hold ~200 KB of parsed limits forever; long enough that
 * a burst of lookups during startup shares one fetch.
 */
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Build-time prefetched map — the Bun plugin rewrites this literal during
 * `openxyz build`. Stays empty at start-time, which is fine: tier 2/3 cover
 * that path without the bundle-size cost.
 */
const prefetched: Registry = {};

let liveCache: { map: Registry; expiresAt: number } | null = null;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Look up a model's limit by models.dev identity (`providerId/modelId`).
 * Returns `undefined` if no source has the model — callers treat that as
 * "unknown, use DEFAULT_CONTEXT_TOKENS downstream".
 */
export async function lookupLimit(providerId: string, modelId: string): Promise<ModelLimit | undefined> {
  const key = `${providerId}/${modelId}`;

  // Tier 1: build-time prefetch
  if (prefetched[key]) return prefetched[key];

  // Tier 2: runtime short-TTL cache
  const now = Date.now();
  if (liveCache && now < liveCache.expiresAt) {
    return liveCache.map[key];
  }

  // Tier 3: live fetch — warm the cache
  const map = await liveFetch();
  liveCache = { map, expiresAt: now + CACHE_TTL_MS };

  // Auto-cleanup: drop the ~200 KB cache object after TTL. `.unref()` so
  // the timer doesn't keep CLI/serverless processes alive.
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    liveCache = null;
    clearTimer = undefined;
  }, CACHE_TTL_MS);
  clearTimer.unref?.();

  return map[key];
}

async function liveFetch(): Promise<Registry> {
  try {
    const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, { models?: Record<string, { limit?: { context?: number } }> }>;
    // Filter to the providers we ship — matches the build-time prefetch
    // scope. Template-provided models using other ai-sdk providers fall
    // through to the runtime 200K default (mnemonic/088).
    const out: Registry = {};
    for (const providerId of SUPPORTED_PROVIDERS) {
      const provider = data[providerId];
      if (!provider?.models) continue;
      for (const [modelId, model] of Object.entries(provider.models)) {
        if (typeof model.limit?.context === "number") {
          out[`${providerId}/${modelId}`] = { context: model.limit.context };
        }
      }
    }
    return out;
  } catch (err) {
    // One-time warning; subsequent lookups this window hit the empty cache.
    console.warn("[openxyz] models.dev fetch failed — lookups return undefined", err);
    return {};
  }
}
