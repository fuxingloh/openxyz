import { ToolLoopAgent } from "ai";
import type { Tool } from "ai";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import matter from "gray-matter";
import { scanSkills, createSkillTool, type SkillInfo } from "../tools/skill";
import { scanTools } from "../tools/custom";
import { FilesystemTools, FilesystemConfigSchema } from "../tools/filesystem";
import { web_fetch, web_search } from "../tools/web";
import { model } from "./main";
import basePrompt from "./prompts/openxyz.md" with { type: "text" };

const AgentSchema = z.object({
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  tools: z
    .record(z.string(), z.union([z.literal(true), z.literal(false), z.record(z.string(), z.unknown())]))
    .optional(),
  skills: z.array(z.string()).optional(),
  filesystem: FilesystemConfigSchema,
  // TODO: model override — `model:` field in frontmatter, needs provider routing
});

export type AgentDef = z.infer<typeof AgentSchema>;

function formatSkillsXml(skills: SkillInfo[]): string {
  return [
    "<available_skills>",
    ...skills.map((s) =>
      [`  <skill>`, `    <name>${s.name}</name>`, `    <description>${s.description}</description>`, `  </skill>`].join(
        "\n",
      ),
    ),
    "</available_skills>",
  ].join("\n");
}

const DEFAULTS_DIR = new URL("./defaults/", import.meta.url).pathname;

async function scanDir(dir: string): Promise<Record<string, AgentDef>> {
  const glob = new Bun.Glob("[!_]*.md");
  const agents: Record<string, AgentDef> = {};

  for await (const rel of glob.scan({ cwd: dir })) {
    const name = rel.replace(/\.md$/, "");
    const raw = await Bun.file(join(dir, rel)).text();
    const { data, content } = matter(raw);

    const result = AgentSchema.safeParse({
      name,
      description: data.description,
      prompt: content.trim(),
      tools: data.tools,
      skills: data.skills,
      filesystem: data.filesystem,
    });

    if (!result.success) {
      console.warn(
        `[openxyz] agents/${rel} invalid frontmatter: ${result.error.issues.map((i) => i.message).join(", ")}`,
      );
      continue;
    }

    agents[name] = result.data;
  }

  return agents;
}

export class AgentFactory {
  readonly #cwd: string;
  readonly #home: string;
  #skills: SkillInfo[] = [];
  #customTools: Record<string, Tool> = {};
  #defs: Record<string, AgentDef> = {};

  constructor(cwd: string) {
    this.#cwd = cwd;
    this.#home = `/home/${basename(cwd)}`;
  }

  async init(): Promise<void> {
    const customDir = join(this.#cwd, "agents");
    const [skills, customTools, defaults, overrides] = await Promise.all([
      scanSkills(this.#cwd),
      scanTools(this.#cwd),
      scanDir(DEFAULTS_DIR),
      existsSync(customDir) ? scanDir(customDir) : {},
    ]);
    this.#skills = skills;
    this.#customTools = customTools;
    this.#defs = { ...defaults, ...overrides };
  }

  async load(): Promise<Record<string, ToolLoopAgent>> {
    const agents: Record<string, ToolLoopAgent> = {};
    for (const [name, def] of Object.entries(this.#defs)) {
      agents[name] = await this.#create(def);
    }
    return agents;
  }

  async #create(def: AgentDef): Promise<ToolLoopAgent> {
    const tools = this.#loadTools(def);
    const skills = this.#filterSkills(def);
    const instructions = await this.#buildInstructions(def, tools, skills);

    return new ToolLoopAgent({
      model,
      instructions: { role: "system" as const, content: instructions },
      tools,
    });
  }

  #loadTools(def: AgentDef): Record<string, Tool> {
    const fs = new FilesystemTools(this.#cwd, def.filesystem);
    const all: Record<string, Tool> = {
      ...fs.tools(),
      web_fetch,
      web_search,
      skill: createSkillTool(this.#filterSkills(def)),
      ...this.#customTools,
    };

    if (!def.tools) return all;

    const filtered: Record<string, Tool> = {};
    for (const [name, config] of Object.entries(def.tools)) {
      if (config && all[name]) {
        filtered[name] = all[name];
      }
    }
    return filtered;
  }

  #filterSkills(def: AgentDef): SkillInfo[] {
    if (def.skills === undefined) return this.#skills;
    if (def.skills.length === 0) return [];
    const set = new Set(def.skills);
    return this.#skills.filter((s) => set.has(s.name));
  }

  async #buildInstructions(def: AgentDef, tools: Record<string, Tool>, skills: SkillInfo[]): Promise<string> {
    const parts = [basePrompt];

    if (skills.length > 0 && tools["skill"]) {
      parts.push(
        [
          "## Skills",
          "",
          "Skills provide specialized instructions for recurring tasks. When you recognize that a task matches one of the available skills below, use the `skill` tool to load the full instructions before proceeding.",
          "",
          formatSkillsXml(skills),
        ].join("\n"),
      );
    }

    const agentsFile = Bun.file(join(this.#cwd, "AGENTS.md"));
    if (await agentsFile.exists()) {
      parts.push("## Project Instructions\n\n" + (await agentsFile.text()).trim());
    }

    const fsConfig = def.filesystem;
    const access = typeof fsConfig === "string" ? fsConfig : (fsConfig?.["harness"] ?? "read-write");
    parts.push(["## Environment", "", `- Home: ${this.#home}`, `- Filesystem: ${access}`].join("\n"));

    if (def.prompt) {
      parts.push(def.prompt);
    }

    return parts.join("\n\n");
  }
}
