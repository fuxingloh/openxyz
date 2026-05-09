import type { ModelMessage, SystemModelMessage } from "ai";
import type { Thread as ChatSdkThread, Message as ChatSdkMessage, Adapter as ChatSdkAdapter } from "chat";

export type Thread = ChatSdkThread<{
  /** Full agent-loop log — the session ledger (mnemonic/081). */
  session?: ModelMessage[];
  /**
   * Newest message id the agent saw in the last successful dispatch on this
   * thread (the high-water mark of `incoming`, post-sort). `recentMessages`
   * walks back to — but excludes — this id when assembling prior context, so
   * any `reply: false` user message that arrived between the bot's last reply
   * and the next trigger gets backfilled. Without this marker the walk stops
   * at the bot's most recent message and silently drops anything newer than
   * the bot's reply but older than the trigger (mnemonic/106 — OXYZ-91).
   */
  lastDispatchedMessageId?: string;
}>;

export type Message<Raw = unknown> = ChatSdkMessage<Raw>;

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
   * Which agent (by name) handles turns on this channel. Channel-wide,
   * not per-message — bursts collapse into one agent invocation, so a
   * per-message agent decision would just create cross-agent leakage in
   * mixed-author windows. Templates that need different agents for
   * different audiences should mount a separate channel (or subclass and
   * override this property in the constructor).
   */
  agent: string = "auto";

  /**
   * Per-turn system message prepended to the session log before the agent
   * runs. Use for values that change per-request (thread name, DM vs group,
   * platform identity). Return an empty `content` string to prepend nothing.
   * Stable content (agent persona, skills index) lives on the agent's
   * `instructions`, not here — the runtime re-calls `system()` every turn.
   */
  abstract getSystemMessage(thread: Thread): Promise<SystemModelMessage>;

  /**
   * Convert a burst of incoming platform messages into the `ModelMessage`s
   * the runtime appends to the session before each agent turn. History is
   * not the channel's concern — that lives in the session (mnemonic/081 —
   * two-ledger split).
   *
   * Abstract on purpose. Each platform carries different metadata worth
   * surfacing to the agent (Telegram reply/forward XML, Slack thread refs,
   * Discord replies-as-embeds, terminal file attachments, …) — a shared
   * default would lie about at least one of them. Concrete adapters call
   * chat-sdk's `toAiMessages(messages, { transformMessage })` with the
   * annotation their platform needs. Returning N messages keeps each
   * platform message addressable; the runtime forwards the array to the
   * LLM in arrival order.
   *
   * **chat-sdk gotchas every adapter must work around (mnemonic/143).**
   * `toAiMessages` is the only conversion seam between chat-sdk's `Message`
   * and the AI SDK's `ModelMessage`, so anything chat-sdk drops/mishandles
   * has to be patched here — once the burst is converted and stored in the
   * session, downstream reads inherit the shape. Known gaps in chat-sdk
   * 4.27.0 (file `OXYZ-*` issues to track upstream fixes):
   *
   * - **Empty-text-with-attachment dropped** (OXYZ-85): the filter at
   *   `chat/src/ai.ts:185` is `msg.text.trim()` — messages with an
   *   attachment but no caption get filtered out entirely. If the filtered
   *   message was the only one in the burst, `session.append([])` is a
   *   no-op, the prompt ends with the previous assistant turn, and most
   *   providers (Bedrock Sonnet 4.6 in particular) reject with a "no
   *   prefill" error. **Workaround:** before calling `toAiMessages`,
   *   inject placeholder text on any message with empty `text` but
   *   non-text payload (attachments, location, venue).
   * - **Photo `mimeType` mis-default** (OXYZ-86 — Telegram-specific but
   *   any adapter that builds `Attachment` without `mimeType` hits this):
   *   `attachmentToPart` falls back to `image/png` (`ai.ts:107`), but
   *   most platforms deliver photos as JPEG. Anthropic on Bedrock
   *   detects the format mismatch from magic bytes and 400s. **Workaround:**
   *   stamp the correct `mimeType` on every image attachment before
   *   conversion. If your platform's photo path always returns JPEG,
   *   hardcode `image/jpeg`; otherwise sniff from bytes or platform
   *   metadata.
   * - **Image-as-document silently dropped** (OXYZ-87): `attachmentToPart`
   *   at `ai.ts:122` only handles `att.type === "file"` if mimeType
   *   matches `isTextMimeType`. JPEG/PNG file-type attachments return
   *   `null`. **Workaround:** reclassify any `att.type === "file"` whose
   *   `mimeType` starts with `image/` as `att.type === "image"` before
   *   calling `toAiMessages` — that routes it through the working image
   *   branch.
   *
   * See `packages/openxyz-provider-telegram/channel.ts` for a reference
   * implementation of all three workarounds. Grep `mnemonic/143` to find
   * every workaround block once the upstream tickets land — they're meant
   * to be ripped out, not maintained.
   */
  abstract toModelMessages(thread: Thread, messages: Message<Raw>[]): Promise<ModelMessage[]>;

  /**
   * Decide whether to engage with this incoming message. `false` keeps the
   * channel silent; `true` adds the message to the burst the channel's
   * `agent` will process. Templates with allowlists / gate checks override
   * this and call `super.reply(thread, message)` once their checks pass.
   *
   * Reactions are auto-managed by the runtime — when this returns `true`
   * and the thread is non-DM, an `👀` ack is fired before the LLM turn
   * starts (see `OpenXyz.onMessage`). DMs never auto-react.
   */
  abstract reply(thread: Thread, message: Message<Raw>): Promise<boolean>;

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
   * Render the agent's `fullStream` for this channel. Default passes the
   * whole stream straight to chat-sdk — `thread.post(fullStream)` extracts
   * text-deltas with built-in throttling and emits one bubble per turn.
   *
   * Adapters override when the platform needs the stream pre-processed.
   * Telegram (`@openxyz-provider/telegram`) splits on `finish-step` for
   * one bubble per LLM step (mnemonic/104), buffers each substream,
   * extracts mdast `Table` nodes and renders them as inline PNGs
   * (mnemonic/115), and re-fires typing between bubbles (mnemonic/100).
   * That all stays out of the runtime — bubble shape is an adapter
   * concern, not a runtime one.
   *
   * `fullStream` is the AI SDK `streamText` event stream — `text-delta`,
   * `tool-input-start`, `tool-call`, `tool-result`, `finish-step`,
   * `finish`. Adapters consume what they need and ignore the rest.
   */
  async postFullStream(thread: Thread, fullStream: AsyncIterable<unknown>): Promise<void> {
    await thread.post(fullStream as AsyncIterable<string>);
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

  /**
   * Prior context the agent should see alongside the current burst
   * (mnemonic/106). Returns recent messages that arrived in this thread but
   * never made it into a triggered turn — typical case: user types "the
   * deploy is failing" + "see logs" + "@bot fix that"; only the @-mention
   * fires a tier handler, the first two never get appended to the session,
   * agent sees "fix that" with no antecedent.
   *
   * Default: walk `thread.recentMessages` newest → oldest, skip ids already
   * in `incoming` (the current burst — already in the prompt path). Boundary
   * is `thread.state.lastDispatchedMessageId` when set — the high-water mark
   * of the previous successful dispatch; everything older is in the session
   * already. Bot messages along the way are skipped (already in session) but
   * don't terminate the walk — that's the OXYZ-91 fix: a `reply: false` user
   * message arriving between the bot's last reply and the next trigger sat
   * newer than the bot reply but older than the trigger, and the legacy
   * bot-stop walked right past it.
   *
   * Cold-start (no marker yet) falls back to the legacy bot-stop so existing
   * threads behave as before until a triggered turn writes the marker.
   *
   * Hard cap at `RECENT_MESSAGES_CAP`. Refreshes once if the cache is empty
   * (cold start). Returns chronological order. No per-candidate policy
   * filtering — every recent message in scope is included so the agent
   * sees the conversation as it actually happened. Override to tighten (DM
   * no-op, same-author only) or widen; return `[]` to opt out entirely.
   */
  async recentMessages(thread: Thread, incoming: Message<Raw>[]): Promise<Message<Raw>[]> {
    if (incoming.length === 0) return [];

    let recent = thread.recentMessages as Message<Raw>[];
    if (recent.length === 0) {
      await thread.refresh().catch((err) => console.warn("[openxyz] thread.refresh failed during recentMessages", err));
      recent = thread.recentMessages as Message<Raw>[];
    }
    if (recent.length === 0) return [];

    const state = await thread.state.catch((err) => {
      console.warn("[openxyz] recentMessages: thread.state read failed", err);
      return null;
    });
    const marker = state?.lastDispatchedMessageId;

    const incomingIds = new Set(incoming.map((m) => m.id));
    const candidates: Message<Raw>[] = [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i]!;
      if (incomingIds.has(m.id)) continue;
      if (marker !== undefined) {
        // Marker mode (post-OXYZ-91): boundary is the previous dispatch's
        // high-water mark. Bot messages are already in the session log, so
        // skip them but keep walking — the user message we're hunting for
        // may be older than the bot reply but newer than the marker.
        if (m.id === marker) break;
        if (m.author.isMe) continue;
      } else {
        // Cold-start fallback (no marker yet): legacy bot-stop. Preserves
        // pre-OXYZ-91 behavior for the first dispatch on existing threads;
        // marker is set after this turn so subsequent walks are correct.
        if (m.author.isMe) break;
      }
      candidates.push(m);
      if (candidates.length >= RECENT_MESSAGES_CAP) break;
    }

    return candidates.reverse();
  }
}

/**
 * Cap on `Channel.recentMessages` results — messages older than the burst,
 * since the bot last spoke. Tight by design (mnemonic/106): false-include
 * is a prompt-inject vector in busy groups, false-omit recreates the bug
 * we're fixing. Start at 10; widen if real traffic shows the cap is biting.
 */
const RECENT_MESSAGES_CAP = 10;

export type ReplyFunc<Raw = unknown> = (thread: Thread, message: Message<Raw>) => boolean | Promise<boolean>;

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
