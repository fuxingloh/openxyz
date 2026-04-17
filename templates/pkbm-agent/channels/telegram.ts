import {
  isReplyToBot,
  Message,
  type ReplyAction,
  TelegramChannel,
  type TelegramRaw,
  Thread,
} from "openxyz/channels/telegram";
import { readEnv, z } from "openxyz/env";

const allowlist = readEnv("TELEGRAM_ALLOWLIST", {
  description: "Comma-separated Telegram user IDs this PKBM agent serves",
  schema: z.string().transform((s) => new Set(s.split(",").map((v) => v.trim()))),
});

class PkbmTelegram extends TelegramChannel {
  // PKBM can sit in a group chat, but it's a *personal* knowledge base —
  // context is scoped to the owner's messages and the bot's own replies.
  // Other group members' chatter never reaches the agent.
  filter(message: Message<TelegramRaw>, thread: Thread) {
    const botUserId = (thread.adapter as { botUserId?: string }).botUserId;
    if (botUserId && message.author.userId === botUserId) return true;
    return allowlist.has(message.author.userId);
  }

  // In DMs: respond to anyone on the allowlist.
  // In groups: respond only when the allowlisted user addresses the bot
  // directly — @-mention or reply to the bot's message.
  async reply(thread: Thread, message: Message<TelegramRaw>): Promise<ReplyAction> {
    if (!allowlist.has(message.author.userId)) return {};
    if (thread.isDM) return super.reply(thread, message);
    if (!message.isMention && !isReplyToBot(thread, message)) return {};
    return super.reply(thread, message);
  }
}

export default new PkbmTelegram({
  botToken: readEnv("TELEGRAM_BOT_TOKEN", {
    description: "Telegram Bot API token from @BotFather",
  }),
});
