import type { BunPlugin } from "bun";
import { SUPPORTED_PROVIDERS } from "../../../models/providers/_api";

/**
 * Build-time prefetch of `https://models.dev/api.json` plus a Bun plugin
 * that bakes the resulting map into `models/providers/_api.ts` during
 * `openxyz build`. Zero runtime HTTP for covered models; unknown models
 * fall through to the runtime short-TTL cache in `_api.ts`.
 *
 * Two prefetch modes:
 *
 * 1. **Specific model** — `OPENXYZ_MODEL` is set in the build env. We
 *    fetch exactly that model's limit. Smallest bundle, only thing the
 *    runtime ever needs.
 * 2. **All supported providers** — `OPENXYZ_MODEL` is unset (e.g. deploy
 *    pipeline builds without knowing the runtime env). We fetch every
 *    tool-calling model in our shipped providers so any choice at runtime
 *    is covered. Larger bundle (~26 KB), no runtime HTTP for known models.
 *
 * Fail-open: if models.dev is unreachable at build, we bake `{}` and let
 * the runtime three-tier lookup handle it (mnemonic/087).
 */

type ModelEntry = {
  limit?: { context?: number };
  tool_call?: boolean;
};

type ApiResponse = Record<string, { models?: Record<string, ModelEntry> }>;

export async function prefetchForBuild(
  openxyzModel: string | undefined,
): Promise<Record<string, { context?: number }>> {
  const data = await fetchApi();
  if (!data) return {};

  if (openxyzModel) {
    // Mode 1: one specific model
    const sep = openxyzModel.indexOf("/");
    if (sep === -1) return {};
    const providerId = openxyzModel.slice(0, sep);
    const modelId = openxyzModel.slice(sep + 1);
    const ctx = data[providerId]?.models?.[modelId]?.limit?.context;
    if (typeof ctx === "number") {
      return { [`${providerId}/${modelId}`]: { context: ctx } };
    }
    return {};
  }

  // Mode 2: all tool-calling models in supported providers
  const out: Record<string, { context?: number }> = {};
  for (const providerId of SUPPORTED_PROVIDERS) {
    const provider = data[providerId];
    if (!provider?.models) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!model.tool_call) continue;
      const ctx = model.limit?.context;
      if (typeof ctx === "number") {
        out[`${providerId}/${modelId}`] = { context: ctx };
      }
    }
  }
  return out;
}

async function fetchApi(): Promise<ApiResponse | null> {
  try {
    const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
    return (await res.json()) as ApiResponse;
  } catch (err) {
    console.warn("[openxyz] models.dev prefetch failed — runtime fallback will apply", err);
    return null;
  }
}

/**
 * Bun plugin that replaces the empty `prefetched` literal inside
 * `models/providers/_api.ts` with the pre-resolved map captured by
 * `prefetchForBuild` at build time.
 */
export function modelsApiPrefetchPlugin(prefetched: Record<string, { context?: number }>): BunPlugin {
  const apiPath = new URL("../../../models/providers/_api.ts", import.meta.url).pathname;
  const literal = JSON.stringify(prefetched);

  return {
    name: "openxyz-models-api-prefetch",
    setup(build) {
      build.onLoad({ filter: /[\\/]providers[\\/]_api\.ts$/ }, async (args) => {
        if (args.path !== apiPath) return;
        const source = await Bun.file(args.path).text();
        const patched = source.replace(
          /const prefetched: Registry = \{\};/,
          `const prefetched: Registry = ${literal};`,
        );
        if (patched === source) {
          throw new Error(
            `[openxyz] models-api-prefetch plugin: failed to locate \`const prefetched: Registry = {};\` in ${args.path}. ` +
              `Did the marker line change?`,
          );
        }
        return { contents: patched, loader: "ts" };
      });
    },
  };
}
