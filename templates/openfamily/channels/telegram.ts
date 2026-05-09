import { isReplyToBot, Message, TelegramChannel, type TelegramRaw, Thread } from "openxyz/channels/telegram";
import { env, z } from "openxyz/env";

// OpenFamily is the *group participant* shape: the bot lives inside one or
// more allowlisted family/team groups and waits to be addressed there. A
// group ID is the Telegram chat ID (negative for groups, e.g.
// `-1001234567890`). Required (non-empty) — keeps the bot from leaking into
// strangers' groups if someone adds it uninvited.
const groupAllowlist = env.TELEGRAM_GROUP_ALLOWLIST.describe(
  "Comma-separated Telegram group/chat IDs where this bot may participate",
).pipe(
  z
    .string()
    .transform(
      (s) =>
        new Set(
          s
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
        ),
    )
    .refine((set) => set.size > 0, "must contain at least one group ID"),
);

// DMs are gated by a separate user allowlist so the group bot can also be
// addressed one-on-one (e.g. by family members or moderators) without
// accepting DMs from arbitrary users who discover the handle. Defaults to
// empty = DMs disabled entirely; the bot is purely a group participant.
const userAllowlist = env.TELEGRAM_USER_ALLOWLIST.describe(
  "Comma-separated Telegram user IDs allowed to DM this bot (empty = no DMs)",
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
 * still flow into the agent's view via `Channel.recentMessages` backfill,
 * so unaddressed group chatter is in scope as antecedent context the next
 * time the bot is addressed. Group `👀` ack on reply is auto-fired by the
 * runtime. `message.raw.chat.id` is the bare Telegram chat ID;
 * `thread.channel.id` is chat-sdk's `telegram:<chatId>` form.
 */
export function reply(thread: Thread, message: Message<TelegramRaw>): boolean {
  if (thread.isDM) return userAllowlist.has(message.author.userId);
  if (!groupAllowlist.has(String(message.raw.chat.id))) return false;
  return message.isMention || isReplyToBot(thread, message);
}
