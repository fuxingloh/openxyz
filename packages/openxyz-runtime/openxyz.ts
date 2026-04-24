import { Chat } from "chat";
import type { Message as ChatSdkMessage, StateAdapter } from "chat";
import type { Tool } from "ai";
import type { Channel, Thread } from "./channels";
import type { Drive } from "./drive";
import { AgentFactory, type AgentDef } from "./agents/factory";
import type { Model } from "./model";
import type { SkillDef } from "./tools/skill";

/**
 * Materialized template shape passed into the runtime. Scanning lives in the
 * `openxyz` CLI layer — runtime receives everything already parsed.
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
  models: Record<string, Model>;
  /**
   * Mounted drives keyed by absolute VFS mount path (`/workspace`,
   * `/mnt/notes`, …). Runtime calls `refresh()` on each drive before an
   * agent turn and `commit()` after `thread.post(...)` settles.
   * `FilesystemTools` consumes this record (filtered by the agent's
   * `filesystem` permission config) to build the per-turn mount table.
   */
  drives: Record<string, Drive>;
  skills: SkillDef[];
  /**
   * Template-level markdown artifacts injected into system prompts.
   * Keyed so we can add `user`, `memory`, `bootstrap`, etc. without growing
   * the top-level shape.
   */
  mds?: { agents?: string };
  /**
   * Teardown callbacks registered by the loader (MCP clients, stdio child
   * processes, etc.). `OpenXyz.stop()` invokes each with `Promise.allSettled`
   * so a slow or failing teardown never blocks the others.
   */
  cleanup?: Array<() => Promise<void>>;
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
   *
   * Session storage (the agent-ledger — full `ModelMessage[]` with tool
   * dialog) piggy-backs on `state` via chat-sdk's `thread.state` — Redis /
   * PGlite / Postgres all transparently persist it. See mnemonic/081.
   */
  async init(opts: { state: StateAdapter }): Promise<void> {
    const channels = this.runtime.channels;

    if (Object.keys(channels).length === 0) {
      throw new Error("[openxyz] no channels provided — nothing to run");
    }

    const chat = new Chat({
      adapters: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, v.adapter])) as Record<string, never>,
      state: opts.state,
      // `queue-debounce` (vendored via patches/chat@4.26.0.patch, upstreamed
      // in the same branch — pending release): first message on an idle thread
      // waits `debounceMs` so a burst landing in that window collapses into
      // one handler call with `context.skipped` populated. Subsequent bursts
      // arriving mid-handler drain through the normal queue path — no orphan
      // bug like pure `debounce`. Lets the agent respond to "three messages
      // in 1s" as one turn instead of 1 | 2+3. Cost: +1s baseline latency on
      // every DM, including lone messages. Acceptable for an assistant.
      concurrency: { strategy: "queue-debounce", debounceMs: 1000 },
      userName: "openxyz",
      logger: "info",
      fallbackStreamingPlaceholderText: null,
    });

    // chat-sdk dispatch is tiered with early returns (mnemonic/059).
    // Fan out every incoming-message tier into a single `onMessages` so channel
    // files own the decision via `action()` regardless of how chat-sdk routed.
    // Handlers await — serverless invocations run one message at a time, so the
    // LockError risk from mnemonic/004 (long-running local process with
    // concurrent messages) doesn't apply. Awaiting keeps the Vercel function
    // alive through the full onMessages flow instead of getting cut short and
    // redispatched via Redis.
    // `onDirectMessage` handler signature is `(thread, message, channel, context)` —
    // the only tier with a 4-arg shape. The other three are `(thread, message, context)`.
    chat.onDirectMessage(async (thread, message, _channel, context) => {
      try {
        await this.onMessages(thread, [...(context?.skipped ?? []), message]);
      } catch (err) {
        console.error("[openxyz] onMessages failed", err);
      }
    });
    chat.onNewMention(async (thread, message, context) => {
      // First @-mention in an unsubscribed (typically group) thread — subscribe
      // so follow-ups flow through onSubscribedMessage (mnemonic/050).
      try {
        await thread.subscribe();
      } catch (err) {
        console.warn("[openxyz] thread.subscribe failed", err);
      }
      try {
        await this.onMessages(thread, [...(context?.skipped ?? []), message]);
      } catch (err) {
        console.error("[openxyz] onMessages failed", err);
      }
    });
    chat.onSubscribedMessage(async (thread, message, context) => {
      try {
        await this.onMessages(thread, [...(context?.skipped ?? []), message]);
      } catch (err) {
        console.error("[openxyz] onMessages failed", err);
      }
    });
    // Catch-all pattern — fires for unsubscribed non-DM non-mention messages
    // (typically random group chatter). Channel `reply()` decides whether to
    // engage; returning `{}` stays silent.
    chat.onNewMessage(/.+/, async (thread, message, context) => {
      try {
        await this.onMessages(thread, [...(context?.skipped ?? []), message]);
      } catch (err) {
        console.error("[openxyz] onMessages failed", err);
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

  /**
   * Handles a debounce-window batch of messages as one agent turn. The last
   * element is the triggering message (the one chat-sdk dispatched on);
   * anything earlier is `context.skipped` from `queue-debounce`, folded into
   * the same LLM call.
   *
   * `channel.reply()` runs over every message so allowlist / agent-routing
   * gates apply uniformly — without this, a non-allowlisted author's message
   * (group chat, mixed debounce window) would ride in on an allowlisted
   * trigger. The last message's reply drives typing/reaction/agent (it's the
   * one chat-sdk dispatched on); only messages whose routing resolves to the
   * same agent are kept (prevents cross-agent leakage, e.g. guest messages
   * folded into an auto turn).
   */
  async onMessages(thread: Thread, messages: ChatSdkMessage[]): Promise<void> {
    if (messages.length === 0) return;

    await thread.subscribe();
    const channel = this.runtime.channels[thread.adapter.name];
    if (!channel) {
      throw new Error(`[openxyz] no channel config for adapter "${thread.adapter.name}"`);
    }

    const actions = await Promise.all(
      messages.map(async (message) => ({ message, reply: await channel.reply(thread, message) })),
    );
    const last = actions[actions.length - 1]!;

    // Reactions fire per-message — every incoming message with a
    // `reply.reaction` gets its own emoji on its own message. Fire-and-
    // forget; a single failed reaction can't block the turn.
    for (const { message, reply } of actions) {
      if (!reply.reaction) continue;
      thread.adapter
        .addReaction(thread.id, message.id, reply.reaction)
        .catch((err) => console.warn("[openxyz] addReaction failed", err));
    }

    // Typing indicator fires once, keyed off the last reply (the one
    // chat-sdk actually dispatched on). Multiple `startTyping` calls would
    // race and flicker the indicator.
    if (last.reply.typing) {
      const status = typeof last.reply.typing === "string" ? last.reply.typing : undefined;
      thread.startTyping(status).catch((err) => console.warn("[openxyz] startTyping failed", err));
    }

    if (!last.reply.agent) return;

    // Messages that route to a different agent than the trigger (or to no
    // agent at all) get dropped here. Happens in mixed-author debounce
    // windows — e.g. a guest-user message lands alongside an allowlisted
    // user's trigger (mnemonic/091). Surface it: the dropped message won't
    // be answered, and the author might wonder why.
    const routed: ChatSdkMessage[] = [];
    const dropped: Array<{ message: ChatSdkMessage; agent: string | undefined }> = [];
    for (const { message, reply } of actions) {
      if (reply.agent === last.reply.agent) routed.push(message);
      else dropped.push({ message, agent: reply.agent });
    }
    if (dropped.length > 0) {
      console.warn(
        `[openxyz] ${dropped.length}/${actions.length} message(s) arrived together but routed to a different agent than the trigger "${last.reply.agent}" — dropping: ${dropped
          .map(({ message, agent }) => `msg ${message.id} → ${agent ?? "<no agent>"}`)
          .join(", ")}`,
      );
    }

    // Pre-turn refresh — drives sync down remote state (git pull, etc.)
    // before the agent runs. Failures mean the drive is stale; the agent
    // still runs against whatever state the drive already had, but the user
    // needs to know we couldn't fetch fresh data (their edits might collide
    // on `commit` later). Surface with the mount point so they can tell
    // which drive failed.
    for (const [mountPoint, drive] of Object.entries(this.runtime.drives)) {
      if (!drive.refresh) continue;
      try {
        await drive.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[openxyz] drive.refresh failed for ${mountPoint}: ${msg}`);
        await thread
          .post(`⚠️ \`${mountPoint}\` — ${msg}`)
          .catch((e) => console.warn(`[openxyz] drive error post failed`, e));
      }
    }

    const agent = await this.agentFactory.create(last.reply.agent);
    // Agent owns the turn from here: channel resolution (systemMessage +
    // toModelMessage + getSession in parallel), session.append(user),
    // between-turn compaction, stream, per-step session persistence,
    // mid-turn prompt compaction, and thread.post. Errors are caught inside
    // and surfaced as a fallback post, so drive.commit below always runs.
    await agent.run({ channel, thread, messages: routed });

    // Post-turn commit — writable drives flush edits (git commit + push, etc.)
    // Unlike `refresh`, `commit` failures ARE user-facing: edits didn't make
    // it to the remote, the user needs to know. Drive throws a descriptive
    // message; runtime prefixes with the mount point so the user can tell
    // which drive failed when multiple are mounted.
    for (const [mountPoint, drive] of Object.entries(this.runtime.drives)) {
      if (!drive.commit) continue;
      try {
        await drive.commit();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[openxyz] drive.commit failed for ${mountPoint}: ${msg}`);
        await thread
          .post(`⚠️ \`${mountPoint}\` — ${msg}`)
          .catch((e) => console.warn(`[openxyz] drive error post failed`, e));
      }
    }
  }

  async stop(): Promise<void> {
    await this.#chat?.shutdown();
    const cleanup = this.runtime.cleanup;
    if (cleanup && cleanup.length > 0) {
      await Promise.allSettled(cleanup.map((fn) => fn()));
    }
  }
}
