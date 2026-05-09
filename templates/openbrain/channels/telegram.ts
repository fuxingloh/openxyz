import { isReplyToBot, Message, TelegramChannel, type TelegramRaw, type Thread } from "openxyz/channels/telegram";
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
 * Trigger gate. `true` engages an agent turn; `false` stays silent. Lurkers
 * (`false`) still flow into the agent's view via `Channel.recentMessages`
 * backfill, so don't worry about "should this be visible" here. Group
 * `👀` ack on reply is auto-fired by the runtime. `message.raw.chat.id`
 * is the bare Telegram chat ID; `thread.channel.id` is chat-sdk's
 * `telegram:<chatId>` form.
 */
export function reply(thread: Thread, message: Message<TelegramRaw>): boolean {
  // DM: only allowed user.
  if (thread.isDM) return userAllowlist.has(message.author.userId);
  // Whitelisted group: reply to anyone, mention-free.
  if (groupAllowlist.has(String(message.raw.chat.id))) return true;
  // Other group: only allowlisted user, only when addressed.
  if (userAllowlist.has(message.author.userId)) {
    return message.isMention || isReplyToBot(thread, message);
  }
  return false;
}
