import { join, relative } from "node:path";
import { parseAgent } from "../../parsers/agent";
import { parseSkill } from "../../parsers/skill";
import type { OpenXyzFiles } from "../../scan";

/**
 * Code-gen the Cloudflare Worker entrypoint: a single `worker.ts` that
 * imports every channel/tool/model module, inlines every agent + skill
 * definition as JSON, exports the `ChatStateDO` class (so wrangler can bind
 * it), and exports a `fetch(request, env, ctx)` handler that routes webhook
 * paths to chat-sdk adapters.
 *
 * Mirrors `vercel/entrypoint.ts`; differences:
 *  - handler signature is `(req, env, ctx)` instead of `(req)`
 *  - `waitUntil` comes from `ctx.waitUntil`, not `@vercel/functions`
 *  - state adapter is `createCloudflareState({ namespace: env.CHAT_STATE })`
 *    instead of `TursoStateAdapter` over `getDb()`
 *  - re-exports `ChatStateDO` for the wrangler DO binding
 */
export async function generateEntrypoint(
  scan: OpenXyzFiles,
  usedModels: Set<string>,
  defaultAgents: Record<string, string>,
): Promise<string> {
  const abs = (p: string) => join(scan.cwd, p);
  const vfsPath = (p: string) => "/workspace/" + p;
  const buildDir = join(scan.cwd, ".openxyz/build");
  const toRel = (p: string) => {
    const r = relative(buildDir, p);
    return r.startsWith(".") ? r : "./" + r;
  };
  const shippedAuto = new URL("../../../models/auto.ts", import.meta.url).pathname;
  const t = scan.template;

  const mergedAgents: Array<{ name: string; path: string }> = [];
  for (const [name, path] of Object.entries(defaultAgents)) mergedAgents.push({ name, path });
  for (const [name, rel] of Object.entries(t.agents)) mergedAgents.push({ name, path: abs(rel) });

  const imports: string[] = [];
  const body: string[] = [];

  imports.push(
    `import { OpenXyz, loadChannel, createCloudflareState, ChatStateDO, WorkspaceDrive, loadTools, loadModel, formatLoadError } from "openxyz/_runtime";`,
  );

  // Boot-time soft-load: every channel/tool/drive/model uses dynamic imports
  // wrapped in try/catch so a module whose top-level evaluation throws
  // (typical: `env.X.toString()` on an unset var) skips its slot, gets recorded
  // in `__skipped`, and the siblings keep working. Mirrors the Vercel
  // entrypoint exactly — keep the two in sync.
  const channelDynamic: Array<{ name: string; rel: string }> = [];
  Object.entries(t.channels).forEach(([name, path]) => {
    channelDynamic.push({ name, rel: toRel(abs(path)) });
  });

  const toolDynamic: Array<{ name: string; rel: string }> = [];
  Object.entries(t.tools).forEach(([name, path]) => {
    toolDynamic.push({ name, rel: toRel(abs(path)) });
  });

  const driveDynamic: Array<{ name: string; rel: string }> = [];
  Object.entries(t.drives).forEach(([name, path]) => {
    driveDynamic.push({ name, rel: toRel(abs(path)) });
  });

  const modelDynamic: Array<{ name: string; rel: string }> = [];
  for (const name of usedModels) {
    const path = t.models[name] ? abs(t.models[name]!) : name === "auto" ? shippedAuto : undefined;
    if (!path) continue;
    modelDynamic.push({ name, rel: toRel(path) });
  }

  const agentEntries: string[] = [];
  for (const { name, path } of mergedAgents) {
    const raw = await Bun.file(path).text();
    const def = parseAgent(name, raw);
    if (!def) continue;
    agentEntries.push(`  ${JSON.stringify(name)}: ${JSON.stringify(def)},`);
  }

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

  // Re-export the DO class so wrangler can bind it. mnemonic/133 piece 5
  // wires `CHAT_STATE` in wrangler.jsonc to this class.
  body.push(`export { ChatStateDO };`);
  body.push(``);

  // Soft-load scaffolding — see Vercel entrypoint for full rationale.
  body.push(`const __skipped = [];`);
  body.push(``);

  body.push(`const __channels = {};`);
  for (const { name, rel } of channelDynamic) {
    body.push(`try {`);
    body.push(`  const mod = await import(${JSON.stringify(rel)});`);
    body.push(`  __channels[${JSON.stringify(name)}] = loadChannel(mod, ${JSON.stringify(name)});`);
    body.push(`} catch (err) {`);
    body.push(`  const reason = formatLoadError(err);`);
    body.push(`  console.warn(\`[openxyz] channels/${name} skipped: \${reason}\`);`);
    body.push(`  __skipped.push({ kind: "channel", name: ${JSON.stringify(name)}, reason });`);
    body.push(`}`);
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
    body.push(`} catch (err) {`);
    body.push(`  const reason = formatLoadError(err);`);
    body.push(`  console.warn(\`[openxyz] tools/${name} skipped: \${reason}\`);`);
    body.push(`  __skipped.push({ kind: "tool", name: ${JSON.stringify(name)}, reason });`);
    body.push(`}`);
  }
  body.push(``);

  body.push(`const __drives = { "/workspace": new WorkspaceDrive(import.meta.dirname, "read-write") };`);
  for (const { name, rel } of driveDynamic) {
    body.push(`try {`);
    body.push(`  const mod = await import(${JSON.stringify(rel)});`);
    body.push(`  if (!mod.default) throw new Error("no default export");`);
    body.push(`  __drives[${JSON.stringify(`/mnt/${name}`)}] = mod.default;`);
    body.push(`} catch (err) {`);
    body.push(`  const reason = formatLoadError(err);`);
    body.push(`  console.warn(\`[openxyz] drives/${name} skipped: \${reason}\`);`);
    body.push(`  __skipped.push({ kind: "drive", name: ${JSON.stringify(name)}, reason });`);
    body.push(`}`);
  }
  body.push(``);

  body.push(`const __models = {};`);
  for (const { name, rel } of modelDynamic) {
    body.push(`try {`);
    body.push(`  const mod = await import(${JSON.stringify(rel)});`);
    body.push(`  __models[${JSON.stringify(name)}] = await loadModel(mod);`);
    body.push(`} catch (err) {`);
    body.push(`  const reason = formatLoadError(err);`);
    body.push(`  console.warn(\`[openxyz] models/${name} skipped: \${reason}\`);`);
    body.push(`  __skipped.push({ kind: "model", name: ${JSON.stringify(name)}, reason });`);
    body.push(`}`);
  }
  body.push(``);

  body.push(`const openxyz = new OpenXyz({`);
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
  body.push(``);

  // Cloudflare passes env + ctx per-request; OpenXyz init must run inside
  // fetch (env isn't available at module-eval time on Workers). Cache the
  // init promise so subsequent requests in the same isolate reuse it.
  body.push(`type Env = { CHAT_STATE: DurableObjectNamespace<ChatStateDO> };`);
  body.push(`let __initialized: Promise<void> | undefined;`);
  body.push(`function __ensureInit(env: Env): Promise<void> {`);
  body.push(`  if (!__initialized) {`);
  body.push(`    __initialized = openxyz.init({`);
  body.push(`      state: createCloudflareState({`);
  body.push(`        namespace: env.CHAT_STATE,`);
  body.push(`        shardKey: (id) => id.split(":")[0],`);
  body.push(`      }),`);
  body.push(`    });`);
  body.push(`  }`);
  body.push(`  return __initialized;`);
  body.push(`}`);
  body.push(``);
  body.push(`export default {`);
  body.push(`  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {`);
  body.push(`    await __ensureInit(env);`);
  body.push(`    const { pathname } = new URL(request.url);`);
  body.push(`    console.log(\`[openxyz] fetch \${request.method} \${pathname}\`);`);
  body.push(`    const match = pathname.match(/^\\/api\\/webhooks\\/([^/]+)\\/?$/);`);
  body.push(`    if (!match) return new Response("not found", { status: 404 });`);
  body.push(`    const handler = openxyz.webhooks[match[1]!];`);
  body.push(`    if (!handler) return new Response(\`unknown adapter: \${match[1]}\`, { status: 404 });`);
  // chat-sdk's webhook handler expects `{ waitUntil }` — bind ctx.waitUntil
  // so the chat-sdk processing fires off the agent turn as a background task
  // that survives the response, the same way @vercel/functions.waitUntil does.
  body.push(`    return handler(request, { waitUntil: (p) => ctx.waitUntil(p) });`);
  body.push(`  },`);
  body.push(`};`);

  return [...imports, "", ...body].join("\n") + "\n";
}
