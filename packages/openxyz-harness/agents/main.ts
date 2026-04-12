import { ToolLoopAgent } from "ai";
import type { Tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { join } from "node:path";
import type { SkillInfo } from "../tools/skill";
import basePrompt from "./prompts/openxyz.md" with { type: "text" };

// TODO(?): During testing:
//  Route through opencode.ai's hosted OpenAI-compatible gateway. See working/025.
const zen = createOpenAICompatible({
  name: "opencode-zen",
  apiKey: "public",
  baseURL: "https://opencode.ai/zen/v1",
});

function formatSkillsXml(skills: SkillInfo[]): string {
  const entries = skills.map((s) =>
    [`  <skill>`, `    <name>${s.name}</name>`, `    <description>${s.description}</description>`, `  </skill>`].join(
      "\n",
    ),
  );
  return ["<available_skills>", ...entries, "</available_skills>"].join("\n");
}

async function buildInstructions(cwd: string, skills: SkillInfo[]) {
  // Static base prompt — cacheable
  const parts = [basePrompt];

  if (skills.length > 0) {
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

  const agentsFile = Bun.file(join(cwd, "AGENTS.md"));
  if (await agentsFile.exists()) {
    parts.push("## Project Instructions\n\n" + (await agentsFile.text()).trim());
  }
  return parts.join("\n\n");
}

export async function create(cwd: string, tools: Record<string, Tool>, skills: SkillInfo[]) {
  const instructions = await buildInstructions(cwd, skills);
  return new ToolLoopAgent({
    model: zen("big-pickle"),
    instructions: { role: "system" as const, content: instructions },
    tools,
  });
}
