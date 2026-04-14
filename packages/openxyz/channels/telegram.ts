import { createTelegramAdapter, type TelegramAdapterConfig, type TelegramRawMessage } from "@chat-adapter/telegram";
import { type AiMessage, type AiMessagePart, type Message, toAiMessages } from "chat";
import type { ChannelFile, Thread } from "@openxyz/harness/channels";

export type { Thread, Message, Action } from "@openxyz/harness/channels";

export type TelegramConfig = TelegramAdapterConfig & {
  botToken: string;
};

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

export function telegram(opts: TelegramConfig): ChannelFile<TelegramRaw> {
  const adapter = createTelegramAdapter(opts);

  return {
    adapter,
    context: async (thread: Thread, _message: Message<TelegramRaw>) => {
      // Telegram "threads" are forum topics — a supergroup splits into many.
      // Fetch at the channel level so context spans every topic in the chat.
      // Cache-backed: only returns messages the adapter has seen this session.
      const { messages } = await thread.channel.adapter.fetchChannelMessages!(thread.channel.id, { limit: 100 });
      console.log(`[telegram] fetched ${messages.length} messages for context in channel ${thread.channel.id}`); // debug
      return await toAiMessages(messages, {
        includeNames: !thread.isDM,
        transformMessage: (aiMsg, src) => annotate(aiMsg, src, adapter.botUserId),
      });
    },
    /**
     * Default action if no `export function action` is provided in the channel file.
     * Also used when `export function action() { return true }`, true -> uses this.
     */
    async action(thread: Thread, message: Message<TelegramRaw>) {
      if (thread.isDM) {
        return { agent: "general", typing: true };
      }

      if (message.isMention || isReplyToBot(thread, message)) {
        return { agent: "general", typing: true, reaction: "👀" };
      }

      // Default is doing nothing.
      return {};
    },
  };
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
