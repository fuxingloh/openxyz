import type { LanguageModel } from "ai";

/**
 * Canonical runtime shape — a resolved ai-sdk `LanguageModel` (`raw`) plus
 * its system prompt and limit metadata. Produced by the facade-layer
 * conversion (`packages/openxyz/bin/load-model.ts`) which accepts either
 * a bare ai-sdk `LanguageModel` or one decorated via `Object.assign(model,
 * { systemPrompt, limit })`, fills in defaults, and hands a fully-
 * materialized Model to the runtime.
 */
export type Model = {
  /** The ai-sdk `LanguageModel` — passed directly to `ToolLoopAgent`. */
  raw: LanguageModel;
  /**
   * Base system prompt for this model. Always resolved (default comes
   * from `openxyz/models/prompts/system.md` shipped by the facade).
   *
   * Per-model override exists because **each model family steers
   * differently**. Claude responds best to XML-tagged structure and
   * conversational framing; GPT-family models take literal instructions
   * and JSON-shaped rules; Gemini tolerates both but biases toward
   * concrete specs; GLM and other local models often want a leaner
   * prompt than Anthropic's paragraph-heavy style. Provider files and
   * templates can attach a tailored `systemPrompt` via
   * `Object.assign(model, { systemPrompt })` to replace the default
   * baseline with something the model family actually handles well.
   *
   * Agent frontmatter and per-turn system messages stack *on top* of
   * this — the model's `systemPrompt` is the stable prefix
   * (cache-friendly), everything else layers after.
   */
  systemPrompt: string;
  /**
   * Model limits sourced from `models.dev/api.json`. Kept for the
   * compaction helper and adjacent budget decisions: `context` tells us
   * the provider's hard ceiling so we can scale thresholds per model
   * when we're ready (mnemonic/084 + mnemonic/087), hard-error early
   * when a prompt would exceed the ceiling, and one day drive cost
   * tracking from `output`. `context` is always resolved (default
   * 200_000 when unknown — openclaw precedent, safe for every modern
   * model).
   */
  limit: {
    context: number;
  };
};
