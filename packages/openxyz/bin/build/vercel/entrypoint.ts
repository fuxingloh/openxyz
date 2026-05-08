import { join, relative } from "node:path";
import { parseAgent } from "../../parsers/agent";
import { parseSkill } from "../../parsers/skill";
import type { OpenXyzFiles } from "../../scan";

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
    `import { OpenXyz, loadChannel, getDb, TursoStateAdapter, waitUntil, WorkspaceDrive, loadTools, loadModel, formatLoadError, EnvNotFoundError, EnvParseError } from "openxyz/_runtime";`,
  );

  // Channels / tools / drives use **dynamic** imports wrapped in a NARROW
  // try/catch — only `EnvNotFoundError` / `EnvParseError` get soft-skipped.
  // Justification: `openxyz build` runs in CI without runtime secrets (env
  // vars live in the Vercel/CF dashboard, not in build env). At cold start
  // in the deployed function, runtime env IS set, but a forgotten/typo'd
  // var still surfaces as `EnvNotFoundError` at module init. Soft-skipping
  // only that class keeps siblings working and surfaces the missing key
  // structurally (boot log + agent's `## Unavailable` section). Anything
  // else — syntax errors, broken imports, vendor SDK crashes — is a real
  // bug; let it throw and crash the cold start so it lands in deploy logs.
  const channelDynamic: Array<{ name: string; rel: string }> = [];
  Object.entries(t.channels).forEach(([name, path]) => {
    channelDynamic.push({ name, rel: toRel(abs(path)) });
  });

  // Tools modules can default-export a tool(), an mcp(), or expose named
  // tool() exports. Discrimination (+ MCP connect + cleanup) happens at boot
  // via `loadTools`.
  const toolDynamic: Array<{ name: string; rel: string }> = [];
  Object.entries(t.tools).forEach(([name, path]) => {
    toolDynamic.push({ name, rel: toRel(abs(path)) });
  });

  // Drives: WorkspaceDrive is always mounted at /workspace (runtime-intercepted
  // by `inMemoryWorkspacePlugin` for the packed snapshot). Template-provided
  // `drives/<name>.ts` files mount at `/mnt/<name>/`.
  const driveDynamic: Array<{ name: string; rel: string }> = [];
  Object.entries(t.drives).forEach(([name, path]) => {
    driveDynamic.push({ name, rel: toRel(abs(path)) });
  });

  // Models: dynamic imports, same soft-load reasoning as channels/tools/drives.
  // `models/auto.ts` is required by `scanDir` — every template implements it.
  // Factory exports are resolved at boot time on the deployed function.
  const modelDynamic: Array<{ name: string; rel: string }> = [];
  for (const name of usedModels) {
    const path = t.models[name] ? abs(t.models[name]!) : undefined;
    if (!path) continue; // referenced but no source — agent picking it surfaces clearly at runtime
    modelDynamic.push({ name, rel: toRel(path) });
  }

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

  let agentsMdId: string | undefined;
  if (t["AGENTS.md"]) {
    agentsMdId = "__agentsMd";
    imports.push(`import ${agentsMdId} from ${JSON.stringify(toRel(abs(t["AGENTS.md"])))} with { type: "text" };`);
  }

  // Boot-time soft-load — narrow scope. `__handleLoadErr` only swallows
  // typed env errors (the user has a knob to turn — set the var, redeploy).
  // Anything else re-throws so the cold start crashes loudly into deploy
  // logs instead of degrading silently.
  body.push(`const __skipped = [];`);
  body.push(`function __handleLoadErr(err, kind, name) {`);
  body.push(`  if (!(err instanceof EnvNotFoundError) && !(err instanceof EnvParseError)) throw err;`);
  body.push(`  const reason = formatLoadError(err);`);
  body.push(`  console.warn(\`[openxyz] \${kind}s/\${name} skipped: \${reason}\`);`);
  body.push(`  __skipped.push({ kind, name, reason });`);
  body.push(`}`);
  body.push(``);

  body.push(`const __channels = {};`);
  for (const { name, rel } of channelDynamic) {
    body.push(`try {`);
    body.push(`  const mod = await import(${JSON.stringify(rel)});`);
    body.push(`  __channels[${JSON.stringify(name)}] = loadChannel(mod, ${JSON.stringify(name)});`);
    body.push(`} catch (err) { __handleLoadErr(err, "channel", ${JSON.stringify(name)}); }`);
  }
  body.push(``);

  body.push(`const __tools = {};`);
  body.push(`const __toolCleanup = [];`);
  for (const { name, rel } of toolDynamic) {
    body.push(`try {`);
    body.push(`  const mod = await import(${JSON.stringify(rel)});`);
    body.push(`  const expanded = await loadTools(${JSON.stringify(name)}, mod);`);
    body.push(`  for (const [id, t] of Object.entries(expanded.tools)) {`);
    body.push(
      `    if (__tools[id]) console.warn(\`[openxyz] tool id "\${id}" defined by multiple files, last one wins\`);`,
    );
    body.push(`    __tools[id] = t;`);
    body.push(`  }`);
    body.push(`  if (expanded.cleanup) __toolCleanup.push(expanded.cleanup);`);
    body.push(`} catch (err) { __handleLoadErr(err, "tool", ${JSON.stringify(name)}); }`);
  }
  body.push(``);

  body.push(`const __drives = { "/workspace": new WorkspaceDrive(import.meta.dirname, "read-write") };`);
  for (const { name, rel } of driveDynamic) {
    body.push(`try {`);
    body.push(`  const mod = await import(${JSON.stringify(rel)});`);
    body.push(`  if (!mod.default) throw new Error("no default export");`);
    body.push(`  __drives[${JSON.stringify(`/mnt/${name}`)}] = mod.default;`);
    body.push(`} catch (err) { __handleLoadErr(err, "drive", ${JSON.stringify(name)}); }`);
  }
  body.push(``);

  body.push(`const __models = {};`);
  for (const { name, rel } of modelDynamic) {
    body.push(`try {`);
    body.push(`  const mod = await import(${JSON.stringify(rel)});`);
    body.push(`  __models[${JSON.stringify(name)}] = await loadModel(mod);`);
    body.push(`} catch (err) { __handleLoadErr(err, "model", ${JSON.stringify(name)}); }`);
  }
  body.push(``);

  body.push(`const openxyz = new OpenXyz({`);
  // Runtime cwd = function directory on Vercel, not the build machine's path.
  body.push(`  cwd: import.meta.dirname,`);
  body.push(`  channels: __channels,`);
  body.push(`  tools: __tools,`);
  body.push(`  cleanup: __toolCleanup,`);
  body.push(agentEntries.length > 0 ? `  agents: {\n${agentEntries.join("\n")}\n  },` : `  agents: {},`);
  body.push(`  models: __models,`);
  body.push(skillEntries.length > 0 ? `  skills: [\n${skillEntries.join("\n")}\n  ],` : `  skills: [],`);
  body.push(`  drives: __drives,`);
  if (agentsMdId) body.push(`  "AGENTS.md": ${agentsMdId},`);
  body.push(`  skipped: __skipped,`);
  body.push(`});`);
  // Serverless entrypoint: the function can be suspended between invocations,
  // so we don't wire a shutdown hook — the Turso client's `close()` only
  // matters at Lambda teardown. If that ever matters, track the db and
  // register `db.close()` on `process.on("beforeExit", …)`.
  body.push(`const db = await getDb(openxyz.cwd);`);
  body.push(`await openxyz.init({ state: new TursoStateAdapter({ client: db }) });`);
  body.push(``);
  // Node runtime (mnemonic/069 resolution): `@vercel/functions.waitUntil`
  // honors the lifetime contract here — the function stays alive until every
  // scheduled promise resolves or `maxDuration` hits. chat-sdk dispatches the
  // agent turn as a background task via `processMessage`; we just hand it
  // through.
  body.push(`export default {`);
  body.push(`  async fetch(request: Request): Promise<Response> {`);
  body.push(`    const { pathname } = new URL(request.url);`);
  body.push(`    console.log(\`[openxyz] fetch \${request.method} \${pathname}\`);`);
  body.push(`    const match = pathname.match(/^\\/api\\/webhooks\\/([^/]+)\\/?$/);`);
  body.push(`    if (!match) return new Response("not found", { status: 404 });`);
  body.push(`    const handler = openxyz.webhooks[match[1]!];`);
  body.push(`    if (!handler) return new Response(\`unknown adapter: \${match[1]}\`, { status: 404 });`);
  body.push(`    return handler(request, { waitUntil });`);
  body.push(`  },`);
  body.push(`};`);

  return [...imports, "", ...body].join("\n") + "\n";
}
