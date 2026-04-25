import type { ModelMessage, SystemModelMessage } from "ai";
import type { Thread as ChatSdkThread, Message as ChatSdkMessage, Adapter as ChatSdkAdapter } from "chat";

export type Thread = ChatSdkThread<{
  /** Full agent-loop log — the session ledger (mnemonic/081). */
  session?: ModelMessage[];
}>;

export type Message<Raw = unknown> = ChatSdkMessage<Raw>;

export type ReplyAction = {
  /** What agent to route to for this reply. Undefined = do nothing. */
  agent?: string;
  /** Whether to start the "typing indicator". */
  typing?: string | boolean;
  /** Whether to add a reaction to the user's message. */
  reaction?: string;
};

/**
 * Abstract base class for channel adapters. Concrete adapters shipped by
 * `openxyz` (e.g. `TelegramChannel`) extend this; template channel files
 * typically subclass the concrete adapter and `export default new Foo(...)`.
 *
 * `this.adapter` is the chat-sdk `Adapter` — composed, not inherited. It owns
 * platform plumbing (webhooks, polling, raw-message parsing). The methods on
 * this class are the runtime-level hooks templates override.
 */
export abstract class Channel<Raw = unknown> {
  abstract readonly adapter: ChatSdkAdapter;

  /**
   * Per-turn system message prepended to the session log before the agent
   * runs. Use for values that change per-request (thread name, DM vs group,
   * platform identity). Return an empty `content` string to prepend nothing.
   * Stable content (agent persona, skills index) lives on the agent's
   * `instructions`, not here — the runtime re-calls `system()` every turn.
   */
  abstract getSystemMessage(thread: Thread): Promise<SystemModelMessage>;

  /**
   * Convert an incoming platform message into a single `ModelMessage` the
   * runtime appends to the session before each agent turn. History is not
   * the channel's concern — that lives in the session (mnemonic/081 — two-
   * ledger split).
   *
   * Abstract on purpose. Each platform carries different metadata worth
   * surfacing to the agent (Telegram reply/forward XML, Slack thread refs,
   * Discord replies-as-embeds, terminal file attachments, …) — a shared
   * default would lie about at least one of them. Concrete adapters call
   * chat-sdk's `toAiMessages([message], { transformMessage })` with the
   * annotation their platform needs.
   */
  abstract toModelMessage(thread: Thread, message: Message<Raw>): Promise<ModelMessage>;

  /**
   * Decide what to do with an incoming message. Return `{}` to stay silent;
   * `{ agent, typing, reaction }` to dispatch to an agent. Templates that
   * want partial overrides can `return super.reply(thread, message)` after
   * their own allowlist/gate checks pass.
   */
  abstract reply(thread: Thread, message: Message<Raw>): Promise<ReplyAction>;

  /**
   * Optional message-level predicate. Concrete adapters' `context()` should
   * drop messages where this returns `false`. Adapter-agnostic shape —
   * templates override it to scope context (e.g. PKBM-in-a-group filtering).
   */
  filter?(message: Message<Raw>, thread: Thread): boolean;

  /**
   * Return the `Session` the agent should read/write for this incoming
   * message. Default is thread-scoped — one session per chat-sdk thread.
   * Adapters that want channel-scoped sessions (supergroup forum topics
   * sharing one assistant memory, etc.) override this and return
   * `new Session(thread, "channel")`. See mnemonic/081.
   */
  async getSession(thread: Thread): Promise<Session> {
    return new Session(thread, "thread");
  }

  /**
   * Reorder a debounce-window burst into the user's send order. Webhook
   * arrival at the state-adapter `enqueue` reflects whichever request hit
   * the database first — a network race, not what the user typed when.
   *
   * Default sorts by `metadata.dateSent` ascending, which is correct for
   * platforms with sub-second send timestamps (Slack `ts`, Discord
   * snowflakes via `dateSent`). Platforms with coarser timestamps
   * (Telegram is 1s-resolution) should override and add a tiebreaker —
   * usually a monotonic per-chat message id.
   *
   * Returns a new array; never mutates the input.
   */
  sortMessages(messages: Message<Raw>[]): Message<Raw>[] {
    return [...messages].sort((a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime());
  }
}

export type MessageFilter<Raw = unknown> = (message: Message<Raw>, thread: Thread) => boolean;

export type ReplyFunc<Raw = unknown> = (
  thread: Thread,
  message: Message<Raw>,
) => boolean | Promise<boolean> | ReplyAction | Promise<ReplyAction>;

/**
 * Whether a session is keyed to the chat-sdk thread (one session per
 * reply-thread / forum-topic) or to the channel (one session for the whole
 * room, shared across every thread inside it). See mnemonic/081.
 */
export type SessionScope = "thread" | "channel";

/**
 * Session = the agent's view of the conversation (full `ModelMessage[]`
 * including tool calls, tool results, and reasoning blocks). Distinct from
 * the chat-sdk thread, which only stores what got rendered to the user.
 *
 * Persistence piggy-backs on chat-sdk's `thread.state` / `channel.state` —
 * whichever adapter the user picked (memory, Redis, PGlite, Postgres)
 * stores the session log alongside thread/channel metadata. No parallel
 * store, no parallel TTL.
 *
 * Scope is picked by `Channel.getSession()` — defaults to `"thread"`.
 * Cross-channel identity stitching (same user across Telegram + terminal)
 * is a later problem.
 */
export class Session {
  constructor(
    private readonly thread: Thread,
    private readonly scope: SessionScope = "thread",
  ) {}

  private get postable() {
    return this.scope === "thread" ? this.thread : this.thread.channel;
  }

  async messages(): Promise<ModelMessage[]> {
    const state = await this.postable.state;
    return state?.session ?? [];
  }

  async append(messages: ModelMessage[]): Promise<void> {
    if (messages.length === 0) return;
    // Prune the existing log on write; freshly-appended messages stay intact
    // for one turn (agent saw them in-stream anyway). Next append moves them
    // into `existing` and they get pruned before the following turn reads.
    // Deciding what to keep vs summarize is compaction's problem — see
    // mnemonic/083 for the framing.
    const existing = pruneToolOutputs(await this.messages());
    await this.postable.setState({ session: [...existing, ...messages] });
  }

  /**
   * Overwrite the full session log atomically. Used by compaction
   * (mnemonic/084) — replaces N old messages with `[summary, ...recent]`.
   * No pruning pass: the caller picked what survives.
   */
  async replace(messages: ModelMessage[]): Promise<void> {
    await this.postable.setState({ session: messages });
  }
}

/**
 * Rough token estimate from JSON-serialized size. Industry rule of thumb is
 * ~4 bytes/token for English-heavy LLM content; good enough for threshold
 * decisions (compaction trigger, prune budget). Not accurate enough for hard
 * context-window budgeting — swap in a real tokenizer if we ever need that.
 *
 * See mnemonic/084 — TODO to extend `Model` with `contextLimit` so
 * per-model budgets replace the universal 40K.
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let bytes = 0;
  for (const msg of messages) bytes += JSON.stringify(msg).length;
  return Math.ceil(bytes / 4);
}

/**
 * Tools whose outputs are load-bearing context the agent needs verbatim
 * across turns. `skill` — output is the skill's instructions the agent is
 * mid-following. `delegate` — output is the subagent's final report, small
 * but high-signal, pruning loses the "why" of the delegate call.
 *
 * Everything else prunes by default. MCP tools + user-defined tools can
 * migrate to a per-tool opt-out later if this list grows unwieldy.
 */
const NEVER_PRUNE_TOOLS = new Set(["skill", "delegate"]);

/**
 * Replace every `tool-result` output with a byte-count stub. `toolCallId` +
 * `toolName` stay on the parent part so the LLM still sees the shape of the
 * loop. Idempotent: already-pruned stubs keep their original size label.
 * `NEVER_PRUNE_TOOLS` skips the carve-outs verbatim.
 */
function pruneToolOutputs(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (part.type !== "tool-result") return part;
        if (NEVER_PRUNE_TOOLS.has(part.toolName)) return part;
        if (isPrunedStub(part.output)) return part;
        const size = JSON.stringify(part.output).length;
        return {
          ...part,
          output: { type: "text" as const, value: `[pruned ${size} bytes — re-run the tool if you need this output]` },
        };
      }),
    } as ModelMessage;
  });
}

function isPrunedStub(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { type?: unknown }).type === "text" &&
    typeof (output as { value?: unknown }).value === "string" &&
    /^\[pruned \d+ bytes\b/.test((output as { value: string }).value)
  );
}
