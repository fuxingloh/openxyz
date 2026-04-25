import { Chat } from "chat";
import type { Message as ChatSdkMessage, MessageContext, StateAdapter } from "chat";
import type { ModelMessage, Tool } from "ai";
import { flattenUserMessage, type Channel, type Thread } from "./channels";
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
      // TODO(?): maybe rename to "coalescing"
      concurrency: { strategy: "queue-debounce", debounceMs: 500 },
      userName: "openxyz",
      logger: "info",
      fallbackStreamingPlaceholderText: null,
    });

    // chat-sdk dispatch is tiered with early returns (mnemonic/059). Fan
    // every tier into a single `onMessage` so channel files own the routing
    // decision via `reply()` regardless of which tier chat-sdk picked.
    // Handlers await — serverless invocations run one message at a time, so
    // the LockError risk from mnemonic/004 doesn't apply. Awaiting keeps
    // the Vercel function alive through the full flow instead of getting
    // cut short and redispatched via Redis.
    // `onDirectMessage` is the only 4-arg tier — `(thread, message, channel,
    // context)`. The other three are `(thread, message, context)`.
    chat.onDirectMessage((thread, message, _channel, context) => this.onMessage(thread, message, context));
    chat.onNewMention((thread, message, context) => this.onMessage(thread, message, context));
    chat.onSubscribedMessage((thread, message, context) => this.onMessage(thread, message, context));
    // Catch-all — fires for unsubscribed non-DM non-mention messages
    // (typically random group chatter). `channel.reply()` returning `{}`
    // stays silent.
    chat.onNewMessage(/.+/, (thread, message, context) => this.onMessage(thread, message, context));

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
   * Messaging layer entry point — owns the full path from raw chat-sdk
   * webhook callback to a single ready-to-run user turn.
   *
   * `message` is the triggering message (the one chat-sdk dispatched on);
   * `context.skipped` is everything `queue-debounce` (mnemonic/097)
   * collapsed in the same window. The two are folded together, sorted into
   * send order, run through `channel.reply()` per message (so allowlist /
   * agent-routing gates apply uniformly — without this, a non-allowlisted
   * author's message in a mixed-author burst would ride in on an
   * allowlisted trigger), then converted to a single merged
   * `UserModelMessage` via `toModelMessage` + `flattenUserMessage`. The LLM
   * sees one coherent user turn, not N consecutive user messages.
   *
   * Reactions fire per-message; typing fires once on the last reply (the
   * one chat-sdk dispatched on). Only messages whose routing resolves to
   * the same agent are kept (prevents cross-agent leakage in mixed-author
   * windows, e.g. guest messages folded into an `auto` turn — mnemonic/091).
   *
   * Hands off to `dispatch` once an agent + merged message are resolved.
   * Errors are caught + logged here so a thrown handler never reaches
   * chat-sdk's `processMessage` — keeps log lines clean and prefixed.
   */
  async onMessage(thread: Thread, message: ChatSdkMessage, context?: MessageContext): Promise<void> {
    await thread.subscribe();
    const channel = this.runtime.channels[thread.adapter.name];
    if (!channel) {
      throw new Error(`[openxyz] no channel config for adapter "${thread.adapter.name}"`);
    }

    // Webhook arrival reflects whichever request hit the state-adapter
    // `enqueue` first — a network race, not the user's send order. Each
    // channel knows its own platform's send-order semantics (e.g. Telegram
    // tiebreaks 1s `dateSent` ties on the monotonic per-chat message_id),
    // so let it sort.
    const messages = channel.sortMessages([...(context?.skipped ?? []), message]);

    const actions = await Promise.all(
      messages.map(async (m) => ({ message: m, reply: await channel.reply(thread, m) })),
    );

    // Reactions fire per-message regardless of `reply` — a template can
    // ack with `{ reply: false, reaction: "👀" }` to say "I see you, not
    // engaging." Fire-and-forget; a single failed reaction can't block
    // the turn.
    for (const { message: m, reply } of actions) {
      if (!reply.reaction) continue;
      thread.adapter
        .addReaction(thread.id, m.id, reply.reaction)
        .catch((err) => console.warn("[openxyz] addReaction failed", err));
    }

    const routed = actions.filter((a) => a.reply.reply).map((a) => a.message);
    if (routed.length === 0) return;

    // Typing indicator fires once now that we know an agent will run.
    // Fire-and-forget; a single failed call can't block the turn.
    thread.startTyping().catch((err) => console.warn("[openxyz] startTyping failed", err));

    // Per-message → UserModelMessage (preserves Telegram reply_to/
    // forwarded XML annotations, Slack thread refs, etc.) then fold into
    // ONE turn for the LLM. N consecutive user messages without an
    // assistant in between read as "user is still typing" to the model
    // (the `1` `+` `2` `=?` burst gets "want me to save that?" instead of
    // `3`). Merging here keeps `dispatch` and `agent.run` agnostic of how
    // the burst was assembled.
    const userMessages = await Promise.all(routed.map((m) => channel.toModelMessage(thread, m)));
    const merged = flattenUserMessage(userMessages);

    await this.dispatch({ thread, channel, message: merged });
  }

  /**
   * Agentic layer — pure agent invocation wrapped by drive lifecycle. No
   * platform-side acks, no routing decisions; everything messaging is
   * already settled by `onMessage`. The agent name comes from `channel.agent`.
   *
   * Drive `refresh` happens before the agent runs; `commit` happens after.
   * `commit` always runs even if the agent errored — `agent.run` catches
   * its own failures and surfaces them as a fallback `thread.post`, so
   * we don't lose drive writes to a stack-unwind.
   */
  async dispatch(input: {
    channel: Channel;
    thread: Thread;
    /** The merged user turn — already folded from the burst by `onMessage`. */
    message: ModelMessage;
  }): Promise<void> {
    const { thread, channel, message } = input;

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

    const agent = await this.agentFactory.create(channel.agent);
    // Agent owns the turn from here: channel resolution (systemMessage +
    // getSession in parallel), session.append(merged user turn), between-
    // turn compaction, stream, per-step session persistence, mid-turn
    // prompt compaction, and thread.post. The user message has already
    // been built + merged by `#dispatch`.
    // Errors are caught inside and surfaced as a fallback post, so
    // drive.commit below always runs.
    await agent.run({ channel, thread, message });

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
