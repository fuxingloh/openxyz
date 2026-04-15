import type { AgentDef } from "../factory";

// language=Markdown
const prompt = ``.trim();

const auto: AgentDef = {
  name: "auto",
  description: "General-purpose agent for multi-step tasks",
  filesystem: "read-write",
  prompt,
};

export default auto;
