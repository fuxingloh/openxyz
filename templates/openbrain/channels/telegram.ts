import { Message, type ReplyAction, TelegramChannel, type TelegramRaw, type Thread } from "openxyz/channels/telegram";
import { env } from "openxyz/env";

const userAllowlist = env.TELEGRAM_ALLOWLIST.describe(
  "Comma-separated Telegram user IDs this brain serves (one person, or a small team)",
).transform(
  (s) =>
    new Set(
      s
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
);

// Optional group participation. A group ID is the Telegram chat ID (negative
// for groups, e.g. `-1001234567890`). Empty = DM-only; otherwise the bot only
// joins conversations in these groups, and only on behalf of allowlisted users.
const groupAllowlist = env.TELEGRAM_GROUP_ALLOWLIST.describe(
  "Comma-separated Telegram group/chat IDs where this brain may participate (empty = DM-only)",
)
  .default("")
  .transform(
    (s) =>
      new Set(
        s
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
      ),
  );

export default new TelegramChannel({
  botToken: env.TELEGRAM_BOT_TOKEN.describe("Telegram Bot API token from @BotFather"),
});

/**
 * Single policy gate — runs both for fresh messages and for recent-message
 * backfill (`Channel.recentMessages` in `@openxyz/runtime/channels.ts`),
 * so `context: false` here also keeps strangers out of the backfill prompt.
 *
 * Allowlisted groups are trusted spaces — the bot replies to every
 * allowlisted user there without needing a mention. Returning a
 * `ReplyAction` directly bypasses `TelegramChannel.reply`'s default
 * group-dispatch (which requires `@mention` or reply-to-bot).
 *
 * `message.raw.chat.id` is the bare Telegram chat ID (negative for groups);
 * `thread.channel.id` is chat-sdk's `telegram:<chatId>` form, so go through
 * raw to compare with the env allowlist.
 */
export async function reply(thread: Thread, message: Message<TelegramRaw>): Promise<ReplyAction> {
  if (thread.isDM) {
    // In DM, only allowed user.
    if (userAllowlist.has(message.author.userId)) return { reply: true };
    return { reply: false };
  }
  // In Whitelisted Group, anyone
  if (groupAllowlist.has(String(message.raw.chat.id))) {
    return { reply: true };
  }
  // Non-whitelisted Group, only allowlisted user
  if (userAllowlist.has(message.author.userId)) return { reply: true };
  // But context will be added
  return { reply: false, context: true };
}
