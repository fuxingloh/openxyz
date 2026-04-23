import { join, relative } from "node:path";
import { parseAgent } from "@openxyz/runtime/agents/factory";
import { parseSkill } from "@openxyz/runtime/tools/skill";
import type { OpenXyzFiles } from "../scan";

/**
 * Code-gen the Vercel function entrypoint: a single `server.ts` that imports
 * every channel/tool/model module, inlines every agent + skill definition as
 * JSON, and exports a `fetch(request)` handler that routes webhook paths to
 * chat-sdk adapters.
 *
 * Runs once per `openxyz build`. The generated file is the sole input to
 * `Bun.build`, which bundles everything transitively reachable into one JS.
 */
export async function generateEntrypoint(
  scan: OpenXyzFiles,
  usedModels: Set<string>,
  defaultAgents: Record<string, string>,
): Promise<string> {
  const abs = (p: string) => join(scan.cwd, p);
  const vfsPath = (p: string) => "/workspace/" + p;
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
  imports.push(
    `import { OpenXyz, loadChannel, getDb, TursoStateAdapter, waitUntil, WorkspaceDrive, loadTools, loadModel } from "openxyz/_runtime";`,
  );

  const channelEntries: string[] = [];
  Object.entries(t.channels).forEach(([name, path], i) => {
    const id = `__ch${i}`;
    imports.push(`import * as ${id} from ${JSON.stringify(toRel(abs(path)))};`);
    channelEntries.push(`  ${JSON.stringify(name)}: loadChannel(${id}, ${JSON.stringify(name)}),`);
  });

  // Tools modules can default-export a tool(), an mcp(), or expose named
  // tool() exports. Discrimination (+ MCP connect + cleanup) happens at boot
  // via `loadTools`. Namespace import so we capture every export.
  const toolModuleEntries: string[] = [];
  Object.entries(t.tools).forEach(([name, path], i) => {
    const id = `__tool${i}`;
    imports.push(`import * as ${id} from ${JSON.stringify(toRel(abs(path)))};`);
    toolModuleEntries.push(`  { name: ${JSON.stringify(name)}, mod: ${id} },`);
  });

  // Drives: WorkspaceDrive is always mounted at /workspace (runtime-intercepted
  // by `inMemoryWorkspacePlugin` for the packed snapshot). Template-provided
  // `drives/<name>.ts` files mount at `/mnt/<name>/`.
  const driveEntries: string[] = [`  "/workspace": new WorkspaceDrive(import.meta.dir, "read-write"),`];
  Object.entries(t.drives).forEach(([name, path], i) => {
    const id = `__drive${i}`;
    imports.push(`import ${id} from ${JSON.stringify(toRel(abs(path)))};`);
    driveEntries.push(`  ${JSON.stringify(`/mnt/${name}`)}: ${id},`);
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
    // Namespace import captures `default` + `systemPrompt` + `limit` named
    // exports. `loadModel` reads whichever are present, awaits `default`
    // if it's a factory, fills in shipped defaults for the rest.
    imports.push(`import * as ${id} from ${JSON.stringify(toRel(path))};`);
    modelPairs.push({ name, id });
  }
  const modelEntries = modelPairs.map(({ name, id }) => `  ${JSON.stringify(name)}: await loadModel(${id}),`);

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

  // Expand every tools/*.ts module at boot — MCP servers connect here, named
  // tool() exports get flattened into `<filename>_<export>` ids. Must NOT run
  // at build time (credentials, network, wrong env). `__toolCleanup` carries
  // teardown callbacks into `runtime.cleanup` so `OpenXyz.stop()` can close
  // MCP clients on shutdown.
  if (toolModuleEntries.length > 0) {
    body.push(`const __toolModules = [\n${toolModuleEntries.join("\n")}\n];`);
    body.push(`const __tools = {};`);
    body.push(`const __toolCleanup = [];`);
    body.push(`for (const { name, mod } of __toolModules) {`);
    body.push(`  const expanded = await loadTools(name, mod);`);
    body.push(`  Object.assign(__tools, expanded.tools);`);
    body.push(`  if (expanded.cleanup) __toolCleanup.push(expanded.cleanup);`);
    body.push(`}`);
  } else {
    body.push(`const __tools = {};`);
    body.push(`const __toolCleanup = [];`);
  }
  body.push(``);
  body.push(`const openxyz = new OpenXyz({`);
  // Runtime cwd = function directory on Vercel, not the build machine's path.
  body.push(`  cwd: import.meta.dir,`);
  body.push(channelEntries.length > 0 ? `  channels: {\n${channelEntries.join("\n")}\n  },` : `  channels: {},`);
  body.push(`  tools: __tools,`);
  body.push(`  cleanup: __toolCleanup,`);
  body.push(agentEntries.length > 0 ? `  agents: {\n${agentEntries.join("\n")}\n  },` : `  agents: {},`);
  body.push(modelEntries.length > 0 ? `  models: {\n${modelEntries.join("\n")}\n  },` : `  models: {},`);
  body.push(skillEntries.length > 0 ? `  skills: [\n${skillEntries.join("\n")}\n  ],` : `  skills: [],`);
  body.push(`  drives: {\n${driveEntries.join("\n")}\n  },`);
  const mdEntries = Object.entries(mdIds).map(([slot, id]) => `    ${JSON.stringify(slot)}: ${id},`);
  if (mdEntries.length > 0) body.push(`  mds: {\n${mdEntries.join("\n")}\n  },`);
  body.push(`});`);
  // Serverless entrypoint: the function can be suspended between invocations,
  // so we don't wire a shutdown hook — the Turso client's `close()` only
  // matters at Lambda teardown. If that ever matters, track the db and
  // register `db.close()` on `process.on("beforeExit", …)`.
  body.push(`const db = await getDb(openxyz.cwd);`);
  body.push(`await openxyz.init({ state: new TursoStateAdapter({ client: db }) });`);
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
  // Belt-and-braces: capture chat-sdk's background tasks in an array AND
  // hand them to Vercel's waitUntil. On Bun runtime, waitUntil appears to
  // only keep the function alive for a short grace period (~1-2s) after
  // response, not through the full task lifetime. The inline Promise.all
  // below holds the response until processing completes. Telegram webhooks
  // tolerate slow responses up to ~75s; agent streams should finish well
  // inside that window.
  body.push(`    const tasks: Promise<unknown>[] = [];`);
  body.push(`    const response = await handler(request, {`);
  body.push(`      waitUntil: (task) => {`);
  body.push(`        tasks.push(task);`);
  body.push(`        waitUntil(task);`);
  body.push(`      },`);
  body.push(`    });`);
  body.push(`    if (tasks.length > 0) {`);
  body.push(`      console.log(\`[openxyz] awaiting \${tasks.length} background task(s) inline\`);`);
  body.push(`      await Promise.allSettled(tasks);`);
  body.push(`      console.log(\`[openxyz] tasks settled\`);`);
  body.push(`    }`);
  body.push(`    return response;`);
  body.push(`  },`);
  body.push(`};`);

  return [...imports, "", ...body].join("\n") + "\n";
}
