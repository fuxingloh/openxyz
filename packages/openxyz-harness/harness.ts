import { Chat, toAiMessages } from "chat";
import type { Thread, Message } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { scanChannels, Should, type ChannelEntry, type MessageContext } from "./channels";
import { AgentFactory } from "./agents/factory";

// Compaction threshold: ~100K tokens. Char count / 4 is a rough token proxy.
//  When recent history exceeds this, we compact older messages into a summary.
const COMPACT_THRESHOLD_CHARS = 400_000;
// Number of recent messages to preserve as-is when compacting.
const COMPACT_TAIL_SIZE = 4;

interface Summary {
  summary: string;
  upToMessageId: string;
}

interface ThreadState {
  summary?: Summary;
}

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

    chat.onSubscribedMessage((thread, message, channel) => {
      this.#reply({ thread, message }).catch((err) => console.error("[openxyz] handler error", err));
    });

    // initialize() auto-starts polling for adapters in "auto" mode when no webhook is configured.
    await chat.initialize();
    this.#chat = chat;
  }

  async #reply(ctx: MessageContext): Promise<void> {
    const { thread } = ctx;
    const [id] = thread.id.split(":") as [string];
    const cfg = this.#channels[id];
    if (!cfg) return;

    const decision = cfg.should ? await cfg.should(ctx) : Should.respond;
    if (decision === Should.skip) return;
    // TODO: subscribe() is idempotent but called on every reply — redundant after first contact.
    await thread.subscribe();
    if (decision === Should.listen) return;

    const agent = await this.agentFactory.create(cfg.agent);

    await thread.startTyping();
    const fetched = await thread.adapter.fetchMessages(thread.id, { limit: 100 });

    // Drop messages already folded into the summary
    const state = ((await thread.state) ?? {}) as ThreadState;
    const entry = state.summary;
    let recent = entry ? fetched.messages.filter((m) => m.id > entry.upToMessageId) : fetched.messages;

    // Check if we need to compact before the agent call
    let summary = entry;
    if (this.#estimateChars(recent) > COMPACT_THRESHOLD_CHARS) {
      summary = await this.#compact(thread, recent, entry);
      recent = recent.slice(-COMPACT_TAIL_SIZE);
    }

    const history = await toAiMessages(recent);
    const env = {
      role: "system" as const,
      content: `Current date: ${new Date().toISOString().split("T")[0]}`,
    };
    const summaryMsg = summary
      ? {
          role: "system" as const,
          content: `<previous_conversation_summary>\n${summary.summary}\n</previous_conversation_summary>`,
        }
      : null;

    const prompt = summaryMsg ? [env, summaryMsg, ...history] : [env, ...history];
    const result = await agent.stream({ prompt });
    await thread.post(result.fullStream);
  }

  /**
   * Invoke the compaction agent to summarize older messages, keeping the last few
   * as tail. Merges with any prior summary so context isn't lost across compactions.
   */
  async #compact(thread: Thread, recent: Message[], prior?: Summary): Promise<Summary> {
    const toCompact = recent.slice(0, -COMPACT_TAIL_SIZE);
    if (toCompact.length === 0 || !toCompact[toCompact.length - 1])
      return (
        prior ?? {
          summary: "",
          upToMessageId: "",
        }
      );

    // User-visible progress marker — edited to "Compacted" on success so the user
    // sees progress even if the process dies mid-compaction.
    const placeholder = await thread.post("Compacting...");

    const compactor = await this.agentFactory.create("compact", { delegate: false });
    const history = await toAiMessages(toCompact);
    const prompt = prior
      ? [
          {
            role: "system" as const,
            content: `<previous_summary>\n${prior.summary}\n</previous_summary>\n\nMerge the previous summary above with the new messages below into a single updated summary.`,
          },
          ...history,
        ]
      : history;

    const result = await compactor.generate({ prompt });
    const summary: Summary = {
      summary: result.text,
      upToMessageId: toCompact[toCompact.length - 1]!.id,
    };
    await thread.setState({ summary } satisfies ThreadState);
    await placeholder.edit("Compacted");
    return summary;
  }

  /** Rough token estimate: ~4 chars per token. */
  #estimateChars(messages: Message[]): number {
    return messages.reduce((n, m) => n + m.text.length, 0);
  }

  async stop(): Promise<void> {
    await this.#chat?.shutdown();
  }
}
