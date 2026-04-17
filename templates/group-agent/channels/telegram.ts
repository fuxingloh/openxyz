import { isReplyToBot, Message, TelegramChannel, type TelegramRaw, Thread } from "openxyz/channels/telegram";
import { readEnv, z } from "openxyz/env";

// Group-agent allowlists **groups**, not individual users. A group ID is the
// Telegram chat ID (negative for groups, e.g. `-1001234567890`). Keeps the
// bot from leaking into strangers' groups if someone adds it uninvited.
const groupAllowlist = readEnv("TELEGRAM_GROUP_ALLOWLIST", {
  description: "Comma-separated Telegram group/chat IDs where this bot may participate",
  schema: z.string().transform((s) => new Set(s.split(",").map((v) => v.trim()))),
});

export default new TelegramChannel({
  botToken: readEnv("TELEGRAM_BOT_TOKEN", {
    description: "Telegram Bot API token from @BotFather",
  }),
});

export function reply(thread: Thread, message: Message<TelegramRaw>) {
  // DMs are out of scope for the group persona. Re-route users to a
  // DM-capable template (pkbm-agent or openxyz-janitor).
  if (thread.isDM) return false;
  if (!groupAllowlist.has(thread.channel.id)) return false;
  // Lurk unless addressed.
  if (!message.isMention && !isReplyToBot(thread, message)) return false;
  return true;
}
