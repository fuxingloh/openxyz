import { Chat } from "chat";
import type { Message as ChatSdkMessage, StateAdapter } from "chat";
import type { ModelMessage, Tool } from "ai";
import { estimateTokens, type Channel, type Session, type Thread } from "./channels";
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
    // Fan out every incoming-message tier into a single `onMessage` so channel
    // files own the decision via `action()` regardless of how chat-sdk routed.
    // Handlers await — serverless invocations run one message at a time, so the
    // LockError risk from mnemonic/004 (long-running local process with
    // concurrent messages) doesn't apply. Awaiting keeps the Vercel function
    // alive through the full onMessage flow instead of getting cut short and
    // redispatched via Redis.
    // `onDirectMessage` handler signature is `(thread, message, channel, context)` —
    // the only tier with a 4-arg shape. The other three are `(thread, message, context)`.
    chat.onDirectMessage(async (thread, message, _channel, context) => {
      try {
        await this.onMessage(thread, message, context?.skipped ?? []);
      } catch (err) {
        console.error("[openxyz] onMessage failed", err);
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
        await this.onMessage(thread, message, context?.skipped ?? []);
      } catch (err) {
        console.error("[openxyz] onMessage failed", err);
      }
    });
    chat.onSubscribedMessage(async (thread, message, context) => {
      try {
        await this.onMessage(thread, message, context?.skipped ?? []);
      } catch (err) {
        console.error("[openxyz] onMessage failed", err);
      }
    });
    // Catch-all pattern — fires for unsubscribed non-DM non-mention messages
    // (typically random group chatter). Channel `reply()` decides whether to
    // engage; returning `{}` stays silent.
    chat.onNewMessage(/.+/, async (thread, message, context) => {
      try {
        await this.onMessage(thread, message, context?.skipped ?? []);
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

  async onMessage(thread: Thread, message: ChatSdkMessage, skipped: ChatSdkMessage[] = []): Promise<void> {
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

    const agent = await this.agentFactory.create(reply.agent);
    // Channel decides session scope (thread-scoped by default, channel-scoped
    // for Telegram groups, etc.). toModelMessage converts the incoming
    // platform message into a UserModelMessage with any platform-specific
    // annotation. History lives in session, not the chat-sdk thread
    // (mnemonic/081).
    // Fold any `context.skipped` messages (collected by chat-sdk's
    // `queue-debounce` mode — see patches/chat@4.26.0.patch) into the same
    // turn as the latest message. Skipped come first chronologically; the
    // triggering message is last. The agent sees them as N consecutive user
    // turns in one LLM call, not N separate stream invocations.
    const burst = [...skipped, message];
    const [system, userMessages, session] = await Promise.all([
      channel.systemMessage(thread, message),
      Promise.all(burst.map((m) => channel.toModelMessage(thread, m))),
      channel.getSession(thread, message),
    ]);
    await session.append(userMessages);
    // Compact before reading history — if session is over budget, replace
    // older turns with a summary. Fail-open; see mnemonic/084.
    await this.#compactIfNeeded(session, thread);
    const history = await session.messages();
    // System goes before the conversation, not after — Bedrock (and some other providers) reject system
    // messages interleaved between user/assistant turns. Empty content = channel had nothing to say.
    const prompt: ModelMessage[] = [system, ...history];
    const result = await agent.stream({ prompt });
    try {
      // Consume fullStream first (renders to chat-sdk thread = UI ledger), then
      // await response.messages to capture the agent ledger. AI SDK ties the
      // two together — reading either consumes the stream — so this ordering
      // is load-bearing.
      await thread.post(result.fullStream);
      const response = await result.response;
      await session.append(response.messages);
    } catch (err) {
      console.error(`[openxyz] thread.post failed`, err);
      const msg = err instanceof Error ? err.message : String(err);
      await thread.post(`⚠️ Error generating reply: ${msg}`).catch((e) => {
        console.error(`[openxyz] fallback error post failed`, e);
      });
    }

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

  /**
   * Run the `compact` agent over the earlier part of the session log when it
   * exceeds the token budget, replacing those turns with a single system
   * summary. Preserves the last two user turns verbatim (continuity for the
   * current reply). Fail-open: if the compact agent errors, log and leave
   * the session as-is. Posts a user-visible "Compacting…" placeholder
   * (deleted after) so the latency isn't invisible.
   *
   * See mnemonic/084 — TODO tokenizer, TODO per-model `contextLimit`,
   * TODO recursive compaction when one pass doesn't fit under budget.
   */
  async #compactIfNeeded(session: Session, thread: Thread): Promise<void> {
    // Universal threshold — every modern model supports at least this.
    // Intentionally not scaled by model `contextLimit` (mnemonic/087): 40K
    // is plenty for most chat workloads, keeps behaviour predictable, and
    // leaves tokens on the floor only for users who genuinely need long
    // context — they can override per-template when the need appears.
    const COMPACT_THRESHOLD_TOKENS = 40_000;
    // Compensates for `estimateTokens` bytes/4 underestimation on dense
    // content (code, JSON, tool calls). Openclaw's number. Err toward
    // compacting sooner rather than later.
    const SAFETY_MARGIN = 1.2;

    const messages = await session.messages();
    if (estimateTokens(messages) * SAFETY_MARGIN < COMPACT_THRESHOLD_TOKENS) return;

    // Preserve the last 2 user turns verbatim — a "turn" here meaning the
    // user message plus every assistant/tool message that followed it.
    // User-role messages act as turn boundaries in the session log, so
    // slicing at the second-to-last user index captures two full
    // round-trips (prompt + reasoning + tool calls + tool results + text)
    // — not just the user lines. Everything older gets folded into the
    // summary. <3 user messages means the log is too short to yield
    // meaningful compression; skip.
    const userIdxs = messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
    if (userIdxs.length < 3) return;
    const preserveFromIdx = userIdxs[userIdxs.length - 2]!;
    const toSummarize = messages.slice(0, preserveFromIdx);
    const toPreserve = messages.slice(preserveFromIdx);

    const placeholder = await thread.post("Compacting session…").catch((err) => {
      console.warn("[openxyz] compaction placeholder post failed", err);
      return undefined;
    });

    try {
      const compact = await this.agentFactory.create("compact", { delegate: false });
      const result = await compact.generate({
        prompt: [
          ...toSummarize,
          { role: "user" as const, content: "Summarize this entire conversation following your instructions." },
        ],
      });
      const summary: ModelMessage = {
        role: "system",
        content: `## Prior conversation summary\n\n${result.text}`,
      };
      await session.replace([summary, ...toPreserve]);

      // Guard against runaway: if the summary + preserved turns still
      // exceed budget (with the same safety margin), log and proceed. Do
      // not recurse — a bad summary that doesn't shrink would loop forever.
      // TODO(mnemonic/084): recursive compaction or hard truncation when
      // this fires in practice.
      const nextTokens = estimateTokens(await session.messages());
      if (nextTokens * SAFETY_MARGIN >= COMPACT_THRESHOLD_TOKENS) {
        console.error(
          `[openxyz] compaction left session at ${nextTokens} tokens (×${SAFETY_MARGIN} margin, threshold ${COMPACT_THRESHOLD_TOKENS}) — proceeding with oversized prompt`,
        );
      }
    } catch (err) {
      // Fail-open: compaction is best-effort. Log and proceed with the
      // oversized session log. The user's turn still completes.
      console.warn("[openxyz] compaction failed, continuing with oversized session", err);
    } finally {
      if (placeholder) {
        await placeholder.delete().catch((err) => console.warn("[openxyz] compaction placeholder delete failed", err));
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
