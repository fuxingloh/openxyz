import { Message, TelegramChannel, type TelegramRaw, Thread } from "openxyz/channels/telegram";
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
 * Decides which messages enter the thread history at all. Bot's own messages
 * must pass so the agent sees its prior turns; everyone else is allowlist-gated.
 * In groups, the group itself must also be allowlisted.
 */
export function filter(message: Message<TelegramRaw>, thread: Thread) {
  const botUserId = (thread.adapter as { botUserId?: string }).botUserId;
  if (botUserId && message.author.userId === botUserId) return true;
  if (!userAllowlist.has(message.author.userId)) return false;
  // `thread.channel.id` is chat-sdk's `telegram:<chatId>` form; the env
  // allowlist holds the bare Telegram chat IDs users see in the app, so go
  // through `message.raw.chat.id` to compare apples-to-apples.
  if (!thread.isDM && !groupAllowlist.has(String(message.raw.chat.id))) return false;
  return true;
}

/**
 * DMs always reply. Allowlisted groups are treated as trusted spaces — the
 * bot replies to every allowlisted user there without needing a mention.
 */
export async function reply(thread: Thread, message: Message<TelegramRaw>) {
  if (!userAllowlist.has(message.author.userId)) return false;
  if (thread.isDM) return true;
  return groupAllowlist.has(String(message.raw.chat.id));
}
