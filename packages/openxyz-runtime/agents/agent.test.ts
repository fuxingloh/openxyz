import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Agent, hardTruncate, safeBoundary } from "./agent.ts";
import type { AgentFactory } from "./factory.ts";
import type { Model } from "../model.ts";

function modelOf(raw: MockLanguageModelV3, systemPrompt = ""): Model {
  return { raw, systemPrompt, limit: { context: 200_000 } };
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

  test("can return empty when even the newest message exceeds budget", () => {
    // Pair-safe snap can push past end if the tail is all tool messages.
    const msgs = [userMsg("big"), assistantToolCall("t1", "bash"), toolResult("t1", "bash", "x")];
    const out = hardTruncate(msgs, 1); // impossibly tight
    // Acceptable either to return empty or a minimal safe suffix.
    // Invariant: no orphan tool at the front.
    expect(out[0]?.role).not.toBe("tool");
  });

  test("budget of 0 still respects pair safety", () => {
    const msgs = [userMsg("a"), assistantToolCall("t1", "bash"), toolResult("t1", "bash", "x")];
    const out = hardTruncate(msgs, 0);
    expect(out[0]?.role).not.toBe("tool");
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
      name: "test",
      factory: stubFactory(),
      model: modelOf(model, "you are a test"),
      tools: {},
      skills: [],
      filesystem: "read-write",
      instructions: "",
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
      name: "compact",
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
      filesystem: "read-only",
      instructions: "",
    });
    const result = await agent.generate({ prompt: "summarize" });
    expect(result.text).toBe("done");
  });
});
