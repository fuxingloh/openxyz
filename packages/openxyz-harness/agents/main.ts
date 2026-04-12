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

async function buildPrompt(cwd: string): Promise<string> {
  const parts = [basePrompt];

  const agentsFile = Bun.file(join(cwd, "AGENTS.md"));
  if (await agentsFile.exists()) {
    parts.push("## Project Instructions\n\n" + (await agentsFile.text()).trim());
  }

  parts.push(
    [
      "## Environment",
      "",
      `- Date: ${new Date().toISOString().split("T")[0]}`,
      `- Platform: ${process.platform}`,
      `- Working directory: ${cwd}`,
    ].join("\n"),
  );

  return parts.join("\n\n");
}

export async function create(cwd: string, tools: Record<string, Tool>) {
  const instructions = await buildPrompt(cwd);
  return new ToolLoopAgent({
    model: zen("big-pickle"),
    instructions,
    tools,
  });
}
