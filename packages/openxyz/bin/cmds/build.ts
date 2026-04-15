import type { BunPlugin } from "bun";
import { Command } from "commander";
import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { resolve, relative, join } from "node:path";

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

type TemplateFiles = {
  channels: { name: string; absPath: string }[];
  tools: { name: string; absPath: string }[];
  agents: { name: string; absPath: string }[];
  skills: { absPath: string }[];
  agentsMd?: string;
  /** Relative paths of every template file to pack into the VFS snapshot. */
  vfs: string[];
};

/**
 * Enumerate template files as absolute paths for build-time code-gen.
 * The build command uses this to emit static imports — no module execution.
 *
 * `vfs` lists every template file that should be packed into the in-memory
 * filesystem at runtime. We walk the template dir once, skipping the build
 * and dep directories plus env files (credentials).
 */
async function enumerateTemplateFiles(cwd: string): Promise<TemplateFiles> {
  const channels: TemplateFiles["channels"] = [];
  for await (const rel of new Bun.Glob("channels/[!_]*.ts").scan({ cwd })) {
    channels.push({ name: rel.split("/").pop()!.replace(/\.ts$/, ""), absPath: join(cwd, rel) });
  }
  const tools: TemplateFiles["tools"] = [];
  for await (const rel of new Bun.Glob("tools/[!_]*.{ts,js}").scan({ cwd })) {
    tools.push({
      name: rel
        .split("/")
        .pop()!
        .replace(/\.(ts|js)$/, ""),
      absPath: join(cwd, rel),
    });
  }
  const agents: TemplateFiles["agents"] = [];
  for await (const rel of new Bun.Glob("agents/[!_]*.md").scan({ cwd })) {
    agents.push({ name: rel.split("/").pop()!.replace(/\.md$/, ""), absPath: join(cwd, rel) });
  }
  const skills: TemplateFiles["skills"] = [];
  for await (const rel of new Bun.Glob("skills/**/SKILL.md").scan({ cwd })) {
    skills.push({ absPath: join(cwd, rel) });
  }
  const agentsMdPath = join(cwd, "AGENTS.md");
  const agentsMd = existsSync(agentsMdPath) ? agentsMdPath : undefined;

  const vfs: string[] = [];
  const seen = new Set<string>();
  const globs = ["channels/**/*", "tools/**/*", "agents/**/*", "skills/**/*", "*.md", "package.json"];
  for (const pattern of globs) {
    for await (const rel of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) {
      if (seen.has(rel)) continue;
      if (isExcluded(rel)) continue;
      seen.add(rel);
      vfs.push(rel);
    }
  }

  return { channels, tools, agents, skills, agentsMd, vfs };
}

function isExcluded(rel: string): boolean {
  const skip = ["node_modules/", ".openxyz/", ".vercel/", ".git/", ".env", ".DS_Store"];
  return skip.some((p) => rel.startsWith(p) || rel.endsWith(p) || rel.includes(`/${p.replace(/\/$/, "")}/`));
}

function generateEntrypoint(files: TemplateFiles): string {
  const imports: string[] = [];
  const body: string[] = [];

  const openxyzImports = ["OpenXyz", "buildChannelFile"];
  if (files.agents.length > 0) openxyzImports.push("parseAgent");
  if (files.skills.length > 0) openxyzImports.push("parseSkill");
  imports.push(`import { ${openxyzImports.join(", ")} } from "openxyz/openxyz";`);
  imports.push(`import { createChatState } from "openxyz/databases";`);

  const channelEntries: string[] = [];
  files.channels.forEach((c, i) => {
    const id = `__ch${i}`;
    imports.push(`import * as ${id} from ${JSON.stringify(c.absPath)};`);
    channelEntries.push(`  ${JSON.stringify(c.name)}: buildChannelFile(${id}, ${JSON.stringify(c.name)}),`);
  });

  const toolEntries: string[] = [];
  files.tools.forEach((t, i) => {
    const id = `__tool${i}`;
    imports.push(`import ${id} from ${JSON.stringify(t.absPath)};`);
    toolEntries.push(`  ${JSON.stringify(t.name)}: ${id},`);
  });

  const agentEntries: string[] = [];
  files.agents.forEach((a, i) => {
    const id = `__agent${i}`;
    imports.push(`import ${id} from ${JSON.stringify(a.absPath)} with { type: "text" };`);
    agentEntries.push(
      `  ...(function(){ const d = parseAgent(${JSON.stringify(a.name)}, ${id}); return d ? { ${JSON.stringify(a.name)}: d } : {}; })(),`,
    );
  });

  const skillEntries: string[] = [];
  files.skills.forEach((s, i) => {
    const id = `__skill${i}`;
    imports.push(`import ${id} from ${JSON.stringify(s.absPath)} with { type: "text" };`);
    skillEntries.push(`  parseSkill(${JSON.stringify(s.absPath)}, ${id}),`);
  });

  let agentsMdId: string | undefined;
  if (files.agentsMd) {
    agentsMdId = "__agentsMd";
    imports.push(`import ${agentsMdId} from ${JSON.stringify(files.agentsMd)} with { type: "text" };`);
  }

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
  if (agentsMdId) body.push(`  agentsmd: ${agentsMdId},`);
  body.push(`});`);
  body.push(`await openxyz.init({ state: await createChatState(openxyz.cwd) });`);
  body.push(``);
  body.push(`export default {`);
  body.push(`  async fetch(request: Request): Promise<Response> {`);
  body.push(`    const { pathname } = new URL(request.url);`);
  body.push(`    const match = pathname.match(/^\\/webhooks\\/([^/]+)\\/?$/);`);
  body.push(`    if (!match) return new Response("not found", { status: 404 });`);
  body.push(`    const handler = openxyz.webhooks[match[1]!];`);
  body.push(`    if (!handler) return new Response(\`unknown adapter: \${match[1]}\`, { status: 404 });`);
  body.push(`    return handler(request);`);
  body.push(`  },`);
  body.push(`};`);

  return [...imports, "", ...body].join("\n") + "\n";
}

async function buildVercel(cwd: string): Promise<void> {
  const files = await enumerateTemplateFiles(cwd);

  if (files.channels.length === 0) {
    console.error("[openxyz] no channels found under channels/*.ts — nothing to build");
    process.exit(1);
  }

  const buildDir = resolve(cwd, ".openxyz/build");
  mkdirSync(buildDir, { recursive: true });
  const entrypoint = resolve(buildDir, "server.ts");
  await Bun.write(entrypoint, generateEntrypoint(files));

  const outputDir = resolve(cwd, ".vercel/output");
  rmSync(outputDir, { recursive: true, force: true });
  const funcDir = resolve(outputDir, "functions/index.func");
  mkdirSync(funcDir, { recursive: true });

  const homePlugin = inMemoryHomePlugin(cwd, files.vfs);

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
    plugins: [homePlugin],
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
  console.log("");
  console.log("Deploy with: vercel deploy --prebuilt");
  console.log("Point Telegram setWebhook at: https://<your-deploy>/webhooks/telegram");
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
