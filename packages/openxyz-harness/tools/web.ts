import { tool } from "ai";
import { z } from "zod";
import TurndownService from "turndown";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  td.remove(["script", "style", "meta", "link"]);
  return td.turndown(html);
}

async function extractText(html: string): Promise<string> {
  let text = "";
  let skip = false;
  const skip_tags = ["script", "style", "noscript", "iframe", "object", "embed"];

  const rewriter = new HTMLRewriter()
    .on(skip_tags.join(", "), {
      element() {
        skip = true;
      },
    })
    .on("*", {
      element(el) {
        if (!skip_tags.includes(el.tagName)) skip = false;
      },
      text(input) {
        if (!skip) text += input.text;
      },
    })
    .transform(new Response(html));

  await rewriter.text();
  return text.trim();
}

export const web_fetch = tool({
  description: [
    "Fetch content from a URL and return it in the requested format.",
    "",
    "Usage notes:",
    '  - Format options: "markdown" (default), "text", or "html".',
    "  - HTTP URLs are automatically upgraded to HTTPS.",
    "  - This tool is read-only.",
    "  - Results may be truncated if the content is very large.",
  ].join("\n"),
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch content from."),
    format: z.enum(["text", "markdown", "html"]).default("markdown").describe("Output format. Defaults to markdown."),
    timeout: z.number().optional().describe("Timeout in seconds (max 120)."),
  }),
  execute: async ({ url, format, timeout }) => {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://");
    }

    const ms = Math.min((timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT);
    const accept: Record<string, string> = {
      markdown: "text/markdown;q=1.0, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
      text: "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
      html: "text/html;q=1.0, application/xhtml+xml;q=0.9, */*;q=0.1",
    };

    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: accept[format] ?? "*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(ms),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error("Response too large (exceeds 5MB limit)");

    const ct = res.headers.get("content-type") ?? "";
    const body = new TextDecoder().decode(buf);

    if (format === "markdown" && ct.includes("text/html")) return htmlToMarkdown(body);
    if (format === "text" && ct.includes("text/html")) return extractText(body);
    return body;
  },
});

// Exa MCP endpoint — same as opencode (no auth required)
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

async function exaSearch(args: {
  query: string;
  type: string;
  numResults: number;
  livecrawl: string;
}): Promise<string | undefined> {
  const res = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "web_search_exa", arguments: args },
    }),
    signal: AbortSignal.timeout(25_000),
  });

  if (!res.ok) throw new Error(`Exa search failed: HTTP ${res.status}`);

  const body = await res.text();
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = JSON.parse(line.slice(6));
    if (data?.result?.content?.[0]?.text) return data.result.content[0].text;
  }
  return undefined;
}

const year = new Date().getFullYear().toString();

export const web_search = tool({
  description: [
    "Search the web using Exa AI for real-time information.",
    "",
    "Usage notes:",
    "  - Returns content from the most relevant websites.",
    "  - Use for accessing information beyond your knowledge cutoff.",
    "  - Search types: 'auto' (balanced), 'fast' (quick), 'deep' (comprehensive).",
    "  - Live crawl modes: 'fallback' (cached first) or 'preferred' (always crawl).",
    "",
    `The current year is ${year}. Use this year when searching for recent information.`,
  ].join("\n"),
  inputSchema: z.object({
    query: z.string().describe("Web search query."),
    num_results: z.number().optional().describe("Number of results to return (default: 8)."),
    type: z.enum(["auto", "fast", "deep"]).optional().describe("Search type. Defaults to auto."),
    livecrawl: z.enum(["fallback", "preferred"]).optional().describe("Live crawl mode. Defaults to fallback."),
  }),
  execute: async ({ query, num_results, type, livecrawl }) => {
    const result = await exaSearch({
      query,
      type: type ?? "auto",
      numResults: num_results ?? 8,
      livecrawl: livecrawl ?? "fallback",
    });
    return result ?? "No search results found. Please try a different query.";
  },
});
