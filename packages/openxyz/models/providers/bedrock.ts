import { bedrock as aws } from "@ai-sdk/amazon-bedrock";
import type { LanguageModel } from "ai";

/**
 * Amazon Bedrock model factory. Credentials resolve from the AWS SDK's
 * default credential chain (env, shared config, instance role).
 *
 * Usage: `bedrock("zai.glm-4.7")` — see AWS docs for available model ids.
 */
export default function bedrock(modelId: string): LanguageModel {
  return aws(modelId);
}
