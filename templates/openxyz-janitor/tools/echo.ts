import { tool, z } from "openxyz/tools";

export default tool({
  description: "Test echo tool",
  inputSchema: z.object({
    text: z.string().describe('Text to echo back with `"` applied.'),
  }),
  execute: async ({ text }) => `"${text}"`,
});
