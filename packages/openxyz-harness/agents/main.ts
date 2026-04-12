import { ToolLoopAgent } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Filesystem } from "../tools/filesystem";
import generic from "./prompts/generic.md" with { type: "text" };

// TODO(?): During testing:
//  Route through opencode.ai's hosted OpenAI-compatible gateway. See working/025.
const zen = createOpenAICompatible({
  name: "opencode-zen",
  apiKey: "public",
  baseURL: "https://opencode.ai/zen/v1",
});

export function create(cwd: string) {
  const fs = new Filesystem(cwd);
  return new ToolLoopAgent({
    model: zen("big-pickle"),
    instructions: generic,
    tools: fs.getTools(),
  });
}

// TODO(?): currently stop condition not scalable.
