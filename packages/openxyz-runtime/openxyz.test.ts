import { describe, expect, mock, test } from "bun:test";
import type { ModelMessage, SystemModelMessage } from "ai";
import type { Adapter as ChatSdkAdapter, Message as ChatSdkMessage } from "chat";
import { Channel, type Message, type ReplyAction, type Thread } from "./channels.ts";
import { formatLoadError, OpenXyz } from "./openxyz.ts";

class FakeChannel extends Channel {
  readonly adapter: ChatSdkAdapter = {
    name: "fake",
    addReaction: async () => {},
  } as unknown as ChatSdkAdapter;
  override reply = mock(async (_thread: Thread, _message: Message): Promise<ReplyAction> => ({ reply: false }));

  async getSystemMessage(_thread: Thread): Promise<SystemModelMessage> {
    return { role: "system", content: "" };
  }

  async toModelMessages(_thread: Thread, messages: Message[]): Promise<ModelMessage[]> {
    return messages.map((m) => ({ role: "user", content: m.text }));
  }
}

function makeThread(): Thread {
  let state: { lastDispatchedMessageId?: string } | null = null;
  return {
    id: "fake:-1003901611420:274",
    adapter: {
      name: "fake",
      addReaction: async () => {},
    },
    recentMessages: [],
    refresh: async () => {},
    subscribe: mock(async () => {}),
    startTyping: mock(async () => {}),
    get state(): Promise<{ lastDispatchedMessageId?: string } | null> {
      return Promise.resolve(state);
    },
    setState: mock(async (next: { lastDispatchedMessageId?: string }) => {
      state = { ...(state ?? {}), ...next };
    }),
  } as unknown as Thread;
}

function makeMessage(text: string, id = "-1003901611420:275", dateSent = new Date()): ChatSdkMessage {
  return {
    id,
    text,
    author: { userId: "u1", userName: "alice", isBot: false, isMe: false },
    metadata: { dateSent },
  } as unknown as ChatSdkMessage;
}

function makeOpenXyz(channel: Channel): OpenXyz & { dispatch: ReturnType<typeof mock> } {
  const openxyz = new OpenXyz({
    cwd: "/tmp/test",
    channels: { fake: channel },
    tools: {},
    agents: {},
    models: {},
    drives: {},
    skills: [],
  });
  // Stub the agent dispatch — we assert *whether* it fires, not what it does.
  openxyz.dispatch = mock(async () => {});
  return openxyz as OpenXyz & { dispatch: ReturnType<typeof mock> };
}

describe("OpenXyz.onMessage", () => {
  // OXYZ-91 end-to-end: an empty-text update (Telegram media-only) reaches
  // onMessage and runs the same flow as any other message — subscribes the
  // thread, runs `channel.reply()` for the routing decision, and exits cleanly
  // on `reply: false` without firing an agent turn.
  test("empty-text message reaches reply policy and skips dispatch on reply:false", async () => {
    const channel = new FakeChannel();
    const openxyz = makeOpenXyz(channel);
    const thread = makeThread();
    const message = makeMessage("");

    await openxyz.onMessage(thread, message);

    expect(thread.subscribe).toHaveBeenCalledTimes(1);
    expect(channel.reply).toHaveBeenCalledTimes(1);
    expect(channel.reply.mock.calls[0]?.[1]).toBe(message);
    expect(openxyz.dispatch).not.toHaveBeenCalled();
  });

  test("reply:true on empty-text fires dispatch with the burst", async () => {
    const channel = new FakeChannel();
    channel.reply = mock(async () => ({ reply: true }));
    const openxyz = makeOpenXyz(channel);
    const thread = makeThread();
    const message = makeMessage("");

    await openxyz.onMessage(thread, message);

    expect(openxyz.dispatch).toHaveBeenCalledTimes(1);
    const dispatchArg = openxyz.dispatch.mock.calls[0]?.[0] as { messages: ModelMessage[] };
    expect(dispatchArg.messages).toHaveLength(1);
  });

  test("dispatch success advances thread.state.lastDispatchedMessageId to newest in burst (mnemonic/106)", async () => {
    // OXYZ-91 marker write: after a successful dispatch, the high-water mark
    // moves to the newest message id we processed. The next turn's
    // recentMessages walk uses this as the boundary instead of bot-stop.
    const channel = new FakeChannel();
    channel.reply = mock(async () => ({ reply: true }));
    const openxyz = makeOpenXyz(channel);
    const thread = makeThread();
    const skipped = makeMessage("first", "-1003901611420:274", new Date(1000));
    const trigger = makeMessage("second", "-1003901611420:275", new Date(2000));

    await openxyz.onMessage(thread, trigger, { skipped: [skipped], totalSinceLastHandler: 2 });

    expect((thread.setState as ReturnType<typeof mock>).mock.calls).toContainEqual([
      { lastDispatchedMessageId: "-1003901611420:275" },
    ]);
    expect((await thread.state)?.lastDispatchedMessageId).toBe("-1003901611420:275");
  });

  test("no-reply burst does not advance lastDispatchedMessageId", async () => {
    // Marker only advances on actual dispatch — keeps reply:false messages
    // available for backfill on the next triggered turn.
    const channel = new FakeChannel(); // default reply: false
    const openxyz = makeOpenXyz(channel);
    const thread = makeThread();

    await openxyz.onMessage(thread, makeMessage("hi"));

    expect(openxyz.dispatch).not.toHaveBeenCalled();
    expect(thread.setState as ReturnType<typeof mock>).not.toHaveBeenCalled();
    expect(await thread.state).toBeNull();
  });

  test("burst with empty trigger still routes every message through reply()", async () => {
    const channel = new FakeChannel();
    const openxyz = makeOpenXyz(channel);
    const thread = makeThread();
    const skipped = makeMessage("hello there", "-1003901611420:274", new Date(1000));
    const trigger = makeMessage("", "-1003901611420:275", new Date(2000));

    await openxyz.onMessage(thread, trigger, { skipped: [skipped], totalSinceLastHandler: 2 });

    expect(channel.reply).toHaveBeenCalledTimes(2);
    const replied = channel.reply.mock.calls.map((c) => c[1]);
    expect(replied).toContain(trigger);
    expect(replied).toContain(skipped);
  });
});

describe("formatLoadError", () => {
  test("includes class name and message for typed errors", () => {
    class EnvNotFoundError extends Error {
      override readonly name = "EnvNotFoundError";
    }
    const out = formatLoadError(new EnvNotFoundError("env BRAIN_GH_TOKEN is not set: GitHub token"));
    expect(out).toBe("EnvNotFoundError: env BRAIN_GH_TOKEN is not set: GitHub token");
  });

  test("omits class name when generic Error", () => {
    expect(formatLoadError(new Error("boom"))).toBe("boom");
  });

  test("appends a single level of cause when chained", () => {
    class WrapperError extends Error {
      override readonly name = "WrapperError";
    }
    class InnerError extends Error {
      override readonly name = "InnerError";
    }
    const wrapped = new WrapperError("failed to construct GitHubDrive", {
      cause: new InnerError("HTTP 401 from api.github.com"),
    });
    const out = formatLoadError(wrapped);
    expect(out).toBe("WrapperError: failed to construct GitHubDrive (cause: InnerError: HTTP 401 from api.github.com)");
  });

  test("renders non-Error throws via String coercion", () => {
    expect(formatLoadError("string error")).toBe("string error");
    expect(formatLoadError(42)).toBe("42");
    expect(formatLoadError({ toString: () => "obj" })).toBe("obj");
  });

  test("clamps absurdly long messages so the system prompt stays bounded", () => {
    const long = "x".repeat(2000);
    const out = formatLoadError(new Error(long));
    expect(out.length).toBeLessThanOrEqual(800);
    expect(out.endsWith("…")).toBe(true);
  });
});
