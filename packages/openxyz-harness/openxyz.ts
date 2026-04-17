import { Chat } from "chat";
import type { Thread as ChatSdkThread, Message as ChatSdkMessage, StateAdapter } from "chat";
import type { LanguageModel, Tool } from "ai";
import type { Channel } from "./channels";
import { AgentFactory, type AgentDef } from "./agents/factory";
import type { SkillDef } from "./tools/skill";

/**
 * Materialized template shape passed into the harness. Scanning lives in the
 * `openxyz` CLI layer — harness receives everything already parsed.
 */
export type OpenXyzRuntime = {
  cwd: string;
  channels: Record<string, Channel>;
  tools: Record<string, Tool>;
  agents: Record<string, AgentDef>;
  /**
   * Named language models — concrete, pre-resolved. The `openxyz` CLI scans
   * agent frontmatter, figures out which names are referenced, loads just
   * those (calling any factory exports like `auto.ts` at load time), and
   * hands the resolved map over.
   */
  models: Record<string, LanguageModel>;
  skills: SkillDef[];
  /**
   * Template-level markdown artifacts injected into system prompts.
   * Keyed so we can add `user`, `memory`, `bootstrap`, etc. without growing
   * the top-level shape.
   */
  mds?: { agents?: string };
};

export class OpenXyz {
  readonly cwd: string;
  readonly runtime: OpenXyzRuntime;
  readonly agentFactory: AgentFactory;
  #chat?: Chat;

  constructor(runtime: OpenXyzRuntime) {
    this.cwd = runtime.cwd;
    this.runtime = runtime;
    this.agentFactory = new AgentFactory(runtime);
  }

  /**
   * Non-blocking init. Wires channel handlers into chat-sdk and initializes
   * adapters. Callers own the `state` lifecycle — create it, pass it in.
   */
  async init(opts: { state: StateAdapter }): Promise<void> {
    const channels = this.runtime.channels;

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
    // Handlers await — serverless invocations run one message at a time, so the
    // LockError risk from mnemonic/004 (long-running local process with
    // concurrent messages) doesn't apply. Awaiting keeps the Vercel function
    // alive through the full onMessage flow instead of getting cut short and
    // redispatched via Redis.
    chat.onDirectMessage(async (thread, message) => {
      try {
        await this.onMessage(thread, message);
      } catch (err) {
        console.error("[openxyz] onMessage failed", err);
      }
    });
    chat.onNewMention(async (thread, message) => {
      // First @-mention in an unsubscribed (typically group) thread — subscribe
      // so follow-ups flow through onSubscribedMessage (mnemonic/050).
      try {
        await thread.subscribe();
      } catch (err) {
        console.warn("[openxyz] thread.subscribe failed", err);
      }
      try {
        await this.onMessage(thread, message);
      } catch (err) {
        console.error("[openxyz] onMessage failed", err);
      }
    });
    chat.onSubscribedMessage(async (thread, message) => {
      try {
        await this.onMessage(thread, message);
      } catch (err) {
        console.error("[openxyz] onMessage failed", err);
      }
    });
    // Catch-all pattern — fires for unsubscribed non-DM non-mention messages
    // (typically random group chatter). Channel `reply()` decides whether to
    // engage; returning `{}` stays silent.
    chat.onNewMessage(/.+/, async (thread, message) => {
      try {
        await this.onMessage(thread, message);
      } catch (err) {
        console.error("[openxyz] onMessage failed", err);
      }
    });

    await chat.initialize();
    this.#chat = chat;
  }

  /**
   * Per-adapter webhook handlers from chat-sdk. In webhook-mode deployments
   * (Vercel, Bun.serve, etc.) route `/api/webhooks/:adapter` to `webhooks[adapter](request)`.
   */
  get webhooks(): Record<string, (request: Request) => Promise<Response>> {
    if (!this.#chat) throw new Error("[openxyz] not initialized — call init() first");
    return this.#chat.webhooks as Record<string, (request: Request) => Promise<Response>>;
  }

  async onMessage(thread: ChatSdkThread, message: ChatSdkMessage): Promise<void> {
    await thread.subscribe();
    const channel = this.runtime.channels[thread.adapter.name];
    if (!channel) {
      throw new Error(`[openxyz] no channel config for adapter "${thread.adapter.name}"`);
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
    // messages interleaved between user/assistant turns.
    const prompt = env.length > 0 ? [{ role: "system" as const, content: env.join("\n") }, ...context] : context;
    const result = await agent.stream({ prompt });
    try {
      await thread.post(result.fullStream);
    } catch (err) {
      console.error(`[openxyz] thread.post failed`, err);
      const msg = err instanceof Error ? err.message : String(err);
      await thread.post(`⚠️ Error generating reply: ${msg}`).catch((e) => {
        console.error(`[openxyz] fallback error post failed`, e);
      });
    }
  }

  async stop(): Promise<void> {
    await this.#chat?.shutdown();
  }
}
