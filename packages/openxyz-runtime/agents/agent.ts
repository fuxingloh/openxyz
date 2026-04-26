import {
  ToolLoopAgent,
  stepCountIs,
  type GenerateTextResult,
  type ModelMessage,
  type SystemModelMessage,
  type Tool,
} from "ai";
import { estimateTokens, type Channel, type Message, type Session, type Thread } from "../channels";
import type { Model } from "../model";
import type { SkillDef } from "../tools/skill";
import type { AgentDef, AgentFactory } from "./factory";
import { splitOnFinishStep } from "./split-stream";

// ─────────────────────────────────────────────────────────────────────────
// Token-budget constants. Reserve-based (mnemonic/099 — opencode pattern,
// extended in mnemonic/101 to prefer explicit `limit.input`):
//
//   Compaction trigger (pre-stream + mid-stream, same threshold):
//     if limit.input is set:                            ← provider-declared
//       #compactThreshold = max(1, limit.input − COMPACT_INPUT_BUFFER)
//       → input already excludes output; only subtract a small absolute
//         buffer for tool-call round-trip overhead + bytes/4 drift.
//     else:                                             ← derive from context
//       reserve  = min(COMPACT_CONTEXT_RESERVE, limit.output ?? COMPACT_CONTEXT_RESERVE)
//       #compactThreshold = max(1, limit.context − reserve)
//       → reserve output room + drift buffer in one slot, since output
//         hasn't been carved upstream.
//
//   Compact-agent input cap (capacity of the compact agent ITSELF):
//     #compactInputCap = ⌊COMPACT_INPUT_RATIO × limit.context⌋
//     → orthogonal to WHEN we compact — this is what the compact agent
//       can chew in one `generate()` call without blowing its own window.
//
// Concrete per-model (assumes models.dev populates `input` + `output`):
//
//   model            | context | input   | output | threshold | inputCap
//   -----------------|---------|---------|--------|-----------|---------
//   tiny (no input)  |     32K |    —    |     4K |      28K  |     24K
//   Sonnet 4.6       |    200K |   200K  |     8K |     180K  |    150K
//   Opus 4.7 (1M)    |      1M |     1M  |    32K |     980K  |    750K
//   unknown output   |      1M |    —    |     —  |     960K  |    750K
//
// Headroom:
//   • `input` path: leaves COMPACT_INPUT_BUFFER (20K) for drift + tool
//     round-trip. Output carve-out trusted to the provider's declared
//     `input`. No double-counting.
//   • `context` path: reserves `min(40K, output)` for the response. Used
//     when `input` is unknown — conservative since we don't know how the
//     provider splits the window.
//   • #compactInputCap: what the compact agent can absorb in one call.
//     On big models with high thresholds, compact-input cap < threshold
//     is fine — the `toSummarize` gets hardTruncate'd before handoff,
//     dropping oldest content (which is typically already pruned).
//   • Model ceiling is the hard wall nothing gets past.
//
// Pathological edge case: `context < reserve` or `input < buffer` → threshold
// clamps to 1 via `max(1, …)` → every turn compacts. Workaround: template
// sets `limit.output` / `limit.input` to something sane. Won't happen on
// any shipped provider.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Reserve — target headroom when deriving threshold from `limit.context`
 * (i.e. `limit.input` is not set). Sized so the model has room to emit
 * its next response + a tool-call/tool-result round-trip without the turn
 * blowing the window.
 *
 * Derivation (context path only):
 *   reserve = min(COMPACT_CONTEXT_RESERVE, limit.output ?? COMPACT_CONTEXT_RESERVE)
 *   #compactThreshold = max(1, limit.context − reserve)
 *
 * The `min(...)` with `output` caps the reserve at the model's actual
 * max-output capacity — no point reserving 40K on a model that only emits
 * 8K. Matches opencode's `reserved = min(COMPACTION_BUFFER, maxOutputTokens)`
 * (mnemonic/099, opencode `overflow.ts:17`).
 *
 * Not used on the `input` path — when a provider declares `limit.input`,
 * output is already carved out upstream and only `COMPACT_INPUT_BUFFER`
 * applies (mnemonic/101 addendum).
 *
 * Between-turn trigger (pre-stream, once per turn — `#compactSession`):
 *   estimateTokens(session) × SAFETY_MARGIN  ≥  #compactThreshold
 *
 * Mid-turn trigger (every step — `#maybeCompactPrompt`):
 *   estimateTokens(effective) × SAFETY_MARGIN  ≥  #compactThreshold
 *
 *   where effective = fence
 *                       ? [fence.summary, ...messages[fence.untilIdx..]]
 *                       : messages
 */
const COMPACT_CONTEXT_RESERVE = 40_000;

/**
 * Small absolute buffer subtracted from `limit.input` when the provider
 * declares it explicitly (mnemonic/101 addendum). Covers:
 *   - tool-call / tool-result round-trip overhead for the step after
 *     the compaction fires
 *   - bytes/4 tokenizer drift on tool-heavy transcripts (complements
 *     the `SAFETY_MARGIN = 1.2` multiplier at comparison time)
 *
 * Matches opencode's `COMPACTION_BUFFER = 20_000` (mnemonic/099,
 * `overflow.ts:6`). Fixed absolute rather than a % — round-trip overhead
 * and estimate drift are roughly constant regardless of model size.
 */
const COMPACT_INPUT_BUFFER = 20_000;

/**
 * Compact-agent input ratio — fraction of the model's context window the
 * compact agent itself is allowed to receive. The compact agent runs via
 * `generate()` (no `prepareStep`, no self-compaction), so feeding it a
 * full-context prompt would blow its own window.
 *
 * Per-Agent derivation (in the constructor):
 *   #compactInputCap = ⌊context × COMPACT_INPUT_RATIO⌋
 *                    = ⌊context × 0.75⌋
 *
 * 0.75 leaves `context × 0.25` headroom for the compact agent's own system
 * prompt + summarization request. Applied before handoff:
 *
 *   if estimateTokens(toSummarize) > #compactInputCap
 *       → toSummarize = hardTruncate(toSummarize, #compactInputCap)
 *
 * With reserve-based `#compactThreshold`, `toSummarize` on big-context
 * models may exceed this cap (e.g. 968K threshold > 750K cap on a 1M
 * model). `hardTruncate` drops the oldest content — typically already
 * pruned via `Session.append` (mnemonic/083), so the loss is minimal.
 */
const COMPACT_INPUT_RATIO = 0.75;

/**
 * Compensates for `bytes/4` heuristic underestimate on dense content — code,
 * JSON, tool-call serializations (mnemonic/087). Applied at every threshold
 * comparison: `estimateTokens(...) * SAFETY_MARGIN  {>=,<}  THRESHOLD`. A
 * real tokenizer would give exact counts; 1.2 eats the 15-25% gap that
 * `bytes/4` can undercount on tool-heavy transcripts.
 *
 * Also used to derive the hard-truncate budget during mid-turn runaway:
 *   budget = ⌊#compactThreshold / SAFETY_MARGIN⌋
 */
const SAFETY_MARGIN = 1.2;

/**
 * Target size of the tail the mid-turn fence keeps verbatim. Everything
 * older gets folded into the summary.
 *
 *   target = max(1, messages.length - MID_TURN_PRESERVE_TAIL)
 *          = max(1, messages.length - 20)
 *   newCut = safeBoundary(messages, target)   ← snaps forward past tool pairs
 *
 * Fence must advance strictly forward — if `newCut ≤ fence.untilIdx` the
 * tail itself is the problem and we hard-truncate instead.
 *
 * Count-based (not token-based) by design: protects continuity of the
 * current task regardless of message size. Expanding with context scaling
 * would preserve more messages on bigger-context models, which isn't what
 * we want — recent reasoning is recent reasoning.
 */
const MID_TURN_PRESERVE_TAIL = 20;

/**
 * Tool-loop step budget — runaway safety net. Two separate effects:
 *
 *   1. Hard stop via `stopWhen: stepCountIs(MAX_STEPS)` — the loop exits
 *      after step 100 finishes, no matter what.
 *
 *   2. Final-step guard in `#prepareStep`:
 *        trigger:  args.stepNumber  ≥  MAX_STEPS - 1
 *                  args.stepNumber  ≥  99
 *        effect:   force `toolChoice: "none"` + inject a "wrap up, no more
 *                  tools" system msg so the agent emits a clean text reply
 *                  instead of cutting off mid-tool-call on step 100.
 *
 * 100 is "something is very wrong" territory; normal turns finish in 1-15.
 */
const MAX_STEPS = 100;

/**
 * Runtime agent — wraps an `ai` SDK `ToolLoopAgent` with:
 *  - between-turn session compaction (keeps next-turn prompt cheap)
 *  - mid-turn prompt compaction (keeps THIS turn alive past model ceiling)
 *  - max-step guard forcing a text-only summary on the final step
 *
 * Session persistence is one append per turn — user messages appended at
 * `run()` start, agent response messages appended after the stream settles.
 * Mid-turn crashes lose the turn's work; traded per-step crash-recovery for
 * simpler semantics and N× fewer state round-trips per turn.
 *
 * Instances are turn-scoped: the compaction fence lives in the instance and
 * is only safe for one concurrent `run()`. `openxyz.ts#onMessages` creates a
 * fresh agent per incoming message, so reentrancy isn't a concern.
 *
 * `generate()` is the no-frills one-shot path — sub-agents spawned via the
 * `delegate` tool + the `compact` agent itself go through it, so they don't
 * pay the session/thread wiring cost and can't recursively compact.
 */
export class Agent {
  readonly name: string;
  readonly #factory: AgentFactory;
  readonly #inner: ToolLoopAgent;

  /**
   * Compaction trigger for both between-turn and mid-turn paths. Two-path
   * derivation at construction:
   *   - `limit.input − COMPACT_INPUT_BUFFER` when `input` is declared
   *   - `limit.context − min(COMPACT_CONTEXT_RESERVE, output ?? COMPACT_CONTEXT_RESERVE)`
   *     otherwise
   * See the constant block header for rationale (no double-counting of
   * output when provider already carves it out).
   */
  readonly #compactThreshold: number;

  /**
   * Cap on compact-agent input, scaled from `config.model.limit.context` at
   * construction. See the constant block header for the derivation formula.
   * Orthogonal to `#compactThreshold` — this is what the compact agent
   * ITSELF can chew in one `generate()` call.
   */
  readonly #compactInputCap: number;

  /**
   * Per-turn fence tracking the summary-replacement window. Undefined outside
   * a `run()` call. Advances forward only; every `prepareStep` projects
   * `[summary, ...messages.slice(untilIdx)]` so each step sees the compacted
   * prompt even though `prepareStep.messages` is a per-step override (see
   * `ai/.../stream-text.ts:1545` — stepInputMessages rebuilds each step).
   */
  #fence: { summary: ModelMessage; untilIdx: number } | undefined;

  constructor(config: {
    def: AgentDef;
    factory: AgentFactory;
    /** Canonical runtime model — `raw` + `systemPrompt` + `limit`. */
    model: Model;
    tools: Record<string, Tool>;
    skills: SkillDef[];
    /**
     * Project-wide markdown files (AGENTS.md today; USER.md, MEMORY.md,
     * BOOTSTRAP.md, HEARTBEAT.md under mnemonic/039). Passed through as the
     * whole bag so Agent can opt into new entries without a factory change.
     * Shape mirrors `OpenXyzRuntime.mds` — keep them in sync.
     */
    mds?: { agents?: string };
  }) {
    this.name = config.def.name;
    this.#factory = config.factory;

    // Two-path threshold (mnemonic/101):
    //   - `limit.input` declared → trust it as the input ceiling, subtract
    //     only COMPACT_INPUT_BUFFER for tool-round-trip + drift. Output is
    //     already carved out by the provider; no double-counting.
    //   - else → derive from context, reserving output room + drift in one
    //     slot (`min(40K, output ?? 40K)`).
    const context = config.model.limit.context;
    const input = config.model.limit.input;
    this.#compactThreshold =
      input !== undefined
        ? Math.max(1, input - COMPACT_INPUT_BUFFER)
        : Math.max(
            1,
            context - Math.min(COMPACT_CONTEXT_RESERVE, config.model.limit.output ?? COMPACT_CONTEXT_RESERVE),
          );
    this.#compactInputCap = Math.floor(context * COMPACT_INPUT_RATIO);

    this.#inner = new ToolLoopAgent({
      model: config.model.raw,
      instructions: {
        role: "system" as const,
        content: buildSystemPrompt({
          systemPrompt: config.model.systemPrompt,
          tools: config.tools,
          skills: config.skills,
          def: config.def,
          projectInstructions: config.mds?.agents,
        }),
      },
      tools: config.tools,
      stopWhen: stepCountIs(MAX_STEPS),
      prepareStep: async (args) => this.#prepareStep(args),
    });
  }

  /**
   * One-shot generation — no session, no streaming, no compaction. Used by
   * the `delegate` tool for sub-agents and by `#compactSession` /
   * `#maybeCompactPrompt` to call the `compact` agent.
   */
  async generate(opts: {
    prompt: string | ModelMessage[];
    abortSignal?: AbortSignal;
  }): Promise<GenerateTextResult<any, any>> {
    return this.#inner.generate(opts);
  }

  /**
   * Top-level turn — drives the full incoming-message flow:
   *   channel.getSystemMessage + getSession (parallel fetch) → persist
   *   user turn → compact session if over threshold → stream → per-step
   *   append → post to thread. Errors are caught and surfaced as a
   *   fallback thread post so the caller (`OpenXyz.dispatch`) can still
   *   run drive.commit after `run()` returns.
   *
   * `messages` is the user turn — `OpenXyz.onMessage` ran the
   * `queue-debounce` (mnemonic/097) burst through `channel.toModelMessages`
   * and passes the array through. Per-platform-message annotation stays on
   * each entry; the LLM sees N consecutive user messages.
   */
  async run(input: { channel: Channel; thread: Thread; messages: ModelMessage[] }): Promise<void> {
    const { channel, thread, messages } = input;

    // Channel decides session scope (thread-scoped by default, channel-
    // scoped for Telegram groups, etc.). History lives in session, not the
    // chat-sdk thread (mnemonic/081).
    const [system, session] = await Promise.all([channel.getSystemMessage(thread), channel.getSession(thread)]);

    await session.append(messages);
    // TODO(?): move this to Session.compact() <- doesn't care will just run context
    //   then here is if (input > input limits) { then compact }
    await this.#compactSession(session, thread);

    const history = await session.messages();
    // System before conversation — Bedrock and some other providers reject
    // system messages interleaved between user/assistant turns. Per-message
    // env annotations live on the user messages themselves (channel concern).
    const prompt: ModelMessage[] = [system, ...history];

    this.#fence = undefined;

    try {
      const result = await this.#inner.stream({ prompt });
      // Consume fullStream first (renders to chat-sdk thread = UI ledger), then
      // await response.messages to capture the full agent ledger. AI SDK ties
      // the two together — reading either consumes the stream — so the
      // ordering is load-bearing. One append per turn; crash mid-stream loses
      // the turn's work, but the state round-trips collapse from N (one per
      // step) down to one.
      //
      // Split on `finish-step` so each LLM step renders as its own chat
      // bubble (mnemonic/104) — the natural rhythm of "ack → tool → result"
      // becomes visible burst-text instead of one growing message. Re-fire
      // the typing indicator after each bubble to cover the next step's
      // tool-execution gap — Telegram's sendChatAction expires ~5s
      // (mnemonic/100), and without a heartbeat the recipient sees nothing
      // while tools run between text-emitting steps.
      for await (const subStream of splitOnFinishStep(result.fullStream)) {
        await thread.post(subStream);
        await thread.startTyping().catch(() => {});
      }
      const response = await result.response;
      await session.append(response.messages as ModelMessage[]);
    } catch (err) {
      console.error(`[openxyz] agent "${this.name}" run failed`, err);
      const msg = err instanceof Error ? err.message : String(err);
      await thread.post(`⚠️ Error generating reply: ${msg}`).catch((e) => {
        console.error("[openxyz] fallback error post failed", e);
      });
    } finally {
      this.#fence = undefined;
    }
  }

  async #prepareStep(args: { stepNumber: number; messages: ModelMessage[] }): Promise<
    | {
        toolChoice?: "none";
        system?: SystemModelMessage[];
        messages?: ModelMessage[];
      }
    | undefined
  > {
    // Final-step guard — force text-only summary reply so the loop doesn't
    // cut off mid-tool-call when it hits the step budget.
    if (args.stepNumber >= MAX_STEPS - 1) {
      return {
        toolChoice: "none" as const,
        system: [
          {
            role: "system" as const,
            content: `You've reached the maximum step budget (${MAX_STEPS}). Summarize what you did and respond to the user without calling any more tools.`,
          },
        ],
      };
    }
    return this.#maybeCompactPrompt(args.messages);
  }

  /**
   * Mid-turn prompt compaction. Rewrites the in-flight messages without
   * touching session storage. On-disk session is persisted step-by-step via
   * `onStepFinish` in `run()`; prompt compaction is orthogonal — it keeps
   * the turn alive when tool-loop accumulation approaches the model ceiling.
   */
  async #maybeCompactPrompt(messages: ModelMessage[]): Promise<{ messages: ModelMessage[] } | undefined> {
    const project = () => (this.#fence ? [this.#fence.summary, ...messages.slice(this.#fence.untilIdx)] : messages);

    const effective = project();
    if (estimateTokens(effective) * SAFETY_MARGIN < this.#compactThreshold) {
      return this.#fence ? { messages: effective } : undefined;
    }

    const hardBudget = Math.floor(this.#compactThreshold / SAFETY_MARGIN);

    // Over budget — advance the fence. Target the tail length, then snap
    // forward to the next tool-pair-safe index so we never orphan results.
    const target = Math.max(1, messages.length - MID_TURN_PRESERVE_TAIL);
    const newCut = safeBoundary(messages, target);

    // Fence must advance. If it can't, the tail itself is the budget problem
    // — hard truncate the projected prompt as last resort.
    if (this.#fence && newCut <= this.#fence.untilIdx) {
      return { messages: hardTruncate(effective, hardBudget) };
    }
    if (newCut <= 0) return undefined;

    let toSummarize = messages.slice(0, newCut);
    if (estimateTokens(toSummarize) > this.#compactInputCap) {
      toSummarize = hardTruncate(toSummarize, this.#compactInputCap);
    }

    try {
      const compact = await this.#factory.create("compact", { delegate: false });
      const result = await compact.generate({
        prompt: [
          ...toSummarize,
          {
            role: "user" as const,
            content: "Summarize this conversation following your instructions.",
          },
        ],
      });
      const summary: ModelMessage = {
        role: "system",
        content: `## Prior conversation summary (compacted mid-turn)\n\n${result.text}`,
      };
      this.#fence = { summary, untilIdx: newCut };
      const next = [summary, ...messages.slice(newCut)];
      // Runaway guard — if summary + preserved still blows budget, hard
      // truncate rather than looping indefinitely.
      if (estimateTokens(next) * SAFETY_MARGIN >= this.#compactThreshold) {
        return { messages: hardTruncate(next, hardBudget) };
      }
      return { messages: next };
    } catch (err) {
      console.warn("[openxyz] mid-turn compaction failed, hard-truncating", err);
      return { messages: hardTruncate(effective, hardBudget) };
    }
  }

  /**
   * Between-turn session compaction — replaces older turns with a summary
   * on disk. Preserves last two user turns verbatim (continuity for the
   * current reply). Fail-open: if the compact agent errors, leave the
   * session untouched and proceed with the oversized prompt.
   */
  async #compactSession(session: Session, thread: Thread): Promise<void> {
    const messages = await session.messages();
    if (estimateTokens(messages) * SAFETY_MARGIN < this.#compactThreshold) return;

    // Preserve last 2 user turns verbatim. User messages act as turn
    // boundaries; slicing at the second-to-last user index captures two
    // full round-trips (user + assistant + tool-calls + tool-results).
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
      const compact = await this.#factory.create("compact", { delegate: false });
      let input = toSummarize;
      if (estimateTokens(input) > this.#compactInputCap) {
        input = hardTruncate(input, this.#compactInputCap);
      }
      const result = await compact.generate({
        prompt: [
          ...input,
          {
            role: "user" as const,
            content: "Summarize this entire conversation following your instructions.",
          },
        ],
      });
      const summary: ModelMessage = {
        role: "system",
        content: `## Prior conversation summary\n\n${result.text}`,
      };
      await session.replace([summary, ...toPreserve]);

      const nextTokens = estimateTokens(await session.messages());
      if (nextTokens * SAFETY_MARGIN >= this.#compactThreshold) {
        console.error(
          `[openxyz] session compaction left ${nextTokens} tokens (×${SAFETY_MARGIN} margin, threshold ${this.#compactThreshold}) — proceeding with oversized prompt`,
        );
      }
    } catch (err) {
      console.warn("[openxyz] session compaction failed, continuing with oversized session", err);
    } finally {
      if (placeholder) {
        await placeholder.delete().catch((err) => console.warn("[openxyz] compaction placeholder delete failed", err));
      }
    }
  }
}

/**
 * Walk from `start` forward to the nearest slice-safe index. An index `i` is
 * safe when `messages.slice(0, i)` ends at a complete turn and
 * `messages.slice(i)` starts at a shape the LLM will accept — no orphan
 * tool-result messages, no unresolved tool-calls at the split.
 *
 * Two rules:
 *  1. Never cut inside a run of `tool`-role messages (they belong to the
 *     preceding assistant's tool-calls).
 *  2. Never cut right after an assistant-with-tool-calls unless all its
 *     results have been consumed; keep advancing through them.
 *
 * Exported for testing — treat as internal.
 */
export function safeBoundary(messages: ModelMessage[], start: number): number {
  let i = Math.max(0, Math.min(start, messages.length));
  while (i < messages.length && messages[i]!.role === "tool") i++;
  while (i < messages.length) {
    const prev = messages[i - 1];
    if (!prev) return i;
    if (prev.role === "assistant" && hasToolCalls(prev)) {
      i++;
      continue;
    }
    return i;
  }
  return messages.length;
}

/**
 * Materialize the full system-message content from the pieces a template
 * yields: the model-family baseline, project AGENTS.md, per-agent body, and
 * structural metadata (skills index, filesystem env). Order matters for
 * prompt caching — stable prefix (model + project) leads so the cache key
 * stays hot across agents sharing a model; per-agent sections trail.
 */
function buildSystemPrompt(config: {
  systemPrompt: string;
  tools: Record<string, Tool>;
  skills: SkillDef[];
  def: AgentDef;
  projectInstructions?: string;
}): string {
  const parts = [config.systemPrompt];

  if (config.projectInstructions) {
    parts.push("## Project Instructions\n\n" + config.projectInstructions.trim());
  }

  // Skills index is only useful when the agent can actually load them — if
  // the `skill` tool was filtered out, drop the section rather than advertise
  // capabilities the agent can't exercise.
  if (config.skills.length > 0 && config.tools["skill"]) {
    parts.push(
      [
        "## Skills",
        "",
        "Skills provide specialized instructions for recurring tasks. When you recognize that a task matches one of the available skills below, use the `skill` tool to load the full instructions before proceeding.",
        "",
        formatSkillsXml(config.skills),
      ].join("\n"),
    );
  }

  // Mount-keyed lookup — the record form is `{ [mountPath]: permission }`
  // with paths starting at `/`. The env line reports `/workspace` access, so
  // match that key. Historical bug: used `"harness"` (pre-rename, mnemonic/078)
  // which could never match a `/`-prefixed key, silently forcing read-write.
  const fs = config.def.filesystem;
  const access = typeof fs === "string" ? fs : (fs?.["/workspace"] ?? "read-write");
  parts.push(["## Environment", "", `- Workspace: /workspace`, `- Filesystem: ${access}`].join("\n"));

  if (config.def.instructions) {
    parts.push(config.def.instructions);
  }

  return parts.join("\n\n");
}

function formatSkillsXml(skills: SkillDef[]): string {
  return [
    "<available_skills>",
    ...skills.map((s) =>
      [`  <skill>`, `    <name>${s.name}</name>`, `    <description>${s.description}</description>`, `  </skill>`].join(
        "\n",
      ),
    ),
    "</available_skills>",
  ].join("\n");
}

function hasToolCalls(msg: ModelMessage): boolean {
  if (msg.role !== "assistant") return false;
  const content = msg.content;
  if (typeof content === "string") return false;
  return content.some((p) => p.type === "tool-call");
}

/**
 * Last-resort truncation — drop oldest messages until under budget, then
 * snap forward to a safe boundary. Used when compaction itself can't shrink
 * the prompt enough (runaway guard) or the compact agent errors mid-turn.
 *
 * Exported for testing — treat as internal.
 */
export function hardTruncate(messages: ModelMessage[], budgetTokens: number): ModelMessage[] {
  if (messages.length === 0) return messages;
  const sizes = messages.map((m) => Math.ceil(JSON.stringify(m).length / 4));
  let total = sizes.reduce((a, b) => a + b, 0);
  let i = 0;
  while (i < messages.length && total > budgetTokens) {
    total -= sizes[i]!;
    i++;
  }
  return messages.slice(safeBoundary(messages, i));
}
