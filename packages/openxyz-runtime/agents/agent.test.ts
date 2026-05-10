import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Agent, buildSystemPrompt, formatSkippedSection, hardTruncate, safeBoundary } from "./agent.ts";
import type { AgentDef, AgentFactory } from "./factory.ts";
import type { Model } from "../model.ts";

function modelOf(raw: MockLanguageModelV3, systemPrompt = ""): Model {
  return { raw, systemPrompt, limit: { context: 200_000 } };
}

function defOf(name: string, overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name,
    description: "",
    tools: { "*": true },
    filesystem: "read-write",
    model: "auto",
    instructions: "",
    ...overrides,
  };
}

// ---- message builders ---------------------------------------------------

function userMsg(text: string): ModelMessage {
  return { role: "user", content: text };
}

function assistantText(text: string): ModelMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolCall(id: string, toolName: string): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName, input: {} }],
  };
}

function toolResult(id: string, toolName: string, value: string): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value } }],
  };
}

function systemMsg(text: string): ModelMessage {
  return { role: "system", content: text };
}

// ---- safeBoundary -------------------------------------------------------

describe("safeBoundary", () => {
  test("empty array → 0", () => {
    expect(safeBoundary([], 0)).toBe(0);
  });

  test("start past end clamps to length", () => {
    const msgs = [userMsg("a"), assistantText("b")];
    expect(safeBoundary(msgs, 99)).toBe(2);
  });

  test("negative start clamps to 0", () => {
    const msgs = [userMsg("a")];
    expect(safeBoundary(msgs, -5)).toBe(0);
  });

  test("start at user message stays put — user is always safe", () => {
    const msgs = [assistantText("a"), userMsg("b"), assistantText("c")];
    expect(safeBoundary(msgs, 1)).toBe(1);
  });

  test("start at assistant-text stays put — no tool-call to resolve", () => {
    const msgs = [userMsg("a"), assistantText("b"), userMsg("c")];
    expect(safeBoundary(msgs, 1)).toBe(1);
  });

  test("start on a tool message walks past it", () => {
    // Tool results belong to the preceding assistant — slicing here would
    // orphan them.
    const msgs = [userMsg("a"), assistantToolCall("t1", "bash"), toolResult("t1", "bash", "out"), userMsg("b")];
    expect(safeBoundary(msgs, 2)).toBe(3);
  });

  test("start on parallel tool-result run walks past ALL tool messages", () => {
    // streamText fans out parallel calls and can emit multiple tool messages
    // in sequence. All of them belong to the preceding assistant turn.
    const msgs = [
      userMsg("a"),
      assistantToolCall("t1", "bash"),
      toolResult("t1", "bash", "out1"),
      toolResult("t2", "bash", "out2"),
      toolResult("t3", "bash", "out3"),
      userMsg("b"),
    ];
    expect(safeBoundary(msgs, 2)).toBe(5);
  });

  test("start right after assistant-with-tool-calls advances past its results", () => {
    // i=2 is between the tool-call assistant and its result — cutting here
    // would leave the tool-call unresolved on the left AND the result
    // orphaned on the right. Walk forward past the result.
    const msgs = [userMsg("a"), assistantToolCall("t1", "bash"), toolResult("t1", "bash", "out"), userMsg("b")];
    expect(safeBoundary(msgs, 2)).toBe(3);
  });

  test("start at 0 is always safe", () => {
    const msgs = [assistantToolCall("t1", "bash"), toolResult("t1", "bash", "out")];
    expect(safeBoundary(msgs, 0)).toBe(0);
  });

  test("assistant with mixed text + tool-call triggers the tool-call rule", () => {
    // Even if the assistant has text too, the tool-call presence means its
    // results follow — we must walk past them.
    const mixed: ModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool-call", toolCallId: "t1", toolName: "bash", input: {} },
      ],
    };
    const msgs = [userMsg("a"), mixed, toolResult("t1", "bash", "x"), userMsg("b")];
    expect(safeBoundary(msgs, 2)).toBe(3);
  });

  test("string-content assistant is never treated as tool-bearing", () => {
    // `role: "assistant"` with plain-string content has no tool-calls by
    // construction. hasToolCalls returns false.
    const msgs = [userMsg("a"), { role: "assistant", content: "plain reply" } as ModelMessage, userMsg("b")];
    expect(safeBoundary(msgs, 1)).toBe(1);
  });
});

// ---- hardTruncate -------------------------------------------------------

describe("hardTruncate", () => {
  test("empty array returns empty", () => {
    expect(hardTruncate([], 100)).toEqual([]);
  });

  test("under budget returns original", () => {
    const msgs = [userMsg("a"), assistantText("b")];
    const out = hardTruncate(msgs, 1_000_000);
    expect(out).toEqual(msgs);
  });

  test("over budget drops oldest messages", () => {
    const msgs = [userMsg("X".repeat(500)), userMsg("Y".repeat(500)), userMsg("Z")];
    const out = hardTruncate(msgs, 50); // tight budget — must drop some
    expect(out.length).toBeLessThan(msgs.length);
    // What remains is a suffix of the input.
    expect(out[out.length - 1]).toEqual(msgs[msgs.length - 1]!);
  });

  test("never orphans tool-result at the new front", () => {
    // If the budget cut lands mid-pair, snap forward past tool messages.
    const msgs = [
      userMsg("X".repeat(2_000)),
      userMsg("Y".repeat(2_000)),
      assistantToolCall("t1", "bash"),
      toolResult("t1", "bash", "x"),
      userMsg("tail"),
    ];
    const out = hardTruncate(msgs, 50);
    // First surviving message must not be role:"tool".
    expect(out[0]?.role).not.toBe("tool");
  });

  test("never splits assistant-with-tool-calls from its results", () => {
    // A cut that lands right after assistant-with-tool-calls must advance
    // past the results.
    const msgs = [
      userMsg("X".repeat(3_000)),
      assistantToolCall("t1", "bash"),
      toolResult("t1", "bash", "x"),
      userMsg("tail"),
    ];
    const out = hardTruncate(msgs, 50);
    // If the assistant-tool-call survived, the tool-result must too.
    const hasToolCall = out.some(
      (m) => m.role === "assistant" && typeof m.content !== "string" && m.content.some((p) => p.type === "tool-call"),
    );
    const hasOrphanTool = out[0]?.role === "tool" && !out.some((m) => m.role === "assistant");
    if (hasToolCall) {
      expect(out.some((m) => m.role === "tool")).toBe(true);
    }
    expect(hasOrphanTool).toBe(false);
  });

  test("never returns empty when input is non-empty", () => {
    // Pair-safe snap could push past end if the tail is all tool messages.
    // Invariant: keep at least the last user message — empty messages array
    // 400s every provider (Bedrock: "A conversation must start with a user
    // message").
    const msgs = [userMsg("big"), assistantToolCall("t1", "bash"), toolResult("t1", "bash", "x")];
    const out = hardTruncate(msgs, 1); // impossibly tight
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.role).not.toBe("tool");
  });

  test("budget of 0 still respects pair safety and keeps a user turn", () => {
    const msgs = [userMsg("a"), assistantToolCall("t1", "bash"), toolResult("t1", "bash", "x")];
    const out = hardTruncate(msgs, 0);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.role).not.toBe("tool");
  });

  test("shrinks oversized FilePart to a text stub rather than dropping the turn", () => {
    // Single user message whose `FilePart` (e.g. a 16 MB PDF inlined per
    // mnemonic/170) blows the budget on its own. The whole-message drop loop
    // can't help — shrink heavy parts in place.
    const heavy = "x".repeat(10_000); // ~2.5K tokens by bytes/4
    const msg: ModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "file", data: heavy, mediaType: "application/pdf", filename: "deck.pdf" },
      ],
    };
    const out = hardTruncate([msg], 100);
    expect(out.length).toBe(1);
    expect(out[0]!.role).toBe("user");
    const content = out[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content.every((p) => p.type === "text")).toBe(true);
      const stub = content.find((p) => p.type === "text" && /elided/.test((p as { text: string }).text)) as
        | { text: string }
        | undefined;
      expect(stub).toBeDefined();
      expect(stub!.text).toMatch(/deck\.pdf/);
    }
  });
});

// ---- Agent ---------------------------------------------------------------

function stubFactory(): AgentFactory {
  // Not called by the tests below (no compaction triggered), but Agent's
  // constructor stores the reference. Any method access would throw.
  return {} as unknown as AgentFactory;
}

describe("Agent.generate", () => {
  test("delegates to inner ToolLoopAgent and returns its result", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          cachedInputTokens: undefined,
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });

    const agent = new Agent({
      def: defOf("test", { filesystem: "read-write" }),
      factory: stubFactory(),
      model: modelOf(model, "you are a test"),
      tools: {},
      skills: [],
    });

    const result = await agent.generate({ prompt: "hi" });
    expect(result.text).toBe("ok");
    expect(model.doGenerateCalls.length).toBe(1);
  });

  test("generate does NOT touch session, does NOT post to thread", async () => {
    // generate() is the one-shot path for delegate sub-agents + the compact
    // agent itself. It must not trigger the full run() machinery.
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          cachedInputTokens: undefined,
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const agent = new Agent({
      def: defOf("compact", { filesystem: "read-only" }),
      // Stub factory that throws if accessed — proves generate() never
      // reaches into compaction paths.
      factory: new Proxy({} as AgentFactory, {
        get() {
          throw new Error("factory should not be accessed from generate()");
        },
      }),
      model: modelOf(model),
      tools: {},
      skills: [],
    });
    const result = await agent.generate({ prompt: "summarize" });
    expect(result.text).toBe("done");
  });
});

// ---- buildSystemPrompt --------------------------------------------------

describe("buildSystemPrompt", () => {
  const baseConfig = {
    systemPrompt: "BASE",
    tools: {},
    skills: [],
    def: defOf("test"),
  };

  test("emits no AGENTS.md section when agentsMd absent", () => {
    const out = buildSystemPrompt(baseConfig);
    expect(out).not.toContain("## AGENTS.md");
  });

  test("renders AGENTS.md body under filename heading when present", () => {
    const out = buildSystemPrompt({ ...baseConfig, "AGENTS.md": "agents-body" });
    expect(out).toContain("## AGENTS.md");
    expect(out).toContain("agents-body");
  });

  test("whitespace-only agentsMd is skipped", () => {
    const out = buildSystemPrompt({ ...baseConfig, "AGENTS.md": "   \n  " });
    expect(out).not.toContain("## AGENTS.md");
  });

  test("base systemPrompt leads, AGENTS.md section follows", () => {
    const out = buildSystemPrompt({
      ...baseConfig,
      systemPrompt: "BASELINE_MARKER",
      "AGENTS.md": "agents-body",
    });
    expect(out.indexOf("BASELINE_MARKER")).toBeLessThan(out.indexOf("## AGENTS.md"));
  });

  test("emits no Unavailable section when skipped is absent or empty", () => {
    expect(buildSystemPrompt(baseConfig)).not.toContain("## Unavailable");
    expect(buildSystemPrompt({ ...baseConfig, skipped: [] })).not.toContain("## Unavailable");
  });

  test("renders Unavailable section last, after instructions", () => {
    const out = buildSystemPrompt({
      ...baseConfig,
      def: defOf("test", { instructions: "INSTRUCTIONS_MARKER" }),
      skipped: [{ kind: "tool", name: "github", reason: "env GITHUB_TOKEN is not set" }],
    });
    expect(out).toContain("## Unavailable");
    expect(out).toContain("**github**");
    expect(out).toContain("env GITHUB_TOKEN is not set");
    expect(out.indexOf("INSTRUCTIONS_MARKER")).toBeLessThan(out.indexOf("## Unavailable"));
    expect(out.indexOf("## Environment")).toBeLessThan(out.indexOf("## Unavailable"));
  });
});

describe("formatSkippedSection", () => {
  test("groups by kind in fixed order, sorts names within group", () => {
    const out = formatSkippedSection([
      { kind: "tool", name: "zeta", reason: "r1" },
      { kind: "channel", name: "telegram", reason: "r2" },
      { kind: "tool", name: "alpha", reason: "r3" },
      { kind: "drive", name: "notes", reason: "r4" },
    ]);
    // Section header order: channels → tools → drives → models
    const channelsIdx = out.indexOf("### channels");
    const toolsIdx = out.indexOf("### tools");
    const drivesIdx = out.indexOf("### drives");
    expect(channelsIdx).toBeGreaterThan(-1);
    expect(toolsIdx).toBeGreaterThan(channelsIdx);
    expect(drivesIdx).toBeGreaterThan(toolsIdx);
    // Names sorted within tools group
    expect(out.indexOf("**alpha**")).toBeLessThan(out.indexOf("**zeta**"));
  });

  test("omits empty groups", () => {
    const out = formatSkippedSection([{ kind: "tool", name: "x", reason: "r" }]);
    expect(out).toContain("### tools");
    expect(out).not.toContain("### channels");
    expect(out).not.toContain("### drives");
    expect(out).not.toContain("### models");
  });
});
