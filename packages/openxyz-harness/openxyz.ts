import { Chat } from "chat";
import type { Thread as ChatThread, Message as ChatMessage } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { scanChannelFiles, type ChannelFile } from "./channels";
import { AgentFactory } from "./agents/factory";

export class OpenXyz {
  readonly cwd: string;
  readonly agentFactory: AgentFactory;
  #chat?: Chat;
  #channels: Record<string, ChannelFile> = {};

  constructor(opts: { cwd: string }) {
    this.cwd = opts.cwd;
    this.agentFactory = new AgentFactory(this.cwd);
  }

  async start(): Promise<void> {
    const [, channels] = await Promise.all([this.agentFactory.init(), scanChannelFiles(this.cwd)]);
    this.#channels = channels;

    if (Object.keys(channels).length === 0) {
      throw new Error("[openxyz] no channels found under channels/*.ts — nothing to run");
    }

    const chat = new Chat({
      adapters: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, v.adapter])) as Record<string, never>,
      state: createMemoryState(),
      userName: "openxyz",
      logger: "info",
      fallbackStreamingPlaceholderText: null,
    });

    // chat-sdk dispatch is tiered with early returns (working/059).
    // Fan out every incoming-message tier into a single `onMessage` so channel
    // files own the decision via `action()` regardless of how chat-sdk routed.
    chat.onDirectMessage((thread, message) => {
      this.onMessage(thread, message).catch((err) => console.error("[openxyz] onMessage failed", err));
    });
    chat.onNewMention((thread, message) => {
      // First @-mention in an unsubscribed (typically group) thread — subscribe
      // so follow-ups flow through onSubscribedMessage (working/050).
      thread.subscribe().catch((err) => console.warn("[openxyz] thread.subscribe failed", err));
      this.onMessage(thread, message).catch((err) => console.error("[openxyz] onMessage failed", err));
    });
    chat.onSubscribedMessage((thread, message) => {
      this.onMessage(thread, message).catch((err) => console.error("[openxyz] onMessage failed", err));
    });
    // Catch-all pattern — fires for unsubscribed non-DM non-mention messages
    // (typically random group chatter). Channel `reply()` decides whether to
    // engage; returning `{}` stays silent.
    chat.onNewMessage(/.+/, (thread, message) => {
      this.onMessage(thread, message).catch((err) => console.error("[openxyz] onMessage failed", err));
    });

    // initialize() auto-starts polling for adapters in "auto" mode when no webhook is configured.
    await chat.initialize();
    this.#chat = chat;
  }

  async onMessage(thread: ChatThread, message: ChatMessage): Promise<void> {
    await thread.subscribe();
    const channel = this.#channels[thread.adapter.name];
    if (!channel) {
      throw new Error(`[openxyz] received message for adapter "${thread.adapter.name}" but no channel config found`);
    }

    const reply = await channel.reply(thread, message);

    if (reply.typing) {
      const status = typeof reply.typing === "string" ? reply.typing : undefined;
      thread.startTyping(status).catch((err) => console.warn("[openxyz] startTyping failed", err));
    }

    if (reply.reaction) {
      thread.adapter
        .addReaction(thread.id, message.id, reply.reaction)
        .catch((err) => console.warn("[openxyz] addReaction failed", err));
    }

    if (!reply.agent) return;

    const agent = await this.agentFactory.create(reply.agent);
    const [env, context] = await Promise.all([channel.environment(thread, message), channel.context(thread, message)]);
    const prompt = env.length > 0 ? [...context, { role: "system" as const, content: env.join("\n") }] : context;
    const result = await agent.stream({
      prompt: prompt,
    });
    await thread.post(result.fullStream);
  }

  async stop(): Promise<void> {
    await this.#chat?.shutdown();
  }
}
