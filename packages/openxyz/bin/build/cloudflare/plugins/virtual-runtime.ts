import type { BunPlugin } from "bun";

/**
 * Materializes `openxyz/_runtime` for the **Cloudflare** build. Re-exports
 * the runtime surface the generated worker needs:
 *
 *  - shared: OpenXyz, WorkspaceDrive, loadChannel, loadModel, loadTools
 *  - cloudflare-specific: createCloudflareState, ChatStateDO
 *
 * Notably **does not** re-export `waitUntil` — on Workers, waitUntil is the
 * `ctx.waitUntil` bound at request time, supplied to chat-sdk's webhook
 * handler from the fetch handler signature, not from a virtual import.
 *
 * Also **does not** re-export `getDb` / `TursoStateAdapter` — Turso is
 * Vercel-only. The CF state path goes entirely through
 * `chat-state-cloudflare-do`'s SQLite-backed Durable Object.
 */
export function virtualRuntimePlugin(): BunPlugin {
  const runtimeRoot = new URL("../../../../../openxyz-runtime/", import.meta.url).pathname;
  const openxyzRoot = new URL("../../../../", import.meta.url).pathname;
  const loadChannel = new URL("../../../load-channel.ts", import.meta.url).pathname;
  const loadModel = new URL("../../../load-model.ts", import.meta.url).pathname;
  const loadTools = new URL("../../../load-tools.ts", import.meta.url).pathname;
  const stateCfDo = Bun.resolveSync("chat-state-cloudflare-do", openxyzRoot);

  return {
    name: "openxyz-virtual-runtime-cloudflare",
    setup(build) {
      build.onResolve({ filter: /^openxyz\/_runtime$/ }, (args) => ({
        path: args.path,
        namespace: "openxyz-runtime",
      }));
      build.onLoad({ filter: /.*/, namespace: "openxyz-runtime" }, () => ({
        loader: "ts",
        contents: [
          `export { OpenXyz, formatLoadError } from ${JSON.stringify(runtimeRoot + "openxyz.ts")};`,
          `export { WorkspaceDrive } from ${JSON.stringify(runtimeRoot + "workspace.ts")};`,
          `export { loadChannel } from ${JSON.stringify(loadChannel)};`,
          `export { loadModel } from ${JSON.stringify(loadModel)};`,
          `export { loadTools } from ${JSON.stringify(loadTools)};`,
          `export { createCloudflareState, ChatStateDO } from ${JSON.stringify(stateCfDo)};`,
        ].join("\n"),
      }));
    },
  };
}
