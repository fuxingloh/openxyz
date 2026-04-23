import type { BunPlugin } from "bun";

/**
 * Bun plugin that materializes `openxyz/_runtime` — a virtual module that
 * only exists during `openxyz build`. It re-exports the runtime surface the
 * generated entrypoint needs.
 *
 * The template depends on `openxyz`, not `@openxyz/runtime`, so we can't
 * import `@openxyz/runtime/*` directly from the generated file. The virtual
 * module sits inside the `openxyz` package tree (`resolveDir`), where
 * `@openxyz/runtime` is a declared dep and therefore resolvable.
 */
export function virtualRuntimePlugin(): BunPlugin {
  // Resolve runtime by absolute path — Bun's virtual-namespace loader has
  // uneven support for bare subpath resolution past the top level. Absolute
  // paths bypass package resolution entirely and always work.
  const runtimeRoot = new URL("../../../../openxyz-runtime/", import.meta.url).pathname;
  const openxyzRoot = new URL("../../../", import.meta.url).pathname;
  const loadChannel = new URL("../../load-channel.ts", import.meta.url).pathname;
  const loadModel = new URL("../../load-model.ts", import.meta.url).pathname;
  const loadTools = new URL("../../load-tools.ts", import.meta.url).pathname;
  const vercelFunctions = Bun.resolveSync("@vercel/functions", openxyzRoot);
  const stateTurso = Bun.resolveSync("@chat-adapter/state-turso", openxyzRoot);

  return {
    name: "openxyz-virtual-runtime",
    setup(build) {
      build.onResolve({ filter: /^openxyz\/_runtime$/ }, (args) => ({
        path: args.path,
        namespace: "openxyz-runtime",
      }));
      build.onLoad({ filter: /.*/, namespace: "openxyz-runtime" }, () => ({
        loader: "ts",
        contents: [
          `export { OpenXyz } from ${JSON.stringify(runtimeRoot + "openxyz.ts")};`,
          `export { getDb } from ${JSON.stringify(runtimeRoot + "databases/index.ts")};`,
          `export { TursoStateAdapter } from ${JSON.stringify(stateTurso)};`,
          `export { WorkspaceDrive } from ${JSON.stringify(runtimeRoot + "workspace.ts")};`,
          `export { loadChannel } from ${JSON.stringify(loadChannel)};`,
          `export { loadModel } from ${JSON.stringify(loadModel)};`,
          `export { loadTools } from ${JSON.stringify(loadTools)};`,
          `export { waitUntil } from ${JSON.stringify(vercelFunctions)};`,
        ].join("\n"),
      }));
    },
  };
}
