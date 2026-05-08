import { env } from "openxyz/env";
import bedrock from "openxyz/models/providers/amazon-bedrock";
import openrouter from "openxyz/models/providers/openrouter";

export default async function auto() {
  const model = env.OPENXYZ_MODEL.toString();
  const sep = model.indexOf("/");
  const provider = sep === -1 ? model : model.slice(0, sep);
  const modelId = sep === -1 ? "" : model.slice(sep + 1);

  if (provider === "amazon-bedrock") return bedrock(modelId);
  if (provider === "openrouter") return openrouter(modelId);
  throw new Error(`Unsupported OPENXYZ_MODEL provider: ${provider} (supported: amazon-bedrock, openrouter)`);
}
