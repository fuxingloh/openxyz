import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { parseAgent } from "@openxyz/runtime/agents/factory";
import { scanDir, type OpenXyzFiles } from "../scan";
import { generateEntrypoint } from "./entrypoint";
import { FAVICON_SVG, generateFaviconIco } from "./favicon";
import { virtualRuntimePlugin } from "./plugins/virtual-runtime";
import { inMemoryWorkspacePlugin } from "./plugins/in-memory-workspace";
import { modelsApiPrefetchPlugin } from "./plugins/models-api-prefetch";
import { forceTursoServerlessPlugin } from "./plugins/force-turso-serverless";
import { prefetchForBuild } from "../../models/providers/_api";

export async function buildVercel(cwd: string): Promise<void> {
  const files = await scanDir(cwd);

  if (Object.keys(files.template.channels).length === 0) {
    console.error("[openxyz] no channels found under channels/*.{js,ts} — nothing to build");
    process.exit(1);
  }

  const defaultAgents = await loadDefaultAgents();
  const usedModels = await collectReferencedModels(files, defaultAgents);

  const buildDir = resolve(cwd, ".openxyz/build");
  mkdirSync(buildDir, { recursive: true });
  const entrypoint = resolve(buildDir, "server.ts");

  await Bun.write(entrypoint, await generateEntrypoint(files, usedModels, defaultAgents));

  const outputDir = resolve(cwd, ".vercel/output");
  rmSync(outputDir, { recursive: true, force: true });
  const funcDir = resolve(outputDir, "functions/index.func");
  mkdirSync(funcDir, { recursive: true });

  // Fetch once before the bundle — mode 1 if OPENXYZ_MODEL is set (single
  // entry, tiny payload), mode 2 otherwise (every tool-calling model in our
  // supported providers). Fail-open: unreachable models.dev returns `{}`
  // and runtime cache picks up the slack.
  console.log("▶ Prefetching models.dev");
  const prefetchedLimits = await prefetchForBuild(process.env.OPENXYZ_MODEL);
  console.log(`  ${Object.keys(prefetchedLimits).length} models settings baked into the bundle`);

  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: funcDir,
    naming: "server.js",
    target: "bun",
    format: "esm",
    sourcemap: "linked",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.OPENXYZ_BACKEND": JSON.stringify("vercel"),
    },
    plugins: [
      inMemoryWorkspacePlugin(cwd, files.files),
      virtualRuntimePlugin(),
      modelsApiPrefetchPlugin(prefetchedLimits),
      forceTursoServerlessPlugin(),
    ],
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  await Bun.write(
    resolve(funcDir, ".vc-config.json"),
    JSON.stringify(
      {
        handler: "server.js",
        runtime: "bun1.x",
        launcherType: "Bun",
        shouldAddHelpers: true,
        shouldAddSourcemapSupport: true,
        // LLM streams + tool loops can run long. Vercel's hard cap is 300s
        // on Pro (900s on Enterprise). Setting 300 gives us headroom; the
        // function still shuts down when work finishes via waitUntil.
        maxDuration: 300,
      },
      null,
      2,
    ),
  );

  await Bun.write(resolve(funcDir, "package.json"), JSON.stringify({ type: "module" }, null, 2));

  await Bun.write(
    resolve(outputDir, "config.json"),
    JSON.stringify(
      {
        version: 3,
        // Static assets first (favicon, etc.), webhook paths to the function,
        // everything else 404s at the edge. The trailing `status: 404` rule
        // is needed — without it Vercel routes unmatched paths to the
        // function-at-root by default (which then just 404s but wakes the
        // lambda for every bot/scanner hit).
        routes: [{ handle: "filesystem" }, { src: "/api/webhooks/([^/]+)/?", dest: "/" }, { src: "/.*", status: 404 }],
      },
      null,
      2,
    ),
  );

  // Static assets: ship both favicon.svg (modern browsers) and favicon.ico
  // (legacy user-agents and the reflexive GET /favicon.ico Vercel serves).
  const staticDir = resolve(outputDir, "static");
  mkdirSync(staticDir, { recursive: true });
  await Bun.write(resolve(staticDir, "favicon.svg"), FAVICON_SVG);
  await Bun.write(resolve(staticDir, "favicon.ico"), await generateFaviconIco(FAVICON_SVG));

  const copied = copyEnvFiles(cwd, funcDir);

  console.log("");
  console.log("Build complete! Output:");
  console.log(`  ${relative(cwd, resolve(outputDir, "config.json"))}`);
  console.log(`  ${relative(cwd, resolve(funcDir, "server.js"))}`);
  console.log(`  ${relative(cwd, staticDir)}/`);
  for (const f of copied) console.log(`  ${relative(cwd, resolve(funcDir, f))}`);
}

/**
 * openxyz-shipped agents live at `packages/openxyz/agents/*.md` next to the
 * CLI. Returns a name→absolute-path map, same shape as `scan.template.agents`.
 * TODO: add a toggle so templates can opt out.
 */
async function loadDefaultAgents(): Promise<Record<string, string>> {
  const dir = new URL("../../agents/", import.meta.url).pathname;
  const out: Record<string, string> = {};
  for await (const file of new Bun.Glob("*.md").scan({ cwd: dir })) {
    out[file.replace(/\.md$/, "")] = join(dir, file);
  }
  return out;
}

/**
 * Walk every agent (shipped + template) via the real `parseAgent` and collect
 * the set of model names they reference. Template entries override shipped
 * ones by name, matching the runtime merge order in `loadRuntime`.
 */
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

function copyEnvFiles(cwd: string, outputDir: string): string[] {
  const files = [".env", ".env.production"];
  const copied: string[] = [];
  for (const f of files) {
    const src = resolve(cwd, f);
    if (existsSync(src)) {
      cpSync(src, resolve(outputDir, f));
      copied.push(f);
    }
  }
  return copied;
}
