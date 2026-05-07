import { mkdirSync, rmSync } from "node:fs";
import { resolve, relative, join, basename } from "node:path";
import { parseAgent } from "../../parsers/agent";
import { scanDir, type OpenXyzFiles } from "../../scan";
import { generateEntrypoint } from "./entrypoint";
import { generateWranglerJsonc } from "./wrangler";
import { virtualRuntimePlugin } from "./plugins/virtual-runtime";
import { vfileBrowserShimPlugin } from "./plugins/vfile-browser-shim";
import { isomorphicGitHttpShimPlugin } from "./plugins/isomorphic-git-http-shim";
import { inMemoryWorkspacePlugin } from "../plugins/in-memory-workspace";
import { modelsApiPrefetchPlugin } from "../plugins/models-api-prefetch";
import { prefetchForBuild } from "../../../models/providers/_api";

// Pin compatibility_date to a known-stable past date instead of `new Date()`.
// Wrangler/workerd in the CI build image only knows compat dates up to its
// release; setting today's date when wrangler is older than that breaks
// `nodejs_compat` resolution (`No such module "node:process"` etc.). Bump
// deliberately when we want newer compat semantics.
// 2024-09-23 is the inflection point that put `node:process`/`node:buffer`
// into the default `nodejs_compat` set — needed by vfile (via chat-sdk's
// markdown pipeline) and yaml.
const COMPATIBILITY_DATE = "2025-01-15";

export async function buildCloudflare(cwd: string): Promise<void> {
  const files = await scanDir(cwd);

  if (Object.keys(files.template.channels).length === 0) {
    console.error("[openxyz] no channels found under channels/*.{js,ts} — nothing to build");
    process.exit(1);
  }

  const defaultAgents = await loadDefaultAgents();
  const usedModels = await collectReferencedModels(files, defaultAgents);

  const buildDir = resolve(cwd, ".openxyz/build");
  mkdirSync(buildDir, { recursive: true });
  const entrypoint = resolve(buildDir, "worker.ts");

  await Bun.write(entrypoint, await generateEntrypoint(files, usedModels, defaultAgents));

  const distDir = resolve(cwd, "dist");
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  console.log("▶ Prefetching models.dev");
  const prefetchedLimits = await prefetchForBuild(process.env.OPENXYZ_MODEL);
  console.log(`  ${Object.keys(prefetchedLimits).length} models settings baked into the bundle`);

  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: distDir,
    naming: "_worker.js",
    target: "node",
    format: "esm",
    sourcemap: "linked",
    // `cloudflare:*` virtuals (cloudflare:workers, cloudflare:sockets, ...)
    // only exist inside the Workers runtime — Bun must leave them as
    // bare imports so workerd can resolve them at deploy time.
    external: ["cloudflare:*"],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.OPENXYZ_PLATFORM": JSON.stringify("cloudflare"),
      // Bun.build emits a top-level `createRequire(import.meta.url)` shim for
      // CommonJS interop. Workers' deploy-time validation harness evaluates
      // the module with `import.meta.url` undefined and the shim throws
      // ("argument 'path' must be a file URL ... received 'undefined'").
      // Stub it so the shim is constructible; lazy `__require()` calls inside
      // CJS module factories only fire if the export is reached, so the
      // hot path (chat-sdk webhooks → AI SDK → state DO) stays clean.
      "import.meta.url": JSON.stringify("file:///worker.js"),
    },
    plugins: [
      inMemoryWorkspacePlugin(cwd, files.files),
      virtualRuntimePlugin(),
      vfileBrowserShimPlugin(),
      isomorphicGitHttpShimPlugin(),
      modelsApiPrefetchPlugin(prefetchedLimits),
    ],
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  // wrangler.jsonc — name defaults to the template directory's name. The
  // user can override later by hand-editing; we don't clobber an existing
  // file (preserves any custom routes / vars / secrets binding).
  const wranglerPath = resolve(cwd, "wrangler.jsonc");
  const exists = await Bun.file(wranglerPath).exists();
  if (!exists) {
    await Bun.write(
      wranglerPath,
      generateWranglerJsonc({ name: basename(cwd), compatibility_date: COMPATIBILITY_DATE }),
    );
  }

  console.log("");
  console.log("Build complete! Output:");
  console.log(`  ${relative(cwd, resolve(distDir, "_worker.js"))}`);
  console.log(`  ${relative(cwd, wranglerPath)}${exists ? " (existing — not overwritten)" : ""}`);
}

async function loadDefaultAgents(): Promise<Record<string, string>> {
  const dir = new URL("../../../agents/", import.meta.url).pathname;
  const out: Record<string, string> = {};
  for await (const file of new Bun.Glob("*.md").scan({ cwd: dir })) {
    out[file.replace(/\.md$/, "")] = join(dir, file);
  }
  return out;
}

async function collectReferencedModels(scan: OpenXyzFiles, shipped: Record<string, string>): Promise<Set<string>> {
  const merged: Record<string, string> = { ...shipped };
  for (const [name, rel] of Object.entries(scan.template.agents)) {
    merged[name] = join(scan.cwd, rel);
  }
  const used = new Set<string>();
  for (const [name, path] of Object.entries(merged)) {
    const raw = await Bun.file(path).text();
    const def = parseAgent(name, raw);
    if (def) used.add(def.model);
  }
  return used;
}
