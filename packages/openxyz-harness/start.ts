import { Chat } from "chat";
import type { Message, Thread } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { scanChannels } from "./channels";

interface PollingAdapter {
  startPolling(cfg?: unknown): Promise<void>;
  stopPolling(): Promise<void>;
}

function hasPolling(adapter: unknown): adapter is PollingAdapter {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    typeof (adapter as PollingAdapter).startPolling === "function" &&
    typeof (adapter as PollingAdapter).stopPolling === "function"
  );
}

async function reply(thread: Thread, message: Message): Promise<void> {
  await thread.subscribe();
  await thread.post({ markdown: `hi\nyou said: "${message.text}"` });
}

export async function start(opts: { cwd: string }): Promise<{ stop(): Promise<void> }> {
  const adapters = await scanChannels(opts.cwd);
  if (Object.keys(adapters).length === 0) {
    console.warn("[openxyz] no channels found under channels/*.ts — running with no transports");
  }

  const bot = new Chat({
    adapters: adapters as Record<string, never>,
    state: createMemoryState(),
    userName: "openxyz",
    logger: "silent",
  });

  // fire-and-forget — awaiting here holds the chat-sdk thread lock and causes LockError on concurrent messages (working/004)
  bot.onDirectMessage((thread, message) => {
    reply(thread, message).catch((err) => console.error("[openxyz] handler error", err));
  });

  bot.onSubscribedMessage((thread, message) => {
    reply(thread, message).catch((err) => console.error("[openxyz] handler error", err));
  });

  await bot.initialize();

  const polling = Object.values(adapters).filter(hasPolling);
  await Promise.all(
    polling.map((adapter) =>
      adapter.startPolling({ timeout: 30, limit: 100, deleteWebhook: true, retryDelayMs: 1000 }),
    ),
  );

  return {
    async stop() {
      await Promise.all(polling.map((adapter) => adapter.stopPolling()));
      await bot.shutdown();
    },
  };
}
