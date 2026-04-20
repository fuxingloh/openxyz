import { bedrock as aws } from "@ai-sdk/amazon-bedrock";
import { wrapLanguageModel } from "ai";
import { cacheMiddleware } from "./_cache";
import { lookupLimit } from "./_api";

/**
 * Amazon Bedrock model factory. Credentials resolve from the AWS SDK's
 * default credential chain (env, shared config, instance role). Wrapped
 * with `cacheMiddleware("bedrock")` to stamp `cachePoint` markers on the
 * instructions frame for prompt caching — see `_cache.ts` for the full
 * design notes (TTL, breakpoint placement, prior-art comparison, v2 plan).
 *
 * The marker is wire-protocol-scoped: `cachePoint` is Bedrock's universal
 * cache primitive, applied regardless of which model family sits behind
 * Bedrock (Claude, Nova, Llama, ...). No per-model dispatch needed.
 *
 * `limit` is looked up from `models.dev` for the given modelId. Fail-open:
 * if models.dev is unreachable or the model is unlisted, the field is left
 * undefined and the runtime's universal 40K compaction threshold applies
 * regardless (mnemonic/087). No `systemPrompt` — runtime falls back to
 * its default.
 *
 * Usage: `bedrock("zai.glm-4.7")` — see AWS docs for available model ids.
 */
export default async function bedrock(modelId: string) {
  return Object.assign(wrapLanguageModel({ model: aws(modelId), middleware: cacheMiddleware("bedrock") }), {
    limit: await lookupLimit("amazon-bedrock", modelId),
  });
}
