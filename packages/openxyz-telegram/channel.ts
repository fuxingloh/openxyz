import { createTelegramAdapter, type TelegramAdapterConfig, type TelegramRawMessage } from "@chat-adapter/telegram";
import { type AiMessage, type AiMessagePart, type Message, toAiMessages } from "chat";
import type { Adapter as ChatSdkAdapter } from "chat";
import type { ModelMessage, SystemModelMessage } from "ai";
import { Channel, Session, type ReplyAction, type Thread } from "@openxyz/runtime/channels";
import { backend } from "@openxyz/runtime/backend";

export type { Thread, Message, ReplyAction } from "@openxyz/runtime/channels";
export { Channel } from "@openxyz/runtime/channels";

export type TelegramConfig = TelegramAdapterConfig & {
  botToken: string;
  /**
   * When `true`, each Telegram forum topic (chat-sdk "thread") gets its own
   * session log. When `false` (default), every topic inside a supergroup
   * shares one session — the chief-of-staff model where the assistant
   * remembers across topics in the same room. Irrelevant in DMs, where
   * thread and channel are effectively the same scope.
   */
  threaded?: boolean;
};

/**
 * Concrete Telegram `Channel`. Templates typically subclass this and
 * override `reply()` (and optionally `filter()`), then `export default new
 * SubclassName(opts)`. Call `super.reply(thread, message)` to defer to this
 * class's default dispatch once your gate checks pass.
 */
export class TelegramChannel extends Channel<TelegramRaw> {
  readonly adapter: ChatSdkAdapter;
  readonly #threaded: boolean;

  constructor(opts: TelegramConfig) {
    super();
    this.#threaded = opts.threaded ?? false;
    // On Vercel, the function is serverless — polling would block forever
    // and bleed connections. Require webhook mode; the user runs Telegram's
    // `setWebhook` once, pointing at `https://<deploy>/webhooks/telegram`.
    // The adapter verifies the incoming request via TELEGRAM_WEBHOOK_SECRET_TOKEN
    // (or `secretToken` in opts) — set it or requests run unverified.
    const mode: TelegramAdapterConfig["mode"] = backend() === "vercel" ? "webhook" : "polling";
    this.adapter = createTelegramAdapter({ ...opts, mode });
  }

  override async getSession(thread: Thread): Promise<Session> {
    // Default `threaded: false` → channel-scoped. Supergroups with forum
    // topics pool every topic into one session, so the assistant keeps a
    // single running memory across the whole group. Flip to `threaded: true`
    // for strict per-topic sessions. DMs collapse the distinction either way.
    return new Session(thread, this.#threaded ? "thread" : "channel");
  }

  async toModelMessage(thread: Thread, message: Message<TelegramRaw>): Promise<ModelMessage> {
    // History is owned by the session now (mnemonic/081). Per-message mapping
    // preserves Telegram's reply/forward XML annotation so the agent sees
    // conversation structure, not just flat text.
    const botUserId = (this.adapter as { botUserId?: string }).botUserId;
    const [result] = await toAiMessages([message], {
      includeNames: !thread.isDM,
      transformMessage: (aiMsg, src) => annotate(aiMsg, src, botUserId),
    });
    return result as ModelMessage;
  }

  async getSystemMessage(thread: Thread): Promise<SystemModelMessage> {
    return {
      role: "system",
      content: thread.isDM ? `Telegram DM: ${thread.channel.name}` : `Telegram Group: ${thread.channel.name}`,
    };
  }

  /**
   * Telegram's `dateSent` is 1s-resolution (Bot API delivers Unix seconds),
   * so a forwarded burst typically ties on timestamp. The per-chat
   * `message_id` (numeric tail of `chat:msgid` like `7601560926:14`) is
   * monotonic and authoritative for send order — extract and use as
   * tiebreaker. Lexical id sort would mis-order `:9` vs `:14`, hence the
   * numeric extraction.
   */
  override sortMessages(messages: Message<TelegramRaw>[]): Message<TelegramRaw>[] {
    return [...messages].sort((a, b) => {
      const t = a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime();
      if (t !== 0) return t;
      return idTail(a.id) - idTail(b.id);
    });
  }

  /**
   * Default dispatch: respond to DMs, respond in groups only when @-mentioned
   * or replied-to. Templates with allowlists typically check the allowlist
   * first and then `return super.reply(thread, message)` to reuse this.
   */
  async reply(thread: Thread, message: Message<TelegramRaw>): Promise<ReplyAction> {
    if (thread.isDM) return { reply: true };
    if (message.isMention || isReplyToBot(thread, message)) {
      return { reply: true, reaction: "👀" };
    }
    return { reply: false };
  }
}

/**
 * Upstream `TelegramRawMessage` omits reply/forward/quote fields. Extend here
 * with the subset we annotate against. See https://core.telegram.org/bots/api#message.
 */
export type TelegramRaw = TelegramRawMessage & {
  reply_to_message?: TelegramRawMessage & {
    text?: string;
    caption?: string;
    from?: TelegramUser;
    sender_chat?: TelegramChat;
  };
  /** Set when the user selected a portion of the replied-to message to quote. */
  quote?: { text: string; is_manual?: boolean };
  /** Telegram Bot API 7.0+ unified forward metadata. */
  forward_origin?: TelegramForwardOrigin;
  /** Legacy forward fields (still populated alongside forward_origin). */
  forward_from?: TelegramUser;
  forward_from_chat?: TelegramChat;
  forward_sender_name?: string;
  is_automatic_forward?: boolean;
};

interface TelegramUser {
  id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}

interface TelegramChat {
  id?: number;
  title?: string;
  username?: string;
}

type TelegramForwardOrigin =
  | { type: "user"; sender_user: TelegramUser }
  | { type: "hidden_user"; sender_user_name: string }
  | { type: "chat"; sender_chat: TelegramChat; author_signature?: string }
  | { type: "channel"; chat: TelegramChat; message_id: number; author_signature?: string };

/**
 * Extract the trailing numeric segment of a Telegram message id for the
 * burst-sort tiebreaker. Ids look like `7601560926:14`; the suffix is the
 * per-chat `message_id` and is monotonic. Falls back to `0` for any id that
 * doesn't end in digits — in practice every Telegram id does.
 */
function idTail(id: string): number {
  const m = id.match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function annotate(aiMsg: AiMessage, src: Message, botUserId: string | undefined): AiMessage {
  const raw = src.raw as TelegramRaw | undefined;
  if (!raw) return aiMsg;

  const blocks: string[] = [];

  const reply = buildReply(raw, botUserId);
  if (reply) blocks.push(reply);

  const forward = buildForward(raw);
  if (forward) blocks.push(forward);

  if (blocks.length === 0) return aiMsg;

  const prefix = blocks.join("\n\n") + "\n\n";
  return prependText(aiMsg, prefix);
}

function buildReply(raw: TelegramRaw, botUserId: string | undefined): string | null {
  const reply = raw.reply_to_message;
  if (!reply) return null;

  const quoted = raw.quote?.text ?? reply.text ?? reply.caption;
  if (!quoted) return null;

  const replyingToBot = isBotUser(reply.from, botUserId);
  const author = replyingToBot
    ? "assistant"
    : (userDisplayName(reply.from) ?? chatDisplayName(reply.sender_chat) ?? "user");

  return `<reply_to author="${escapeAttr(author)}">\n${quoted}\n</reply_to>`;
}

function buildForward(raw: TelegramRaw): string | null {
  const from = forwardFrom(raw);
  if (!from) return null;
  return `<forwarded from="${escapeAttr(from)}" />`;
}

function forwardFrom(raw: TelegramRaw): string | null {
  const origin = raw.forward_origin;
  if (origin) {
    switch (origin.type) {
      case "user":
        return userDisplayName(origin.sender_user);
      case "hidden_user":
        return origin.sender_user_name;
      case "chat":
        return chatDisplayName(origin.sender_chat);
      case "channel":
        return chatDisplayName(origin.chat);
    }
  }

  return userDisplayName(raw.forward_from) ?? chatDisplayName(raw.forward_from_chat) ?? raw.forward_sender_name ?? null;
}

/**
 * True when the message is a reply to one of our bot's earlier messages.
 * Reads `raw.reply_to_message.from.id` against the adapter's `botUserId`
 * (populated after `adapter.initialize()` → `getMe()`).
 */
export function isReplyToBot(thread: Thread, message: Message<TelegramRaw>): boolean {
  const botUserId = (thread.adapter as { botUserId?: string }).botUserId;
  const raw = message.raw;
  if (!raw?.reply_to_message || !botUserId) return false;
  return isBotUser(raw.reply_to_message.from, botUserId);
}

function isBotUser(user: TelegramUser | undefined, botUserId: string | undefined): boolean {
  return !!user?.id && !!botUserId && String(user.id) === botUserId;
}

function userDisplayName(user: TelegramUser | undefined): string | null {
  if (!user) return null;
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return full || user.username || null;
}

function chatDisplayName(chat: TelegramChat | undefined): string | null {
  if (!chat) return null;
  return chat.title ?? chat.username ?? null;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function prependText(aiMsg: AiMessage, prefix: string): AiMessage {
  // AiAssistantMessage is always string; only AiUserMessage can hold parts.
  if (aiMsg.role === "assistant" || typeof aiMsg.content === "string") {
    return { ...aiMsg, content: prefix + (aiMsg.content as string) };
  }
  const parts = aiMsg.content;
  const textIdx = parts.findIndex((p) => p.type === "text");
  if (textIdx >= 0) {
    const next: AiMessagePart[] = parts.map((p, i) =>
      i === textIdx && p.type === "text" ? { ...p, text: prefix + p.text } : p,
    );
    return { role: "user", content: next };
  }
  // No text part (pure attachments) — inject one up front.
  return { role: "user", content: [{ type: "text", text: prefix.trimEnd() }, ...parts] };
}
