import { join } from "node:path";
import type { Tool } from "ai";
import { OpenXyz, type Model, type OpenXyzRuntime } from "@openxyz/runtime/openxyz";
import { loadChannel, type Channel } from "@openxyz/runtime/channels";
import { parseAgent, type AgentDef } from "@openxyz/runtime/agents/factory";
import { parseSkill, type SkillDef } from "@openxyz/runtime/tools/skill";
import { createChatState } from "@openxyz/runtime/databases";
import { HomeDrive } from "@openxyz/runtime/drives/home";
import type { Drive } from "@openxyz/runtime/drive";
import { Command } from "commander";
import { scanDir, type OpenXyzFiles } from "../scan";

export default new Command("start").option("-p, --port <port>", "Port to listen on").action(action);

async function action(): Promise<void> {
  const files = await scanDir(process.cwd());
  if (Object.keys(files.template.channels).length === 0) {
    console.error("[openxyz] no channels found under channels/*.{js,ts} — nothing to run");
    process.exit(1);
  }

  const runtime = await loadRuntime(files);
  const openxyz = new OpenXyz(runtime);
  const state = await createChatState(runtime.cwd);
  await openxyz.init({ state });
  console.log("openxyz running. Ctrl-C to quit.");

  await new Promise<void>((resolve) => {
    process.on("SIGINT", resolve);
    process.on("SIGTERM", resolve);
  });

  await openxyz.stop();
  process.exit(0);
}

/**
 * Turn a filesystem enumeration into an `OpenXyzTemplate` by dynamically
 * importing modules, reading markdown, and parsing frontmatter.
 *
 * `openxyz build` doesn't call this — it code-gens static imports from the
 * same `OpenXyzFiles` shape instead.
 */
async function loadRuntime(scan: OpenXyzFiles): Promise<OpenXyzRuntime> {
  const abs = (p: string) => join(scan.cwd, p);
  const t = scan.template;

  const channels: Record<string, Channel> = {};
  for (const [name, path] of Object.entries(t.channels)) {
    const mod = await import(abs(path));
    channels[name] = loadChannel(mod, name);
  }

  const tools: Record<string, Tool> = {};
  for (const [name, path] of Object.entries(t.tools)) {
    const mod = await import(abs(path));
    if (!mod.default) {
      console.warn(`[openxyz] tools/${name} has no default export, skipping`);
      continue;
    }
    tools[name] = mod.default;
  }

  // TODO: add a toggle so templates can opt out of shipped agents.
  const agents: Record<string, AgentDef> = { ...(await loadDefaultAgents()) };
  for (const [name, path] of Object.entries(t.agents)) {
    const raw = await Bun.file(abs(path)).text();
    const def = parseAgent(name, raw);
    if (def) agents[name] = def;
  }

  // Walk every agent → set of model names we need to load. Zod schema
  // defaults `model` to "auto", so it's always a string post-parse.
  const used = new Set<string>();
  for (const def of Object.values(agents)) {
    used.add(def.model);
  }

  const models: Record<string, Model> = {};
  for (const name of used) {
    const path = t.models[name]
      ? abs(t.models[name]!)
      : name === "auto"
        ? new URL("../../models/auto.ts", import.meta.url).pathname
        : undefined;
    if (!path) continue; // referenced but no source — surfaces clearly when an agent picks it
    const mod = await import(path);
    if (!mod.default) {
      console.warn(`[openxyz] models/${name} has no default export, skipping`);
      continue;
    }
    // Default export may be a concrete `Model` or a factory function
    // (e.g. `auto.ts` that resolves `OPENXYZ_MODEL` at load time).
    models[name] = typeof mod.default === "function" ? await mod.default() : mod.default;
  }

  const skills: SkillDef[] = [];
  for (const path of Object.values(t.skills)) {
    const raw = await Bun.file(abs(path)).text();
    const info = parseSkill(abs(path), raw);
    if (info) skills.push(info);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  const mds: { agents?: string } = {};
  if (t.mds.agents) mds.agents = await Bun.file(abs(t.mds.agents)).text();

  // Drives: HomeDrive is always mounted at /home/openxyz. Template-provided
  // `drives/<name>.ts` files mount at `/mnt/<name>/`.
  const drives: Record<string, Drive> = {
    "/home/openxyz": new HomeDrive(scan.cwd, "read-write"),
  };
  for (const [name, path] of Object.entries(t.drives)) {
    const mod = await import(abs(path));
    if (!mod.default) {
      console.warn(`[openxyz] drives/${name} has no default export, skipping`);
      continue;
    }
    drives[`/mnt/${name}`] = mod.default as Drive;
  }

  return { cwd: scan.cwd, channels, tools, agents, models, drives, skills, mds };
}

/**
 * Load the openxyz-shipped default agents (auto, explore, research, compact)
 * from `packages/openxyz/agents/*.md`. Parsed via `parseAgent` — same code
 * path as template agents, so schema rules apply uniformly.
 */
async function loadDefaultAgents(): Promise<Record<string, AgentDef>> {
  const dir = new URL("../../agents/", import.meta.url).pathname;
  const out: Record<string, AgentDef> = {};
  for await (const file of new Bun.Glob("*.md").scan({ cwd: dir })) {
    const name = file.replace(/\.md$/, "");
    const raw = await Bun.file(join(dir, file)).text();
    const def = parseAgent(name, raw);
    if (def) out[name] = def;
  }
  return out;
}
