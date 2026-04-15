import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// TODO(?): During testing:
//  Route through opencode.ai's hosted OpenAI-compatible gateway. See mnemonic/025.
const zen = createOpenAICompatible({
  name: "opencode-zen",
  apiKey: "public",
  baseURL: "https://opencode.ai/zen/v1",
});

// TODO: Model configurability — should come from template config, not hardcoded.
export const model = zen("big-pickle");
