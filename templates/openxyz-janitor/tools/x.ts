import { xai } from "@ai-sdk/xai";
import { stepCountIs, ToolLoopAgent } from "ai";
import { tool, z } from "openxyz/tools";
import { readEnv } from "openxyz/env";

readEnv("XAI_API_KEY", {
  description: "xAI API key — https://console.x.ai (Grok Live Search requires a paid plan)",
});

// language=Markdown
const instructions = `
You're an X Research Agent that finds and analyzes content on X (Twitter).
Use x_search to discover tweets, discussions, and profiles.

Always return as much information as possible — do not summarize or omit fields.
Include every available detail: full tweet text, username, display name, URL, timestamps,
like / retweet / reply counts, media URLs, and any other metadata returned by the tools.

## Response format

Respond in JSON. Return an object with a \`results\` array containing all discovered items.
Each item should include every field available from the search results — do not assume what
the caller needs. If the user explicitly requests a different format (e.g. markdown), follow
their instructions.
`.trim();

const agent = new ToolLoopAgent({
  model: xai.responses("grok-4-1-fast-reasoning"),
  instructions,
  tools: {
    x_search: xai.tools.xSearch({}),
  },
  stopWhen: stepCountIs(5),
});

export const research = tool({
  description: [
    "Research X (Twitter) — find tweets, profiles, and discussions.",
    "Returns structured JSON with full tweet metadata (text, author, URL, timestamps, engagement counts, media).",
    "",
    "Use this when the team asks what's being said on X about a topic, who's talking about something,",
    "or wants to scout narratives, launches, or reactions. Prefer this over a raw web search when",
    "the target surface is X specifically.",
  ].join("\n"),
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Natural-language research question. Be specific about the topic, timeframe, and desired output shape — the sub-agent interprets this directly.",
      ),
  }),
  execute: async ({ query }, { abortSignal }) => {
    const { text } = await agent.generate({ prompt: query, abortSignal });
    return text;
  },
});
