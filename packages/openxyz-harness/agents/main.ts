import { ToolLoopAgent } from "ai";
import type { Tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { join } from "node:path";
import basePrompt from "./prompts/openxyz.md" with { type: "text" };

// TODO(?): During testing:
//  Route through opencode.ai's hosted OpenAI-compatible gateway. See working/025.
const zen = createOpenAICompatible({
  name: "opencode-zen",
  apiKey: "public",
  baseURL: "https://opencode.ai/zen/v1",
});

async function buildInstructions(cwd: string) {
  // Static base prompt — cacheable
  const parts = [basePrompt];
  const agentsFile = Bun.file(join(cwd, "AGENTS.md"));
  if (await agentsFile.exists()) {
    parts.push("## Project Instructions\n\n" + (await agentsFile.text()).trim());
  }
  return parts.join("\n\n");
}

export async function create(cwd: string, tools: Record<string, Tool>) {
  const instructions = await buildInstructions(cwd);
  return new ToolLoopAgent({
    model: zen("big-pickle"),
    instructions: { role: "system" as const, content: instructions },
    tools,
  });
}
