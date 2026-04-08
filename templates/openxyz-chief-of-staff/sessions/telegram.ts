import { Chat } from "chat";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createMemoryState } from "@chat-adapter/state-memory";

// TODO(?): The adapter auto-detects
//  TELEGRAM_BOT_TOKEN,
//  TELEGRAM_WEBHOOK_SECRET_TOKEN,
//  TELEGRAM_BOT_USERNAME, and
//  TELEGRAM_API_BASE_URL from environment variables:

const bot = new Chat({
  userName: "janitor",
  adapters: {
    telegram: createTelegramAdapter(),
  },
  state: createMemoryState(),
});

void bot.initialize();

export default bot;
