import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { estimateTokens, Session, type Thread } from "./channels.ts";

type StateStore = { session?: ModelMessage[] } | null;

/**
 * Minimal `Thread` stand-in — only the surface `Session` actually reaches
 * into (`id`, `state`, `setState`, `channel.state`, `channel.setState`).
 * Keeps thread-state and channel-state in separate records so scope behaviour
 * is visible in tests.
 */
function makeThread(): Thread {
  let threadState: StateStore = null;
  let channelState: StateStore = null;
  const thread = {
    id: "telegram:user-123",
    channel: {
      id: "telegram-channel:group-999",
      get state(): Promise<StateStore> {
        return Promise.resolve(channelState);
      },
      async setState(next: { session?: ModelMessage[] }): Promise<void> {
        channelState = { ...(channelState ?? {}), ...next };
      },
    },
    get state(): Promise<StateStore> {
      return Promise.resolve(threadState);
    },
    async setState(next: { session?: ModelMessage[] }): Promise<void> {
      threadState = { ...(threadState ?? {}), ...next };
    },
  };
  return thread as unknown as Thread;
}

function userMsg(text: string): ModelMessage {
  return { role: "user", content: text };
}

function assistantToolCall(id: string, toolName: string): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName, input: {} }],
  };
}

function assistantText(text: string): ModelMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResult(id: string, toolName: string, value: string): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value } }],
  };
}

describe("Session", () => {
  test("messages — empty when no state", async () => {
    const session = new Session(makeThread(), "thread");
    expect(await session.messages()).toEqual([]);
  });

  test("append — persists messages", async () => {
    const session = new Session(makeThread(), "thread");
    await session.append([userMsg("hi"), assistantText("hello")]);
    const msgs = await session.messages();
    expect(msgs.length).toBe(2);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");
  });

  test("append — no-op on empty array", async () => {
    const thread = makeThread();
    const session = new Session(thread, "thread");
    await session.append([]);
    expect(await thread.state).toBeNull();
  });

  test("append — tool-result stays raw on the turn it arrives", async () => {
    // Freshly-appended messages are NOT pruned — the agent already saw them
    // in-stream. Pruning only bites once they move into "existing" on the
    // next append.
    const session = new Session(makeThread(), "thread");
    const bigValue = "X".repeat(5_000);
    await session.append([
      userMsg("fetch"),
      assistantToolCall("t1", "web_fetch"),
      toolResult("t1", "web_fetch", bigValue),
    ]);
    const msgs = await session.messages();
    const firstToolOutput = (msgs[2] as { content: Array<{ output: { value: string } }> }).content[0]!.output;
    expect(firstToolOutput.value).toBe(bigValue);
  });

  test("append — tool-result from previous turn gets pruned on next append", async () => {
    const session = new Session(makeThread(), "thread");
    await session.append([
      userMsg("fetch"),
      assistantToolCall("t1", "web_fetch"),
      toolResult("t1", "web_fetch", "X".repeat(1_000)),
    ]);
    await session.append([userMsg("next")]);
    const msgs = await session.messages();
    const t1Output = (msgs[2] as { content: Array<{ output: { value: string } }> }).content[0]!.output;
    expect(t1Output.value).toMatch(/^\[pruned \d+ bytes]$/);
  });

  test("append — prune preserves toolCallId and toolName", async () => {
    const session = new Session(makeThread(), "thread");
    await session.append([toolResult("t1", "web_fetch", "X".repeat(1_000))]);
    await session.append([userMsg("next")]);
    const msgs = await session.messages();
    const part = (msgs[0] as { content: Array<{ toolCallId: string; toolName: string }> }).content[0]!;
    expect(part.toolCallId).toBe("t1");
    expect(part.toolName).toBe("web_fetch");
  });

  test("append — prune is idempotent (stub label stable across re-prunes)", async () => {
    const session = new Session(makeThread(), "thread");
    await session.append([toolResult("t1", "web_fetch", "X".repeat(1_000))]);
    await session.append([userMsg("p1")]);
    const firstStub = ((await session.messages())[0] as { content: Array<{ output: { value: string } }> }).content[0]!
      .output.value;

    await session.append([userMsg("p2")]);
    await session.append([userMsg("p3")]);
    const laterStub = ((await session.messages())[0] as { content: Array<{ output: { value: string } }> }).content[0]!
      .output.value;

    expect(laterStub).toBe(firstStub);
  });

  test("append — leaves user and assistant messages untouched", async () => {
    const session = new Session(makeThread(), "thread");
    await session.append([
      userMsg("hello"),
      assistantText("hi back"),
      assistantToolCall("t1", "web_fetch"),
      toolResult("t1", "web_fetch", "X".repeat(500)),
    ]);
    await session.append([userMsg("next")]);
    const msgs = await session.messages();
    expect(msgs[0]).toEqual(userMsg("hello"));
    expect(msgs[1]).toEqual(assistantText("hi back"));
    // Tool-call part on assistant message still has its input — we only prune tool-result outputs.
    const toolCallPart = (msgs[2] as { content: Array<{ type: string; input?: unknown }> }).content[0]!;
    expect(toolCallPart.type).toBe("tool-call");
    expect(toolCallPart.input).toEqual({});
  });

  test("append — `skill` tool outputs are NOT pruned (load-bearing instructions)", async () => {
    const session = new Session(makeThread(), "thread");
    const body = "# My skill\n\nLong instruction body the agent is following...";
    await session.append([toolResult("s1", "skill", body)]);
    await session.append([userMsg("next")]);
    const msgs = await session.messages();
    const out = (msgs[0] as { content: Array<{ output: { value: string } }> }).content[0]!.output.value;
    expect(out).toBe(body);
  });

  test("append — `delegate` tool outputs are NOT pruned (subagent report)", async () => {
    const session = new Session(makeThread(), "thread");
    const report = "<delegate_result agent='explore'>Found 3 matching files…</delegate_result>";
    await session.append([toolResult("d1", "delegate", report)]);
    await session.append([userMsg("next")]);
    const msgs = await session.messages();
    const out = (msgs[0] as { content: Array<{ output: { value: string } }> }).content[0]!.output.value;
    expect(out).toBe(report);
  });
});

describe("Session scope", () => {
  test("thread-scoped writes land on thread.state, not channel.state", async () => {
    const thread = makeThread();
    const session = new Session(thread, "thread");
    await session.append([userMsg("hi")]);
    expect((await thread.state)?.session?.length).toBe(1);
    expect((await thread.channel.state)?.session).toBeUndefined();
  });

  test("channel-scoped writes land on thread.channel.state, not thread.state", async () => {
    const thread = makeThread();
    const session = new Session(thread, "channel");
    await session.append([userMsg("hi")]);
    expect((await thread.channel.state)?.session?.length).toBe(1);
    expect((await thread.state)?.session).toBeUndefined();
  });

  test("scope default is thread", async () => {
    const thread = makeThread();
    // biome-ignore lint/suspicious/noExplicitAny: explicit-scope fallthrough covered by the constructor default
    const session = new Session(thread);
    await session.append([userMsg("hi")]);
    expect((await thread.state)?.session?.length).toBe(1);
  });
});

describe("Session.replace", () => {
  test("overwrites the full log atomically", async () => {
    const session = new Session(makeThread(), "thread");
    await session.append([userMsg("a"), userMsg("b"), userMsg("c")]);
    await session.replace([{ role: "system", content: "summary" }, userMsg("d")]);
    const msgs = await session.messages();
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toEqual({ role: "system", content: "summary" });
    expect(msgs[1]).toEqual(userMsg("d"));
  });

  test("replace with empty clears the session", async () => {
    const session = new Session(makeThread(), "thread");
    await session.append([userMsg("a")]);
    await session.replace([]);
    expect(await session.messages()).toEqual([]);
  });

  test("replace does not run tool-output pruning", async () => {
    // caller owns what survives — replace writes verbatim.
    const session = new Session(makeThread(), "thread");
    const bigTool = toolResult("t1", "web_fetch", "X".repeat(1_000));
    await session.replace([bigTool]);
    const out = ((await session.messages())[0] as { content: Array<{ output: { value: string } }> }).content[0]!.output
      .value;
    expect(out).toBe("X".repeat(1_000));
  });
});

describe("estimateTokens", () => {
  test("empty array → 0", () => {
    expect(estimateTokens([])).toBe(0);
  });

  test("scales with JSON size (rough bytes/4 heuristic)", () => {
    const small = estimateTokens([userMsg("hi")]);
    const large = estimateTokens([userMsg("X".repeat(1_000))]);
    expect(large).toBeGreaterThan(small);
    // 1000-char user message JSON ≈ 1040 bytes → ≈ 260 tokens. Loose bounds.
    expect(large).toBeGreaterThan(200);
    expect(large).toBeLessThan(400);
  });

  test("heuristic stays pure — no built-in safety margin", () => {
    // SAFETY_MARGIN lives at the comparison call site, not inside the
    // estimator (mnemonic/087). Guard against anyone baking it in here.
    const bytes = JSON.stringify(userMsg("hello world")).length;
    expect(estimateTokens([userMsg("hello world")])).toBe(Math.ceil(bytes / 4));
  });
});
