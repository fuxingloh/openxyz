import { telegram } from "openxyz/channels";
import { getEnv } from "openxyz/env";

export default telegram({
  botToken: getEnv("TELEGRAM_BOT_TOKEN", {
    description: "Telegram Bot API token from @BotFather",
  }),
});

export const allowlist = getEnv("TELEGRAM_ALLOWLIST", {
  required: false,
  description: "Comma-separated Telegram user IDs allowed to interact",
})?.split(",");
