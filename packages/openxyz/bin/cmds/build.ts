import type { BunPlugin } from "bun";
import { Command } from "commander";
import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import sharp from "sharp";
import { parseAgent } from "@openxyz/harness/agents/factory";
import { parseSkill } from "@openxyz/harness/tools/skill";
import { scanDir, type OpenXyzFiles } from "../scan";

const FAVICON_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="24" height="24" fill="black"/>
<path d="M7.4686 3L11.9324 10.4883H12.0676L16.5314 3H19L13.5556 12L19 21H16.5314L12.0676 13.6523H11.9324L7.4686 21H5L10.5797 12L5 3H7.4686Z" fill="white"/>
<path d="M20 12C20 13.8479 19.6549 15.4449 18.9646 16.7909C18.2743 18.1369 17.3274 19.1749 16.1239 19.9049C14.9204 20.635 13.5457 21 12 21C10.4543 21 9.07965 20.635 7.87611 19.9049C6.67257 19.1749 5.72566 18.1369 5.0354 16.7909C4.34513 15.4449 4 13.8479 4 12C4 10.1521 4.34513 8.55513 5.0354 7.20913C5.72566 5.86312 6.67257 4.8251 7.87611 4.09506C9.07965 3.36502 10.4543 3 12 3C13.5457 3 14.9204 3.36502 16.1239 4.09506C17.3274 4.8251 18.2743 5.86312 18.9646 7.20913C19.6549 8.55513 20 10.1521 20 12ZM17.8761 12C17.8761 10.4829 17.6136 9.20247 17.0885 8.15875C16.5693 7.11502 15.8643 6.3251 14.9735 5.78897C14.0885 5.25285 13.0973 4.98479 12 4.98479C10.9027 4.98479 9.90855 5.25285 9.0177 5.78897C8.13274 6.3251 7.42773 7.11502 6.90265 8.15875C6.38348 9.20247 6.12389 10.4829 6.12389 12C6.12389 13.5171 6.38348 14.7975 6.90265 15.8413C7.42773 16.885 8.13274 17.6749 9.0177 18.211C9.90855 18.7471 10.9027 19.0152 12 19.0152C13.0973 19.0152 14.0885 18.7471 14.9735 18.211C15.8643 17.6749 16.5693 16.885 17.0885 15.8413C17.6136 14.7975 17.8761 13.5171 17.8761 12Z" fill="white"/>
</svg>
`;

/**
 * Render the inline SVG to a 32×32 PNG via sharp, then wrap it in an ICO
 * container. Modern browsers accept PNG-embedded ICOs — same approach aixyz
 * uses (packages/aixyz-cli/build/icons.ts).
 */
async function generateFaviconIco(svg: string): Promise<Uint8Array> {
  const png = await sharp(Buffer.from(svg))
    .resize(32, 32, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes) + PNG payload.
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = ICO
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry.writeUInt8(32, 0); // width
  entry.writeUInt8(32, 1); // height
  entry.writeUInt8(0, 2); // color count (0 = true color)
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // image data size
  entry.writeUInt32LE(22, 12); // image data offset (6 + 16)

  return Buffer.concat([header, entry, png]);
}

export default new Command("build")
  .description("Build the openxyz agent for deployment")
  .option("--output <type>", "Output target: 'vercel'", "vercel")
  .action(action);

type Opts = { output: string };

async function action(opts: Opts): Promise<void> {
  const cwd = process.cwd();
  process.env.NODE_ENV = "production";

  const target = opts.output ?? (process.env.VERCEL === "1" ? "vercel" : "vercel");
  if (target !== "vercel") {
    console.error(`[openxyz] unsupported --output '${target}'. Only 'vercel' is supported in v1.`);
    process.exit(1);
  }

  console.log(`▶ Building for Vercel...`);
  await buildVercel(cwd);
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

async function generateEntrypoint(
  scan: OpenXyzFiles,
  usedModels: Set<string>,
  defaultAgents: Record<string, string>,
): Promise<string> {
  const abs = (p: string) => join(scan.cwd, p);
  const vfsPath = (p: string) => "/home/openxyz/" + p;
  // Every generated import path is emitted relative to this build dir so the
  // generated source is portable (no machine-specific absolute paths baked in).
  // `Bun.build` still inlines the content, but the intermediate file is clean.
  const buildDir = join(scan.cwd, ".openxyz/build");
  const toRel = (p: string) => {
    const r = relative(buildDir, p);
    return r.startsWith(".") ? r : "./" + r;
  };
  // Path to openxyz's shipped `models/auto.ts` on the build machine.
  // Injected when no template-provided `models/auto.ts` exists.
  const shippedAuto = new URL("../../models/auto.ts", import.meta.url).pathname;
  const t = scan.template;

  // Merge shipped + template agents; template wins on name collision.
  const mergedAgents: Array<{ name: string; path: string }> = [];
  for (const [name, path] of Object.entries(defaultAgents)) mergedAgents.push({ name, path });
  for (const [name, rel] of Object.entries(t.agents)) mergedAgents.push({ name, path: abs(rel) });

  const imports: string[] = [];
  const body: string[] = [];

  // Runtime bundle no longer needs `parseAgent`/`parseSkill` — we pre-parse
  // at build time below and emit JSON literals. That removes the `yaml`
  // (formerly `gray-matter`) parser from the production bundle entirely.
  // See mnemonic/068 for the gray-matter→yaml crash story.
  imports.push(`import { OpenXyz, buildChannelFile, createChatState, waitUntil } from "openxyz/_harness";`);

  const channelEntries: string[] = [];
  Object.entries(t.channels).forEach(([name, path], i) => {
    const id = `__ch${i}`;
    imports.push(`import * as ${id} from ${JSON.stringify(toRel(abs(path)))};`);
    channelEntries.push(`  ${JSON.stringify(name)}: buildChannelFile(${id}, ${JSON.stringify(name)}),`);
  });

  const toolEntries: string[] = [];
  Object.entries(t.tools).forEach(([name, path], i) => {
    const id = `__tool${i}`;
    imports.push(`import ${id} from ${JSON.stringify(toRel(abs(path)))};`);
    toolEntries.push(`  ${JSON.stringify(name)}: ${id},`);
  });

  // Models: emit only names actually referenced by agents. `auto` is always
  // referenced (agents without explicit `model:` fall back to it), so if the
  // template doesn't override `models/auto.ts`, point at openxyz's shipped one.
  // Factory exports (e.g. `auto.ts` that switches on `OPENXYZ_MODEL`) are
  // resolved at boot time on the deployed function — the generated entrypoint
  // awaits them before handing the map to `OpenXyz`.
  const modelPairs: Array<{ name: string; id: string }> = [];
  let modelIdx = 0;
  for (const name of usedModels) {
    const path = t.models[name] ? abs(t.models[name]!) : name === "auto" ? shippedAuto : undefined;
    if (!path) continue; // referenced but no source — agent picking it surfaces clearly at runtime
    const id = `__model${modelIdx++}`;
    imports.push(`import ${id} from ${JSON.stringify(toRel(path))};`);
    modelPairs.push({ name, id });
  }
  const modelEntries = modelPairs.map(
    ({ name, id }) => `  ${JSON.stringify(name)}: typeof ${id} === "function" ? await ${id}() : ${id},`,
  );

  // Agents: parsed at build time, emitted as JSON literals. No runtime
  // `parseAgent` call, no YAML parser in the bundle.
  const agentEntries: string[] = [];
  for (const { name, path } of mergedAgents) {
    const raw = await Bun.file(path).text();
    const def = parseAgent(name, raw);
    if (!def) continue;
    agentEntries.push(`  ${JSON.stringify(name)}: ${JSON.stringify(def)},`);
  }

  // Skills: same approach. `parseSkill` takes the runtime VFS path (not the
  // build-machine path) since the skill tool lists sibling files from the
  // in-memory fs at cold start.
  const skillEntries: string[] = [];
  for (const path of Object.values(t.skills)) {
    const raw = await Bun.file(abs(path)).text();
    const info = parseSkill(vfsPath(path), raw);
    if (!info) continue;
    skillEntries.push(`  ${JSON.stringify(info)},`);
  }

  const mdIds: Record<string, string> = {};
  Object.entries(t.mds).forEach(([slot, rel], i) => {
    const id = `__md${i}`;
    imports.push(`import ${id} from ${JSON.stringify(toRel(abs(rel)))} with { type: "text" };`);
    mdIds[slot] = id;
  });

  body.push(`const openxyz = new OpenXyz({`);
  // Runtime cwd = function directory on Vercel, not the build machine's path.
  body.push(`  cwd: import.meta.dir,`);
  body.push(channelEntries.length > 0 ? `  channels: {\n${channelEntries.join("\n")}\n  },` : `  channels: {},`);
  body.push(toolEntries.length > 0 ? `  tools: {\n${toolEntries.join("\n")}\n  },` : `  tools: {},`);
  body.push(agentEntries.length > 0 ? `  agents: {\n${agentEntries.join("\n")}\n  },` : `  agents: {},`);
  body.push(modelEntries.length > 0 ? `  models: {\n${modelEntries.join("\n")}\n  },` : `  models: {},`);
  body.push(skillEntries.length > 0 ? `  skills: [\n${skillEntries.join("\n")}\n  ],` : `  skills: [],`);
  const mdEntries = Object.entries(mdIds).map(([slot, id]) => `    ${JSON.stringify(slot)}: ${id},`);
  if (mdEntries.length > 0) body.push(`  mds: {\n${mdEntries.join("\n")}\n  },`);
  body.push(`});`);
  body.push(`await openxyz.init({ state: await createChatState(openxyz.cwd) });`);
  body.push(``);
  // `waitUntil` is the load-bearing bit on Vercel. chat-sdk dispatches
  // messages as fire-and-forget background tasks (chat.ts `processMessage`);
  // without waitUntil the lambda dies as soon as the 200 response ships,
  // cutting the agent stream short. Uses `@vercel/functions.waitUntil`;
  // per Vercel docs the Bun runtime runs on Fluid Compute "and supports the
  // same core Vercel Functions features" as Node.js. Requires Fluid Compute
  // to be enabled on the project (Dashboard → Settings → Functions).
  body.push(`export default {`);
  body.push(`  async fetch(request: Request): Promise<Response> {`);
  body.push(`    const { pathname } = new URL(request.url);`);
  body.push(`    console.log(\`[openxyz] fetch \${request.method} \${pathname}\`);`);
  body.push(`    const match = pathname.match(/^\\/api\\/webhooks\\/([^/]+)\\/?$/);`);
  body.push(`    if (!match) return new Response("not found", { status: 404 });`);
  body.push(`    const handler = openxyz.webhooks[match[1]!];`);
  body.push(`    if (!handler) return new Response(\`unknown adapter: \${match[1]}\`, { status: 404 });`);
  body.push(`    return handler(request, { waitUntil: (task) => waitUntil(task) });`);
  body.push(`  },`);
  body.push(`};`);

  return [...imports, "", ...body].join("\n") + "\n";
}

async function buildVercel(cwd: string): Promise<void> {
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

  const homePlugin = inMemoryHomePlugin(cwd, files.files);
  const harnessPlugin = virtualHarnessPlugin();

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
    plugins: [homePlugin, harnessPlugin],
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
        // Static assets first (favicon, etc.), then only webhook paths reach
        // the function. Everything else 404s at the edge — non-webhook
        // traffic never wakes the function.
        routes: [{ handle: "filesystem" }, { src: "/api/webhooks/([^/]+)/?", dest: "/" }],
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
 * Bun plugin that materializes `openxyz/_harness` — a virtual module that
 * only exists during `openxyz build`. It re-exports the harness surface the
 * generated entrypoint needs.
 *
 * The template depends on `openxyz`, not `@openxyz/harness`, so we can't
 * import `@openxyz/harness/*` directly from the generated file. The virtual
 * module sits inside the `openxyz` package tree (`resolveDir`), where
 * `@openxyz/harness` is a declared dep and therefore resolvable.
 */
function virtualHarnessPlugin(): BunPlugin {
  // Resolve harness by absolute path — Bun's virtual-namespace loader has
  // uneven support for bare subpath resolution past the top level. Absolute
  // paths bypass package resolution entirely and always work.
  const harnessRoot = new URL("../../../openxyz-harness/", import.meta.url).pathname;
  const openxyzRoot = new URL("../../", import.meta.url).pathname;
  const vercelFunctions = Bun.resolveSync("@vercel/functions", openxyzRoot);

  return {
    name: "openxyz-virtual-harness",
    setup(build) {
      build.onResolve({ filter: /^openxyz\/_harness$/ }, (args) => ({
        path: args.path,
        namespace: "openxyz-harness",
      }));
      build.onLoad({ filter: /.*/, namespace: "openxyz-harness" }, () => ({
        loader: "ts",
        contents: [
          `export { OpenXyz } from ${JSON.stringify(harnessRoot + "openxyz.ts")};`,
          `export { buildChannelFile } from ${JSON.stringify(harnessRoot + "channels.ts")};`,
          `export { createChatState } from ${JSON.stringify(harnessRoot + "databases/index.ts")};`,
          `export { waitUntil } from ${JSON.stringify(vercelFunctions)};`,
        ].join("\n"),
      }));
    },
  };
}

/**
 * Bun plugin that replaces `@openxyz/harness/drives/home` with a generated
 * module. The generated variant wires an `InMemoryFs` pre-populated with the
 * template's file contents, so the deployed function serves `/home/openxyz`
 * straight from the bundle — no disk reads, no `node_modules` shipped.
 *
 * Works by resolving the harness's `drives/home` file path from the build cwd
 * and matching that absolute path in `onLoad`. The replacement text-imports
 * each template file so Bun.build inlines the raw content as static strings.
 */
function inMemoryHomePlugin(cwd: string, vfs: string[]): BunPlugin {
  return {
    name: "openxyz-home-intercept",
    setup(build) {
      // Matches the harness's drives/home source on disk — workspaces resolve
      // to real paths (`packages/openxyz-harness/drives/home.ts`), symlinked
      // installs resolve similarly.
      const filter = /openxyz-harness\/drives\/home\.(ts|js)$/;

      build.onLoad({ filter }, async () => {
        // Inline file contents as string literals. Text imports
        // (`with { type: "text" }`) get deduped with module imports of the
        // same path, so we can't reuse them — read the file ourselves here.
        const entries: string[] = [];
        for (const rel of vfs) {
          const text = await Bun.file(join(cwd, rel)).text();
          entries.push(`  ${JSON.stringify("/home/openxyz/" + rel)}: ${JSON.stringify(text)},`);
        }

        const contents = [
          `// generated by openxyz build — intercepted drives/home`,
          `import { InMemoryFs } from "just-bash";`,
          `import { ReadOnlyFs } from "./readonly-fs";`,
          ``,
          `const files = {`,
          ...entries,
          `};`,
          ``,
          // Match the real drives/home.ts shape — constructor(cwd, permission),
          // `mountConfig(mountPoint)` method. FilesystemTools passes cwd and
          // permission in, and calls `.mountConfig("/home/openxyz")`.
          // The packed snapshot is always read-only: the deployed artifact
          // is immutable, and allowing in-memory writes would be misleading
          // (they persist only within a warm container). ReadOnlyFs throws
          // EACCES on any mutation so the agent sees a consistent error.
          `export class HomeDrive {`,
          `  constructor(cwd, permission) {`,
          `    this.cwd = cwd;`,
          `    this.permission = permission;`,
          `  }`,
          `  mountConfig(mountPoint) {`,
          `    return { mountPoint, filesystem: new ReadOnlyFs(new InMemoryFs(files)) };`,
          `  }`,
          `}`,
        ].join("\n");

        return { contents, loader: "ts" };
      });
    },
  };
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
