import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import { matter } from "../utils/frontmatter";
import { createSkillTool, type SkillDef } from "../tools/skill";
import { FilesystemTools, FilesystemConfigSchema } from "../tools/filesystem";
import { web_fetch, web_search } from "../tools/web";
import type { OpenXyzRuntime } from "../openxyz";
import { Agent } from "./agent";

const AgentFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  skills: z.array(z.string()).optional(),
  tools: z
    .record(z.string(), z.union([z.literal(true), z.literal(false), z.record(z.string(), z.unknown())]))
    .default({ "*": true }),
  filesystem: FilesystemConfigSchema,
  /** Name from the models. Falls back to "auto" when omitted. */
  model: z.string().default("auto"),
});

const AgentDefSchema = AgentFrontmatterSchema.extend({
  instructions: z.string(),
});

export type AgentDef = z.infer<typeof AgentDefSchema>;

function formatAgentList(defs: Record<string, AgentDef>): string {
  return Object.values(defs)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `- **${a.name}**: ${a.description}`)
    .join("\n");
}

/**
 * Minimal glob matcher for agent `tools:` frontmatter. Supports `*` (any run
 * of chars including none) and `?` (single char). Fast-path for exact strings
 * avoids regex allocation for the common case.
 */
function matchGlob(pattern: string, value: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === value;
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return re.test(value);
}

export function parseAgent(name: string, raw: string): AgentDef | undefined {
  const { data, content } = matter(raw);
  const result = AgentDefSchema.safeParse({ ...data, name, instructions: content.trim() });
  if (!result.success) {
    console.warn(
      `[openxyz] agent "${name}" invalid frontmatter: ${result.error.issues.map((i) => i.message).join(", ")}`,
    );
    return undefined;
  }
  return result.data;
}

export class AgentFactory {
  readonly #runtime: OpenXyzRuntime;

  constructor(runtime: OpenXyzRuntime) {
    this.#runtime = runtime;
  }

  async create(name: string, opts?: { delegate?: boolean }): Promise<Agent> {
    const def = this.#runtime.agents[name];
    if (!def) {
      const available = Object.keys(this.#runtime.agents).join(", ");
      throw new Error(`[openxyz] agent "${name}" not found. Available: ${available}`);
    }

    const modelName = def.model;
    const model = this.#runtime.models[modelName];
    if (!model) {
      const available = Object.keys(this.#runtime.models).join(", ") || "<none>";
      throw new Error(`[openxyz] agent "${name}" references model "${modelName}" — not found. Available: ${available}`);
    }

    const tools = this.#loadTools(def);
    // Runtime hard-off: sub-agents spawned via delegate can never re-delegate,
    // regardless of what their frontmatter allows. Frontmatter controls the
    // opt-in for top-level agents (`delegate` is in the filterable tool set).
    if (opts?.delegate === false) delete tools.delegate;

    const skills = this.#filterSkills(def);

    return new Agent({
      def,
      factory: this,
      model,
      tools,
      skills,
      mds: this.#runtime.mds,
    });
  }

  #createDelegateTool() {
    const factory = this;

    return tool({
      description: [
        "Delegate work to a specialized agent that runs in its own context.",
        "",
        "Use this when:",
        "- You need to research multiple things in parallel",
        "- A task benefits from a fresh, focused context",
        "- A specialized agent exists for the work",
        "",
        "Each delegated task runs independently — it cannot see your conversation history.",
        "Launch multiple delegate calls in parallel when the work is independent.",
        "",
        "## Available Agents",
        // TODO(?): allow agents to agents communication to be configurable
        formatAgentList(factory.#runtime.agents),
      ].join("\n"),
      inputSchema: z.object({
        description: z.string().describe("Short (3-5 words) task description."),
        prompt: z.string().describe("Full task prompt for the agent."),
        agent: z.string().default("auto").describe("Agent name. Defaults to 'auto'."),
      }),
      execute: async ({ description, prompt, agent: name }) => {
        const sub = await factory.create(name, { delegate: false });
        const result = await sub.generate({ prompt });
        return `<delegate_result agent="${name}" description="${description}">\n${result.text}\n</delegate_result>`;
      },
    });
  }

  #loadTools(def: AgentDef): Record<string, Tool> {
    const fs = new FilesystemTools(this.#runtime.drives, def.filesystem);
    const all: Record<string, Tool> = {
      ...fs.tools(),
      web_fetch,
      web_search,
      skill: createSkillTool(this.#filterSkills(def)),
      delegate: this.#createDelegateTool(),
      ...this.#runtime.tools,
    };

    // Glob patterns (`nocodb_*`, `github_issues_*`) + exact-string matches in
    // one pass. Last rule wins — iterate entries in declared order so
    // `nocodb_*: true` then `nocodb_delete: false` produces the expected
    // allow-with-one-deny result. Exact strings are just wildcard-free globs.
    // Zod defaults an absent field to `{ "*": true }`, so this always runs.
    const rules = Object.entries(def.tools);
    const filtered: Record<string, Tool> = {};
    for (const [id, tool] of Object.entries(all)) {
      let allowed = false;
      for (const [pattern, config] of rules) {
        if (!matchGlob(pattern, id)) continue;
        allowed = !!config;
      }
      if (allowed) filtered[id] = tool;
    }
    return filtered;
  }

  #filterSkills(def: AgentDef): SkillDef[] {
    if (def.skills === undefined) return this.#runtime.skills;
    if (def.skills.length === 0) return [];
    const set = new Set(def.skills);
    return this.#runtime.skills.filter((s) => set.has(s.name));
  }
}
