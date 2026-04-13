import { createTelegramAdapter, type TelegramAdapterConfig } from "@chat-adapter/telegram";
import type { Message } from "chat";

export type { MessageContext, ShouldRespondFn } from "@openxyz/harness/channels";

export type TelegramConfig = TelegramAdapterConfig & {
  botToken: string;
};

/**
 * Wraps the Telegram adapter to annotate platform-specific semantics as XML tags
 * before messages reach the harness. Proxy pattern is the chat-sdk-idiomatic way
 * to wrap adapters — see `../chat/examples/nextjs-chat/src/lib/recorder.ts`.
 *
 * See `working/051` for the Proxy wrap convention and `working/052` for XML tag
 * conventions across channels.
 *
 * TODO: groups — mention-based trigger, author attribution, "lurk unless addressed"
 *   behavior (working/050)
 */
export function telegram(opts: TelegramConfig) {
  const adapter = createTelegramAdapter(opts);

  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === "fetchMessages") {
        return async (...args: Parameters<typeof target.fetchMessages>) => {
          const result = await target.fetchMessages(...args);
          for (const msg of result.messages) annotateXml(msg);
          return result;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

interface TelegramRaw {
  reply_to_message?: { text?: string; from?: { is_bot?: boolean } };
  forward_from?: { first_name?: string; last_name?: string; username?: string };
  forward_from_chat?: { title?: string };
}

/**
 * Mutates `msg.text` to inject Telegram-specific chat semantics as XML tags.
 * See `working/052` for tag conventions.
 */
function annotateXml(msg: Message): void {
  const raw = msg.raw as TelegramRaw | undefined;
  if (!raw) return;

  // Reply context
  const parent = raw.reply_to_message?.text;
  if (parent) {
    const author = raw.reply_to_message?.from?.is_bot ? "assistant" : "user";
    msg.text = `<reply_to author="${author}">\n${parent}\n</reply_to>\n\n${msg.text}`;
  }

  // Forwarded content
  const forwardFrom =
    raw.forward_from_chat?.title ??
    [raw.forward_from?.first_name, raw.forward_from?.last_name].filter(Boolean).join(" ") ??
    raw.forward_from?.username;
  if (forwardFrom) {
    msg.text = `<forwarded from="${forwardFrom}">\n${msg.text}\n</forwarded>`;
  }
}
