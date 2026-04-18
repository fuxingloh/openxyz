import { tool, z } from "openxyz/tools";
import { readEnv } from "openxyz/env";

const JINA_API_KEY = readEnv("JINA_API_KEY", {
  description: "Jina Reader API key — https://jina.ai/reader",
});

interface JinaReaderResponse {
  code: number;
  status: number;
  data?: {
    url: string;
    title: string;
    content: string;
  };
}

export const fetch_markdown = tool({
  description: [
    "Fetch a URL via Jina Reader and return the main content as clean markdown.",
    "",
    "Use this over a raw HTTP fetch when:",
    "- the page is JavaScript-rendered (SPA, docs sites, dashboards) and a raw GET returns an empty shell",
    "- the origin sits behind Cloudflare / anti-bot / paywall-lite protection that blocks unauthenticated fetches",
    "- you want boilerplate (nav, footer, cookie banners, ads) stripped so only the article / docs body remains",
    "- you're reading a PDF and want it linearized to markdown instead of binary bytes",
    "",
    "Returns `{ url, title, content }` where `content` is markdown — safe to pass straight into another tool or quote back to the user. Do not use this for JSON APIs, auth'd endpoints, or anything requiring a POST body.",
  ].join("\n"),
  inputSchema: z.object({
    url: z.url().describe("Fully-qualified http(s) URL of the page to read"),
  }),
  execute: async ({ url }) => {
    const res = await fetch("https://r.jina.ai/", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${JINA_API_KEY}`,
      },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      throw new Error(`Jina API error: ${res.status} ${res.statusText}`);
    }

    const { data } = (await res.json()) as JinaReaderResponse;
    return {
      url: data?.url ?? url,
      title: data?.title ?? "",
      content: data?.content ?? "",
    };
  },
});
