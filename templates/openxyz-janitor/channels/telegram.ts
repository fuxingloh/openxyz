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
  description: "Comma-separated Telegram user IDs allowed to interact",
  schema: z.string().transform((s) => new Set(s.split(",").map((v) => v.trim()))),
});

class JanitorTelegram extends TelegramChannel {
  async reply(thread: Thread, message: Message<TelegramRaw>): Promise<ReplyAction> {
    if (!allowlist.has(message.author.userId)) return {};
    // In groups, only respond when addressed — @-mentioned or replying to the bot.
    if (!thread.isDM && !message.isMention && !isReplyToBot(thread, message)) return {};
    return super.reply(thread, message);
  }
}

export default new JanitorTelegram({
  botToken: readEnv("TELEGRAM_BOT_TOKEN", {
    description: "Telegram Bot API token from @BotFather",
  }),
});
