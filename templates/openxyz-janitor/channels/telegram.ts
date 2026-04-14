import { isReplyToBot, Message, telegram, type TelegramRaw, Thread } from "openxyz/channels/telegram";
import { readEnv, z } from "openxyz/env";

export default telegram({
  botToken: readEnv("TELEGRAM_BOT_TOKEN", {
    description: "Telegram Bot API token from @BotFather",
  }),
});

const allowlist = readEnv("TELEGRAM_ALLOWLIST", {
  description: "Comma-separated Telegram user IDs allowed to interact",
  schema: z.string().transform((s) => new Set(s.split(",").map((v) => v.trim()))),
});

export function reply(thread: Thread, message: Message<TelegramRaw>) {
  if (!allowlist.has(message.author.userId)) return false;
  // In groups, only respond when addressed — @-mentioned or replying to the bot.
  if (!thread.isDM && !message.isMention && !isReplyToBot(thread, message)) return false;
  return true;
}
