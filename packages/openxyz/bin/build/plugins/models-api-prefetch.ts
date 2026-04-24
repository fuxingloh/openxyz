import type { BunPlugin } from "bun";

/**
 * Bun plugin that replaces the empty `prefetched` literal inside
 * `models/providers/_api.ts` with the pre-resolved map captured at build
 * time (via `prefetchForBuild` in that same file). Zero runtime HTTP for
 * covered models; unknown models fall through to the runtime short-TTL
 * cache. See mnemonic/087.
 */
export function modelsApiPrefetchPlugin(
  prefetched: Record<string, { context?: number; input?: number; output?: number }>,
): BunPlugin {
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
