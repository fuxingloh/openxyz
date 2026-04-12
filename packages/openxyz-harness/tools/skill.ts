import { join, dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import matter from "gray-matter";

// TODO: SKILL.md frontmatter could support `allowed-tools` to restrict which tools the agent
//  can use while executing a skill (e.g. research skill only allows web_search + web_fetch).
//  Claude Code and opencode both support this. May or may not want this — skills currently
//  just inject instructions, they don't constrain the tool set.
export interface SkillInfo {
  name: string;
  description: string;
  location: string;
  content: string;
}

export async function scanSkills(cwd: string): Promise<SkillInfo[]> {
  const glob = new Bun.Glob("skills/**/SKILL.md");
  const skills: SkillInfo[] = [];

  for await (const rel of glob.scan({ cwd })) {
    const abs = join(cwd, rel);
    const raw = await Bun.file(abs).text();
    const { data, content } = matter(raw);

    if (!data.name || !data.description) {
      console.warn(`[openxyz] ${rel} missing name or description in frontmatter, skipping`);
      continue;
    }

    skills.push({
      name: data.name,
      description: data.description,
      location: abs,
      content,
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function createSkillTool(skills: SkillInfo[]) {
  return tool({
    description: "Load a skill by name. Available skills are listed in the system prompt.",
    inputSchema: z.object({
      name: z.string().describe("The name of the skill from available skills."),
    }),
    execute: async ({ name }) => {
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ");
        throw new Error(`Skill "${name}" not found. Available skills: ${available || "none"}`);
      }

      const dir = dirname(skill.location);
      const glob = new Bun.Glob("*");
      const files: string[] = [];
      for await (const rel of glob.scan({ cwd: dir })) {
        if (rel === "SKILL.md") continue;
        files.push(join(dir, rel));
        if (files.length >= 10) break;
      }

      return [
        `<skill_content name="${skill.name}">`,
        `# Skill: ${skill.name}`,
        "",
        skill.content.trim(),
        "",
        `Base directory: ${dir}`,
        "",
        "<skill_files>",
        ...files.map((f) => `<file>${f}</file>`),
        "</skill_files>",
        "</skill_content>",
      ].join("\n");
    },
  });
}
