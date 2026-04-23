import {
  ToolLoopAgent,
  stepCountIs,
  type GenerateTextResult,
  type ModelMessage,
  type SystemModelMessage,
  type Tool,
} from "ai";
import { estimateTokens, type Session, type Thread } from "../channels";
import type { Model } from "../model";
import type { FilesystemConfig } from "../tools/filesystem";
import type { SkillDef } from "../tools/skill";
import type { AgentFactory } from "./factory";

/**
 * Between-turn threshold — session log checked before `agent.stream()` starts.
 * Hitting this means the NEXT prompt is expensive; compaction replaces older
 * turns on disk, affecting cost from the following turn onward.
 */
const BETWEEN_TURN_THRESHOLD = 40_000;

/**
 * Mid-turn threshold — the in-flight prompt checked in `prepareStep`. Hitting
 * this means THIS turn is about to exceed the model's own context window on
 * the next step. Set higher than between-turn because mid-turn compaction
 * costs a step-boundary stall; we only want to fire when the turn is
 * genuinely close to the model's ceiling.
 */
const MID_TURN_THRESHOLD = 140_000;

/** Compensates for bytes/4 underestimate on dense content (mnemonic/087). */
const SAFETY_MARGIN = 1.2;

/**
 * Number of most-recent messages the mid-turn fence tries to keep intact.
 * The actual preserved count floats — `safeBoundary` snaps forward to the
 * next tool-pair-safe index.
 */
const MID_TURN_PRESERVE_TAIL = 20;

/**
 * Cap on the compact agent's own input. `generate()` doesn't self-compact
 * (no `prepareStep` mid-compaction recursion), so feeding it 200K tokens
 * would blow its own context. Hard-truncate before handing off.
 */
const COMPACT_INPUT_CAP = 150_000;

/**
 * Tool-loop step budget — runaway safety net. The final-step guard in
 * `#prepareStep` forces a text-only summary on step `MAX_STEPS - 1` so the
 * agent wraps up cleanly instead of getting cut off mid-tool-call.
 */
const MAX_STEPS = 100;

/**
 * Runtime agent — wraps an `ai` SDK `ToolLoopAgent` with:
 *  - per-step session persistence (crash-safety within a turn)
 *  - between-turn session compaction (keeps next-turn prompt cheap)
 *  - mid-turn prompt compaction (keeps THIS turn alive past model ceiling)
 *  - max-step guard forcing a text-only summary on the final step
 *
 * Instances are turn-scoped: the compaction fence lives in the instance and
 * is only safe for one concurrent `run()`. `openxyz.ts#onMessage` creates a
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
   * Per-turn fence tracking the summary-replacement window. Undefined outside
   * a `run()` call. Advances forward only; every `prepareStep` projects
   * `[summary, ...messages.slice(untilIdx)]` so each step sees the compacted
   * prompt even though `prepareStep.messages` is a per-step override (see
   * `ai/.../stream-text.ts:1545` — stepInputMessages rebuilds each step).
   */
  #fence: { summary: ModelMessage; untilIdx: number } | undefined;

  constructor(config: {
    name: string;
    factory: AgentFactory;
    /** Canonical runtime model — `raw` + `systemPrompt` + `limit`. */
    model: Model;
    tools: Record<string, Tool>;
    skills: SkillDef[];
    filesystem: FilesystemConfig;
    /** Per-agent markdown body (frontmatter's `content`). */
    instructions: string;
    /** Project-wide AGENTS.md content, if any. */
    projectInstructions?: string;
  }) {
    this.name = config.name;
    this.#factory = config.factory;
    this.#inner = new ToolLoopAgent({
      model: config.model.raw,
      instructions: {
        role: "system" as const,
        content: buildSystemPrompt({
          systemPrompt: config.model.systemPrompt,
          tools: config.tools,
          skills: config.skills,
          filesystem: config.filesystem,
          instructions: config.instructions,
          projectInstructions: config.projectInstructions,
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
   * Top-level turn: persist user turn → compact session if over threshold →
   * stream → per-step append → post to thread. Errors are caught and surfaced
   * as a fallback thread post so `onMessage` can still run drive.commit.
   */
  async run(input: {
    system: SystemModelMessage;
    userMessages: ModelMessage[];
    session: Session;
    thread: Thread;
  }): Promise<void> {
    const { system, userMessages, session, thread } = input;

    await session.append(userMessages);
    await this.#compactSession(session, thread);

    const history = await session.messages();
    // System before conversation — Bedrock and some other providers reject
    // system messages interleaved between user/assistant turns. Per-message
    // env annotations live on the user messages themselves (channel concern).
    const prompt: ModelMessage[] = [system, ...history];

    // Per-step persistence: each completed step's messages land in the
    // session log the moment the step finishes. `step.response.messages` is
    // cumulative (ai/.../stream-text.ts:1098 — [...recordedResponseMessages,
    // ...stepMessages]), so slice the delta since the last append.
    let appended = 0;
    this.#fence = undefined;

    try {
      const result = await this.#inner.stream({
        prompt,
        onStepFinish: async (step) => {
          const delta = step.response.messages.slice(appended);
          appended = step.response.messages.length;
          if (delta.length === 0) return;
          try {
            await session.append(delta as ModelMessage[]);
          } catch (err) {
            console.error("[openxyz] per-step session.append failed", err);
          }
        },
      });
      await thread.post(result.fullStream);
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
    if (estimateTokens(effective) * SAFETY_MARGIN < MID_TURN_THRESHOLD) {
      return this.#fence ? { messages: effective } : undefined;
    }

    // Over budget — advance the fence. Target the tail length, then snap
    // forward to the next tool-pair-safe index so we never orphan results.
    const target = Math.max(1, messages.length - MID_TURN_PRESERVE_TAIL);
    const newCut = safeBoundary(messages, target);

    // Fence must advance. If it can't, the tail itself is the budget problem
    // — hard truncate the projected prompt as last resort.
    if (this.#fence && newCut <= this.#fence.untilIdx) {
      return {
        messages: hardTruncate(effective, Math.floor(MID_TURN_THRESHOLD / SAFETY_MARGIN)),
      };
    }
    if (newCut <= 0) return undefined;

    let toSummarize = messages.slice(0, newCut);
    if (estimateTokens(toSummarize) > COMPACT_INPUT_CAP) {
      toSummarize = hardTruncate(toSummarize, COMPACT_INPUT_CAP);
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
      if (estimateTokens(next) * SAFETY_MARGIN >= MID_TURN_THRESHOLD) {
        return {
          messages: hardTruncate(next, Math.floor(MID_TURN_THRESHOLD / SAFETY_MARGIN)),
        };
      }
      return { messages: next };
    } catch (err) {
      console.warn("[openxyz] mid-turn compaction failed, hard-truncating", err);
      return {
        messages: hardTruncate(effective, Math.floor(MID_TURN_THRESHOLD / SAFETY_MARGIN)),
      };
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
    if (estimateTokens(messages) * SAFETY_MARGIN < BETWEEN_TURN_THRESHOLD) return;

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
      if (estimateTokens(input) > COMPACT_INPUT_CAP) {
        input = hardTruncate(input, COMPACT_INPUT_CAP);
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
      if (nextTokens * SAFETY_MARGIN >= BETWEEN_TURN_THRESHOLD) {
        console.error(
          `[openxyz] session compaction left ${nextTokens} tokens (×${SAFETY_MARGIN} margin, threshold ${BETWEEN_TURN_THRESHOLD}) — proceeding with oversized prompt`,
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
  filesystem: FilesystemConfig;
  instructions: string;
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
  const access =
    typeof config.filesystem === "string" ? config.filesystem : (config.filesystem?.["/workspace"] ?? "read-write");
  parts.push(["## Environment", "", `- Workspace: /workspace`, `- Filesystem: ${access}`].join("\n"));

  if (config.instructions) {
    parts.push(config.instructions);
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
