import { describe, expect, test } from "bun:test";
import type { ModelMessage, SystemModelMessage } from "ai";
import type { Adapter as ChatSdkAdapter, Message as ChatSdkMessage } from "chat";
import { Channel, estimateTokens, Session, type Message, type ReplyAction, type Thread } from "./channels.ts";

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

function parallelToolResults(parts: Array<{ id: string; toolName: string; value: string }>): ModelMessage {
  return {
    role: "tool",
    content: parts.map(({ id, toolName, value }) => ({
      type: "tool-result",
      toolCallId: id,
      toolName,
      output: { type: "text", value },
    })),
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
    expect(t1Output.value).toMatch(/^\[pruned \d+ bytes\b/);
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

  test("append — parallel tool-results in one message each get pruned independently", async () => {
    // streamText fans out parallel tool calls via Promise.all; results land as
    // multiple tool-result parts on a single `tool` message. Prune must hit
    // each part independently.
    const session = new Session(makeThread(), "thread");
    await session.append([
      parallelToolResults([
        { id: "t1", toolName: "web_fetch", value: "A".repeat(1_000) },
        { id: "t2", toolName: "bash", value: "B".repeat(2_000) },
        { id: "t3", toolName: "read", value: "C".repeat(500) },
      ]),
    ]);
    await session.append([userMsg("next")]);
    const parts = (
      (await session.messages())[0] as { content: Array<{ toolCallId: string; output: { value: string } }> }
    ).content;
    expect(parts.length).toBe(3);
    for (const part of parts) expect(part.output.value).toMatch(/^\[pruned \d+ bytes\b/);
    expect(parts.map((p) => p.toolCallId)).toEqual(["t1", "t2", "t3"]);
  });

  test("append — mixed parallel batch: never-prune tools survive, rest get stubbed", async () => {
    const session = new Session(makeThread(), "thread");
    const skillBody = "# skill instructions body";
    const delegateReport = "<delegate_result>done</delegate_result>";
    await session.append([
      parallelToolResults([
        { id: "t1", toolName: "bash", value: "X".repeat(1_000) },
        { id: "t2", toolName: "skill", value: skillBody },
        { id: "t3", toolName: "web_fetch", value: "Y".repeat(1_000) },
        { id: "t4", toolName: "delegate", value: delegateReport },
      ]),
    ]);
    await session.append([userMsg("next")]);
    const parts = (
      (await session.messages())[0] as { content: Array<{ toolCallId: string; output: { value: string } }> }
    ).content;
    const byId = Object.fromEntries(parts.map((p) => [p.toolCallId, p.output.value]));
    expect(byId.t1).toMatch(/^\[pruned \d+ bytes\b/);
    expect(byId.t2).toBe(skillBody);
    expect(byId.t3).toMatch(/^\[pruned \d+ bytes\b/);
    expect(byId.t4).toBe(delegateReport);
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

// ───────────────────────────────────────────────────────────────────────────
// Channel.recentMessages — prior-context backfill (mnemonic/106)
// ───────────────────────────────────────────────────────────────────────────

class TestChannel extends Channel<unknown> {
  readonly adapter = {} as ChatSdkAdapter;
  // Per-author policy — `excluded` user ids return `context: false`.
  constructor(private readonly excluded: Set<string> = new Set()) {
    super();
  }
  async getSystemMessage(): Promise<SystemModelMessage> {
    return { role: "system", content: "" };
  }
  async toModelMessages(_thread: Thread, _messages: Message[]): Promise<ModelMessage[]> {
    return [];
  }
  async reply(_thread: Thread, message: Message): Promise<ReplyAction> {
    if (this.excluded.has(message.author.userId)) return { reply: false, context: false };
    return { reply: false };
  }
}

function chatMsg(opts: { id: string; isMe: boolean; dateSent?: number; text?: string }): Message {
  return {
    id: opts.id,
    raw: undefined,
    threadId: "t",
    metadata: { dateSent: new Date(opts.dateSent ?? 0), edited: false },
    author: { fullName: opts.isMe ? "bot" : "user", isBot: opts.isMe, isMe: opts.isMe, userId: opts.id, userName: "x" },
    content: opts.text ?? opts.id,
  } as unknown as Message;
}

function makeThreadWithRecent(recent: Message[]): Thread {
  let refreshes = 0;
  const thread = {
    id: "t",
    recentMessages: recent,
    refresh: async () => {
      refreshes++;
    },
    get _refreshes() {
      return refreshes;
    },
  };
  return thread as unknown as Thread;
}

describe("Channel.backfill", () => {
  test("returns empty when incoming is empty", async () => {
    const ch = new TestChannel();
    const thread = makeThreadWithRecent([chatMsg({ id: "m1", isMe: false })]);
    expect(await ch.recentMessages(thread, [])).toEqual([]);
  });

  test("returns empty when recent cache is empty (after one refresh)", async () => {
    const ch = new TestChannel();
    const thread = makeThreadWithRecent([]);
    const res = await ch.recentMessages(thread, [chatMsg({ id: "trigger", isMe: false })]);
    expect(res).toEqual([]);
    // refresh was attempted exactly once
    expect((thread as unknown as { _refreshes: number })._refreshes).toBe(1);
  });

  test("walks back to last bot message and stops there", async () => {
    // recent (chronological): bot1 — u1 — u2 — bot2 — u3 — u4 (incoming)
    const recent = [
      chatMsg({ id: "bot1", isMe: true, dateSent: 1 }),
      chatMsg({ id: "u1", isMe: false, dateSent: 2 }),
      chatMsg({ id: "u2", isMe: false, dateSent: 3 }),
      chatMsg({ id: "bot2", isMe: true, dateSent: 4 }),
      chatMsg({ id: "u3", isMe: false, dateSent: 5 }),
      chatMsg({ id: "u4", isMe: false, dateSent: 6 }),
    ];
    const incoming = [chatMsg({ id: "u4", isMe: false, dateSent: 6 })];
    const ch = new TestChannel();
    const res = await ch.recentMessages(makeThreadWithRecent(recent), incoming);
    expect(res.map((m) => m.id)).toEqual(["u3"]);
  });

  test("excludes burst messages even when present in recent cache", async () => {
    // u3 + u4 are the burst (incoming); recent already contains them.
    const recent = [
      chatMsg({ id: "u1", isMe: false, dateSent: 1 }),
      chatMsg({ id: "u2", isMe: false, dateSent: 2 }),
      chatMsg({ id: "u3", isMe: false, dateSent: 3 }),
      chatMsg({ id: "u4", isMe: false, dateSent: 4 }),
    ];
    const incoming = [chatMsg({ id: "u3", isMe: false }), chatMsg({ id: "u4", isMe: false })];
    const ch = new TestChannel();
    const res = await ch.recentMessages(makeThreadWithRecent(recent), incoming);
    expect(res.map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  test("caps at BACKFILL_CAP (10) when no bot message found", async () => {
    const recent = Array.from({ length: 50 }, (_, i) => chatMsg({ id: `u${i}`, isMe: false, dateSent: i }));
    const incoming = [chatMsg({ id: "u49", isMe: false, dateSent: 49 })];
    const ch = new TestChannel();
    const res = await ch.recentMessages(makeThreadWithRecent(recent), incoming);
    expect(res.length).toBe(10);
    // Newest 10 (excluding the trigger u49): u39..u48
    expect(res[0]?.id).toBe("u39");
    expect(res[res.length - 1]?.id).toBe("u48");
  });

  test("returns chronological order (oldest first)", async () => {
    const recent = [
      chatMsg({ id: "u1", isMe: false, dateSent: 1 }),
      chatMsg({ id: "u2", isMe: false, dateSent: 2 }),
      chatMsg({ id: "u3", isMe: false, dateSent: 3 }),
      chatMsg({ id: "trigger", isMe: false, dateSent: 4 }),
    ];
    const ch = new TestChannel();
    const res = await ch.recentMessages(makeThreadWithRecent(recent), [chatMsg({ id: "trigger", isMe: false })]);
    expect(res.map((m) => m.id)).toEqual(["u1", "u2", "u3"]);
  });

  test("returns empty when bot is the only message before the burst", async () => {
    const recent = [
      chatMsg({ id: "bot1", isMe: true, dateSent: 1 }),
      chatMsg({ id: "trigger", isMe: false, dateSent: 2 }),
    ];
    const ch = new TestChannel();
    const res = await ch.recentMessages(makeThreadWithRecent(recent), [chatMsg({ id: "trigger", isMe: false })]);
    expect(res).toEqual([]);
  });

  test("excludes candidates whose reply() returned context: false (allowlist gating)", async () => {
    const recent = [
      chatMsg({ id: "u1", isMe: false, dateSent: 1 }),
      chatMsg({ id: "guest", isMe: false, dateSent: 2 }),
      chatMsg({ id: "u3", isMe: false, dateSent: 3 }),
      chatMsg({ id: "trigger", isMe: false, dateSent: 4 }),
    ];
    const ch = new TestChannel(new Set(["guest"]));
    const res = await ch.recentMessages(makeThreadWithRecent(recent), [chatMsg({ id: "trigger", isMe: false })]);
    expect(res.map((m) => m.id)).toEqual(["u1", "u3"]);
  });

  test("fail-open if refresh throws — returns empty without throwing", async () => {
    const thread = {
      id: "t",
      recentMessages: [] as ChatSdkMessage[],
      refresh: async () => {
        throw new Error("boom");
      },
    } as unknown as Thread;
    const ch = new TestChannel();
    expect(await ch.recentMessages(thread, [chatMsg({ id: "trigger", isMe: false })])).toEqual([]);
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
