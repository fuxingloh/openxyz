import { Chat, toAiMessages } from "chat";
import type { Thread, Message } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { scanChannels, type ChannelEntry, type MessageContext, type ThreadState } from "./channels";
import { AgentFactory } from "./agents/factory";
import type { ModelMessage } from "ai";

export class OpenXyzHarness {
  readonly cwd: string;
  readonly agentFactory: AgentFactory;
  #chat?: Chat;
  #channels: Record<string, ChannelEntry> = {};

  constructor(opts: { cwd: string }) {
    this.cwd = opts.cwd;
    this.agentFactory = new AgentFactory(this.cwd);
  }

  async start(): Promise<void> {
    const [, channels] = await Promise.all([this.agentFactory.init(), scanChannels(this.cwd)]);
    this.#channels = channels;
    if (Object.keys(channels).length === 0) {
      throw new Error("[openxyz] no channels found under channels/*.ts — nothing to run");
    }

    // Validate: every channel references an agent that exists
    for (const [name, entry] of Object.entries(channels)) {
      if (!this.agentFactory.defs[entry.agent]) {
        throw new Error(`[openxyz] channel "${name}" references agent "${entry.agent}" but no such agent exists`);
      }
    }

    const chat = new Chat({
      adapters: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, v.adapter])) as Record<string, never>,
      state: createMemoryState(),
      userName: "openxyz",
      logger: "silent",
      fallbackStreamingPlaceholderText: null,
    });

    // fire-and-forget — awaiting here holds the chat-sdk thread lock and causes LockError on concurrent messages (working/004)
    chat.onDirectMessage((thread, message, channel) => {
      this.#reply({ thread, message, channel }).catch((err) => console.error("[openxyz] handler error", err));
    });

    chat.onSubscribedMessage((thread, message) => {
      this.#reply({ thread, message }).catch((err) => console.error("[openxyz] handler error", err));
    });

    // initialize() auto-starts polling for adapters in "auto" mode when no webhook is configured.
    await chat.initialize();
    this.#chat = chat;
  }

  async #reply(ctx: MessageContext): Promise<void> {
    const thread = ctx.thread;
    const cfg = this.#channels[thread.adapter.name];
    if (!cfg) {
      throw new Error(`[openxyz] no channel config found for adapter "${thread.adapter.name}"`);
    }

    if (cfg.shouldRespond && !(await cfg.shouldRespond(ctx))) return;
    // TODO: subscribe() is idempotent but called on every reply — redundant after first contact.
    await thread.subscribe();

    const agent = await this.agentFactory.create(cfg.agent);
    await thread.startTyping();

    const run = async () => {
      const state = (await thread.state) ?? {};
      const summary = state.summary;
      const recent: Message[] = [];
      // NOTE: strict `===` against the boundary message, not `<=`. Message IDs are
      //   platform-encoded strings (e.g. Telegram's `${chatId}:${messageId}`) that
      //   don't sort lexicographically — `"123:10" < "123:9"` — so ordering compares
      //   are wrong the moment message_id crosses a digit boundary (10, 100, 1000).
      //   Equality + a "passed boundary" flag is order-independent.
      let seenBoundary = false;
      for await (const msg of thread.messages) {
        recent.unshift(msg);
        if (recent.length >= 100) break;
        if (summary && msg.id === summary.upToMessageId) seenBoundary = true;
        // Keep pulling past the boundary until we have at least 4 messages — gives
        // the agent tail continuity right after a fresh compaction.
        if (seenBoundary && recent.length >= 4) break;
      }

      const messages: ModelMessage[] = [];
      if (summary?.text) {
        messages.push({
          role: "system",
          content: `<previous_conversation_summary>\n${summary.text}\n</previous_conversation_summary>`,
        });
      }
      messages.push(...(await toAiMessages(recent)));
      messages.push({
        role: "system",
        content: `Current date: ${new Date().toISOString().split("T")[0]}`,
      });
      const result = await agent.stream({ prompt: messages });
      await thread.post(result.fullStream);
    };

    try {
      await run();
    } catch (err) {
      if (!isContextOverflow(err)) throw err;
      // Reactive fallback: force-compact and retry once. A second overflow
      // bubbles to the handler's catch.
      console.warn("[openxyz] context overflow — forcing reactive compaction");
      await this.#compact(thread);
      await run();
    }
  }

  /**
   * Invoke the compaction agent on a thread's current history. Self-contained:
   * reads prior summary + recent messages from thread state/platform, merges with
   * the prior summary (so context isn't lost across compactions), writes the new
   * summary back. Posts a "Compacting..." placeholder, deleted on success so the
   * user sees progress even if the process dies mid-compaction.
   */
  async #compact(thread: Thread<ThreadState>) {
    const state = (await thread.state) ?? {};
    const prior = state.summary;
    const recent: Message[] = [];
    // Strict `===` against the boundary — see note in `run()` above on why
    // ordering compares are wrong for platform-encoded message IDs.
    for await (const msg of thread.messages) {
      if (prior && msg.id === prior.upToMessageId) break;
      recent.unshift(msg);
      if (recent.length >= 100) break;
    }
    const lastMessage = recent[recent.length - 1];
    if (!lastMessage) return;

    const placeholder = await thread.post("Compacting...");
    const compactor = await this.agentFactory.create("compact", { delegate: false });
    const prompt: ModelMessage[] = [];
    if (prior) {
      prompt.push({
        role: "system",
        content: `<previous_summary>\n${prior.text}\n</previous_summary>\n\nMerge the previous summary above with the new messages below into a single updated summary.`,
      });
    }
    prompt.push(...(await toAiMessages(recent)));

    const result = await compactor.generate({ prompt });
    const summary = { text: result.text, upToMessageId: lastMessage.id };
    await thread.setState({ summary });
    await placeholder.delete();
    return summary;
  }

  async stop(): Promise<void> {
    await this.#chat?.shutdown();
  }
}

/**
 * Provider error messages aren't typed — detect context-overflow by regex on
 * the error text. Matches OpenAI ("context_length_exceeded", "maximum context
 * length"), Anthropic ("prompt is too long"), and generic phrasings.
 */
function isContextOverflow(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /context[_ ]?(length|window)|token limit|prompt is too long|exceeds?.*context|too many tokens/.test(msg);
}
