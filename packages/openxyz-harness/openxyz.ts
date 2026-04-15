import { Chat } from "chat";
import type { Thread as ChatThread, Message as ChatMessage, StateAdapter } from "chat";
import type { Tool } from "ai";
import type { ChannelFile } from "./channels";
import { AgentFactory, type AgentDef } from "./agents/factory";
import type { SkillInfo } from "./tools/skill";

/**
 * Materialized template shape passed into the harness. Scanning lives in the
 * `openxyz` CLI layer — harness receives everything already parsed.
 */
export type OpenXyzTemplate = {
  cwd: string;
  channels: Record<string, ChannelFile>;
  tools: Record<string, Tool>;
  agents: Record<string, AgentDef>;
  skills: SkillInfo[];
  /**
   * Template-level markdown artifacts injected into system prompts.
   * Keyed so we can add `user`, `memory`, `bootstrap`, etc. without growing
   * the top-level shape.
   */
  mds?: { agents?: string };
};

export class OpenXyz {
  readonly cwd: string;
  readonly agentFactory: AgentFactory;
  readonly template: OpenXyzTemplate;
  #chat?: Chat;

  constructor(template: OpenXyzTemplate) {
    this.cwd = template.cwd;
    this.template = template;
    this.agentFactory = new AgentFactory(template);
  }

  /**
   * Non-blocking init. Wires channel handlers into chat-sdk and initializes
   * adapters. Callers own the `state` lifecycle — create it, pass it in.
   */
  async init(opts: { state: StateAdapter }): Promise<void> {
    const channels = this.template.channels;

    if (Object.keys(channels).length === 0) {
      throw new Error("[openxyz] no channels provided — nothing to run");
    }

    const chat = new Chat({
      adapters: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, v.adapter])) as Record<string, never>,
      state: opts.state,
      userName: "openxyz",
      logger: "info",
      fallbackStreamingPlaceholderText: null,
    });

    // chat-sdk dispatch is tiered with early returns (mnemonic/059).
    // Fan out every incoming-message tier into a single `onMessage` so channel
    // files own the decision via `action()` regardless of how chat-sdk routed.
    chat.onDirectMessage((thread, message) => {
      this.onMessage(thread, message).catch((err) => console.error("[openxyz] onMessage failed", err));
    });
    chat.onNewMention((thread, message) => {
      // First @-mention in an unsubscribed (typically group) thread — subscribe
      // so follow-ups flow through onSubscribedMessage (mnemonic/050).
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

  /**
   * Per-adapter webhook handlers from chat-sdk. In webhook-mode deployments
   * (Vercel, Bun.serve, etc.) route `/webhooks/:adapter` to `webhooks[adapter](request)`.
   */
  get webhooks(): Record<string, (request: Request) => Promise<Response>> {
    if (!this.#chat) throw new Error("[openxyz] not initialized — call init() first");
    return this.#chat.webhooks as Record<string, (request: Request) => Promise<Response>>;
  }

  async onMessage(thread: ChatThread, message: ChatMessage): Promise<void> {
    await thread.subscribe();
    const channel = this.template.channels[thread.adapter.name];
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
    // Env goes before the conversation, not after — Bedrock (and some other providers) reject system
    // messages interleaved between user/assistant turns. Kept out of the cached `instructions` prefix
    // because env is per-message dynamic (time, user, channel metadata).
    const prompt = env.length > 0 ? [{ role: "system" as const, content: env.join("\n") }, ...context] : context;
    const result = await agent.stream({
      prompt: prompt,
    });
    await thread.post(result.fullStream);
  }

  async stop(): Promise<void> {
    await this.#chat?.shutdown();
  }
}
