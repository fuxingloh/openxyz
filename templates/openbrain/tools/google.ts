import { google } from "@ai-sdk/google";
import { stepCountIs, ToolLoopAgent } from "ai";
import { tool, z } from "openxyz/tools";
import { env } from "openxyz/env";

env.GOOGLE_GENERATIVE_AI_API_KEY.describe("Google Generative AI (Gemini) API key — https://aistudio.google.com/apikey");

// language=Markdown
const instructions = `
You're a Google Research Agent that finds and analyzes content on the open web.
Use google_search to discover pages, articles, and references.
Use url_context to pull the full content of a specific URL when the search snippet isn't enough.

Always return as much information as possible — do not summarize or omit fields.
Include every available detail: titles, URLs, source/domain, snippets, publish dates, authors
when available, and any other metadata returned by the tools.

## Response format

Respond in JSON. Return an object with a \`results\` array containing all discovered items.
Each item should include every field available from the search results — do not assume what
the caller needs. If the user explicitly requests a different format (e.g. markdown), follow
their instructions.
`.trim();

const agent = new ToolLoopAgent({
  model: google("gemini-2.5-flash"),
  instructions,
  tools: {
    google_search: google.tools.googleSearch({}),
    url_context: google.tools.urlContext({}),
  },
  stopWhen: stepCountIs(5),
});

export const research = tool({
  description: [
    "Research the open web via Google — find pages, articles, and references on any topic.",
    "Returns structured JSON with URLs, titles, sources, and snippets.",
    "",
    "Use this for general web research, background on companies / products / people, news scouting,",
    "or cross-referencing claims. Prefer `x_research` when the target surface is X (Twitter) specifically.",
  ].join("\n"),
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Natural-language research question. Be specific about topic, timeframe, and desired output shape — the sub-agent interprets this directly.",
      ),
  }),
  execute: async ({ query }, { abortSignal }) => {
    const { text } = await agent.generate({ prompt: query, abortSignal });
    return text;
  },
});
