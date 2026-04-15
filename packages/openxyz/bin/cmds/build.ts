import type { BunPlugin } from "bun";
import { Command } from "commander";
import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { scanTemplate, type OpenXyzFiles } from "../scan";

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

function generateEntrypoint(scan: OpenXyzFiles): string {
  const abs = (p: string) => join(scan.cwd, p);
  const vfsPath = (p: string) => "/home/openxyz/" + p;
  const t = scan.template;

  const imports: string[] = [];
  const body: string[] = [];

  const harnessImports = ["OpenXyz", "buildChannelFile", "createChatState"];
  if (Object.keys(t.agents).length > 0) harnessImports.push("parseAgent");
  if (Object.keys(t.skills).length > 0) harnessImports.push("parseSkill");
  imports.push(`import { ${harnessImports.join(", ")} } from "openxyz/_harness";`);

  const channelEntries: string[] = [];
  Object.entries(t.channels).forEach(([name, path], i) => {
    const id = `__ch${i}`;
    imports.push(`import * as ${id} from ${JSON.stringify(abs(path))};`);
    channelEntries.push(`  ${JSON.stringify(name)}: buildChannelFile(${id}, ${JSON.stringify(name)}),`);
  });

  const toolEntries: string[] = [];
  Object.entries(t.tools).forEach(([name, path], i) => {
    const id = `__tool${i}`;
    imports.push(`import ${id} from ${JSON.stringify(abs(path))};`);
    toolEntries.push(`  ${JSON.stringify(name)}: ${id},`);
  });

  const agentEntries: string[] = [];
  Object.entries(t.agents).forEach(([name, path], i) => {
    const id = `__agent${i}`;
    imports.push(`import ${id} from ${JSON.stringify(abs(path))} with { type: "text" };`);
    agentEntries.push(
      `  ...(function(){ const d = parseAgent(${JSON.stringify(name)}, ${id}); return d ? { ${JSON.stringify(name)}: d } : {}; })(),`,
    );
  });

  const skillEntries: string[] = [];
  Object.entries(t.skills).forEach(([_name, path], i) => {
    const id = `__skill${i}`;
    imports.push(`import ${id} from ${JSON.stringify(abs(path))} with { type: "text" };`);
    // Location stored on the SkillInfo must be the runtime VFS path — the
    // skill tool uses it to list sibling files from the in-memory fs at cold
    // start, not the build machine's disk.
    skillEntries.push(`  parseSkill(${JSON.stringify(vfsPath(path))}, ${id}),`);
  });

  const mdIds: Record<string, string> = {};
  Object.entries(t.mds).forEach(([slot, rel], i) => {
    const id = `__md${i}`;
    imports.push(`import ${id} from ${JSON.stringify(abs(rel))} with { type: "text" };`);
    mdIds[slot] = id;
  });

  body.push(`const openxyz = new OpenXyz({`);
  // Runtime cwd = function directory on Vercel, not the build machine's path.
  body.push(`  cwd: import.meta.dir,`);
  body.push(channelEntries.length > 0 ? `  channels: {\n${channelEntries.join("\n")}\n  },` : `  channels: {},`);
  body.push(toolEntries.length > 0 ? `  tools: {\n${toolEntries.join("\n")}\n  },` : `  tools: {},`);
  body.push(agentEntries.length > 0 ? `  agents: {\n${agentEntries.join("\n")}\n  },` : `  agents: {},`);
  body.push(
    skillEntries.length > 0
      ? `  skills: [\n${skillEntries.join("\n")}\n  ].filter((s): s is NonNullable<typeof s> => !!s),`
      : `  skills: [],`,
  );
  const mdEntries = Object.entries(mdIds).map(([slot, id]) => `    ${JSON.stringify(slot)}: ${id},`);
  if (mdEntries.length > 0) body.push(`  mds: {\n${mdEntries.join("\n")}\n  },`);
  body.push(`});`);
  body.push(`await openxyz.init({ state: await createChatState(openxyz.cwd) });`);
  body.push(``);
  body.push(`export default {`);
  body.push(`  async fetch(request: Request): Promise<Response> {`);
  body.push(`    const { pathname } = new URL(request.url);`);
  body.push(`    const match = pathname.match(/^\\/api\\/webhooks\\/([^/]+)\\/?$/);`);
  body.push(`    if (!match) return new Response("not found", { status: 404 });`);
  body.push(`    const handler = openxyz.webhooks[match[1]!];`);
  body.push(`    if (!handler) return new Response(\`unknown adapter: \${match[1]}\`, { status: 404 });`);
  body.push(`    return handler(request);`);
  body.push(`  },`);
  body.push(`};`);

  return [...imports, "", ...body].join("\n") + "\n";
}

async function buildVercel(cwd: string): Promise<void> {
  const scan = await scanTemplate(cwd);

  if (Object.keys(scan.template.channels).length === 0) {
    console.error("[openxyz] no channels found under channels/*.ts — nothing to build");
    process.exit(1);
  }

  const buildDir = resolve(cwd, ".openxyz/build");
  mkdirSync(buildDir, { recursive: true });
  const entrypoint = resolve(buildDir, "server.ts");
  await Bun.write(entrypoint, generateEntrypoint(scan));

  const outputDir = resolve(cwd, ".vercel/output");
  rmSync(outputDir, { recursive: true, force: true });
  const funcDir = resolve(outputDir, "functions/index.func");
  mkdirSync(funcDir, { recursive: true });

  const homePlugin = inMemoryHomePlugin(cwd, scan.files);
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
        routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: "/" }],
      },
      null,
      2,
    ),
  );

  const staticDir = resolve(outputDir, "static");
  const publicDir = resolve(cwd, "public");
  if (existsSync(publicDir)) {
    cpSync(publicDir, staticDir, { recursive: true });
  } else {
    mkdirSync(staticDir, { recursive: true });
  }

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
          `export { parseAgent } from ${JSON.stringify(harnessRoot + "agents/factory.ts")};`,
          `export { parseSkill } from ${JSON.stringify(harnessRoot + "tools/skill.ts")};`,
          `export { createChatState } from ${JSON.stringify(harnessRoot + "databases/index.ts")};`,
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
          ``,
          `const files = {`,
          ...entries,
          `};`,
          ``,
          `export class HomeDrive {`,
          `  getMountConfig() {`,
          `    return { mountPoint: "/home/openxyz", filesystem: new InMemoryFs(files) };`,
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
