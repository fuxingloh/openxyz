import { telegram, Should, type MessageContext } from "openxyz/channels/telegram";
import { readEnv, z } from "openxyz/env";

export default telegram({
  botToken: readEnv("TELEGRAM_BOT_TOKEN", {
    description: "Telegram Bot API token from @BotFather",
  }),
});

const allowlist = new Set(
  readEnv("TELEGRAM_ALLOWLIST", {
    description: "Comma-separated Telegram user IDs allowed to interact",
    schema: z.string().transform((s) => s.split(",").map((v) => v.trim())),
  }),
);

export function should({ message }: MessageContext): Should {
  return allowlist.has(message.author.userId) ? Should.respond : Should.skip;
}
