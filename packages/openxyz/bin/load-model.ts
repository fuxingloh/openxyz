import type { LanguageModel } from "ai";
import type { Model } from "@openxyz/runtime/model";
import DEFAULT_SYSTEM_PROMPT from "../models/prompts/system.md" with { type: "text" };

/**
 * Template-author-facing contract for a `models/<name>.ts` file. Any
 * combination works:
 *
 * ```ts
 * // simplest — just ai-sdk, nothing else
 * export default anthropic("claude-sonnet-4-5");
 *
 * // with per-model overrides
 * export default anthropic("claude-sonnet-4-5");
 * export const systemPrompt = "You are a pirate.";
 * export const limit = { context: 200_000 };
 *
 * // factory — default can be a function returning (or async-returning)
 * // the model; named exports still work alongside
 * export default async () => anthropic(await resolveModelId());
 * export const systemPrompt = "…";
 * ```
 *
 * Shipped providers (`packages/openxyz/models/providers/*.ts`) use the
 * factory form and attach `limit` via `Object.assign` on the returned
 * LanguageModel — that "intersection" form is equivalent and takes
 * precedence over module-level named exports.
 */
export type ModelDef = {
  /** LanguageModel or a factory returning one. */
  default: unknown;
  systemPrompt?: string;
  limit?: {
    context?: number;
    /** Max output tokens per response — used for compaction reserve sizing. */
    output?: number;
  };
};

/**
 * Safe lower-bound when a model's context window is unknown — every modern
 * model supports at least this. Matches openclaw's `DEFAULT_CONTEXT_TOKENS`
 * (mnemonic/085 §2). Used only when neither the resolved model nor the
 * module's `limit` named export resolved one.
 */
const DEFAULT_CONTEXT_TOKENS = 200_000;

/**
 * Convert a template's `models/<name>.ts` module into the runtime's
 * canonical `Model` wrapper. Reads `default` (awaiting if it's a factory),
 * plus optional `systemPrompt` / `limit` named exports. If the resolved
 * default itself carries `systemPrompt` / `limit` (intersection form via
 * `Object.assign`), those win over the module's named exports — the
 * resolved value is more specific than the static export.
 *
 * Fills in shipped defaults where both sources are absent: system prompt
 * from `../models/prompts/system.md` (bundled as text), context window
 * from `DEFAULT_CONTEXT_TOKENS`.
 *
 * Runs at the facade boundary — `openxyz start` calls it after
 * `await import(path)`; `openxyz build` code-gens the call into the
 * bundled entrypoint with a namespace import of the model module.
 * Once converted, runtime never touches the raw external form.
 */
export async function loadModel(mod: ModelDef): Promise<Model> {
  const def = mod.default;
  const raw = (typeof def === "function" ? await (def as () => unknown)() : def) as LanguageModel & {
    systemPrompt?: string;
    limit?: { context?: number; output?: number };
  };
  return {
    raw,
    systemPrompt: raw.systemPrompt ?? mod.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    limit: {
      context: raw.limit?.context ?? mod.limit?.context ?? DEFAULT_CONTEXT_TOKENS,
      output: raw.limit?.output ?? mod.limit?.output,
    },
  };
}
