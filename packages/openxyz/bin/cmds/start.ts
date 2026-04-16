import { join } from "node:path";
import type { LanguageModel, Tool } from "ai";
import { OpenXyz, type OpenXyzTemplate } from "@openxyz/harness/openxyz";
import { buildChannelFile, type ChannelFile } from "@openxyz/harness/channels";
import { parseAgent, type AgentDef } from "@openxyz/harness/agents/factory";
import { parseSkill, type SkillInfo } from "@openxyz/harness/tools/skill";
import { createChatState } from "@openxyz/harness/databases";
import { Command } from "commander";
import { scanTemplate, type OpenXyzFiles } from "../scan";

export default new Command("start").option("-p, --port <port>", "Port to listen on").action(action);

async function action(): Promise<void> {
  const scan = await scanTemplate(process.cwd());
  if (Object.keys(scan.template.channels).length === 0) {
    console.error("[openxyz] no channels found under channels/*.ts — nothing to run");
    process.exit(1);
  }

  const template = await loadTemplate(scan);
  const openxyz = new OpenXyz(template);
  const state = await createChatState(template.cwd);
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
async function loadTemplate(scan: OpenXyzFiles): Promise<OpenXyzTemplate> {
  const abs = (p: string) => join(scan.cwd, p);
  const t = scan.template;

  const channels: Record<string, ChannelFile> = {};
  for (const [name, path] of Object.entries(t.channels)) {
    const mod = await import(abs(path));
    channels[name] = buildChannelFile(mod, name);
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

  const agents: Record<string, AgentDef> = {};
  for (const [name, path] of Object.entries(t.agents)) {
    const raw = await Bun.file(abs(path)).text();
    const def = parseAgent(name, raw);
    if (def) agents[name] = def;
  }

  const models: Record<string, LanguageModel> = {};
  for (const [name, path] of Object.entries(t.models)) {
    const mod = await import(abs(path));
    if (!mod.default) {
      console.warn(`[openxyz] models/${name} has no default export, skipping`);
      continue;
    }
    models[name] = mod.default;
  }

  const skills: SkillInfo[] = [];
  for (const path of Object.values(t.skills)) {
    const raw = await Bun.file(abs(path)).text();
    const info = parseSkill(abs(path), raw);
    if (info) skills.push(info);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  const mds: { agents?: string } = {};
  if (t.mds.agents) mds.agents = await Bun.file(abs(t.mds.agents)).text();

  return { cwd: scan.cwd, channels, tools, agents, models, skills, mds };
}
