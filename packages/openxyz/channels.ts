import { createTelegramAdapter, type TelegramAdapterConfig } from "@chat-adapter/telegram";

export type TelegramConfig = TelegramAdapterConfig & {
  botToken: string;
};

export function telegram(opts: TelegramConfig) {
  return createTelegramAdapter(opts);
}
