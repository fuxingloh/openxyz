import { join } from "node:path";
import type { Tool } from "ai";
import { OpenXyz, type OpenXyzTemplate } from "@openxyz/harness/openxyz";
import { buildChannelFile, type ChannelFile } from "@openxyz/harness/channels";
import { parseAgent, type AgentDef } from "@openxyz/harness/agents/factory";
import { parseSkill, type SkillInfo } from "@openxyz/harness/tools/skill";
import { createChatState } from "@openxyz/harness/databases";
import { Command } from "commander";
import { scanTemplate, type OpenXyzTemplateFiles } from "../scan";

export default new Command("start").option("-p, --port <port>", "Port to listen on").action(action);

async function action(): Promise<void> {
  const files = await scanTemplate(process.cwd());
  if (Object.keys(files.channels).length === 0) {
    console.error("[openxyz] no channels found under channels/*.ts — nothing to run");
    process.exit(1);
  }

  const template = await loadTemplate(files);
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
 * same `OpenXyzTemplateFiles` shape instead.
 */
async function loadTemplate(files: OpenXyzTemplateFiles): Promise<OpenXyzTemplate> {
  const abs = (p: string) => join(files.cwd, p);

  const channels: Record<string, ChannelFile> = {};
  for (const [name, path] of Object.entries(files.channels)) {
    const mod = await import(abs(path));
    channels[name] = buildChannelFile(mod, name);
  }

  const tools: Record<string, Tool> = {};
  for (const [name, path] of Object.entries(files.tools)) {
    const mod = await import(abs(path));
    if (!mod.default) {
      console.warn(`[openxyz] tools/${name} has no default export, skipping`);
      continue;
    }
    tools[name] = mod.default;
  }

  const agents: Record<string, AgentDef> = {};
  for (const [name, path] of Object.entries(files.agents)) {
    const raw = await Bun.file(abs(path)).text();
    const def = parseAgent(name, raw);
    if (def) agents[name] = def;
  }

  const skills: SkillInfo[] = [];
  for (const path of Object.values(files.skills)) {
    const raw = await Bun.file(abs(path)).text();
    const info = parseSkill(abs(path), raw);
    if (info) skills.push(info);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  const mds: { agents?: string } = {};
  if (files.mds.agents) mds.agents = await Bun.file(abs(files.mds.agents)).text();

  return { cwd: files.cwd, channels, tools, agents, skills, mds };
}
