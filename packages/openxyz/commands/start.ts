import { Command } from "commander";
import { createOpencode } from "@opencode-ai/sdk";
import { dirname, join } from "node:path";

// TODO(@fuxingloh): what is the port for...

export default new Command("start").option("-p, --port <port>", "Port to listen on").action(action);

export async function action(options: { port?: string }): Promise<void> {
  const cwd = process.cwd();

  // Resolve the opencode binary from the opencode-ai package so it doesn't need to be in $PATH
  const opencodePkg = import.meta.resolve?.("opencode-ai/package.json") ?? require.resolve("opencode-ai/package.json");
  const opencodeBinDir = join(dirname(opencodePkg.replace("file://", "")), "bin");
  process.env.PATH = `${opencodeBinDir}:${process.env.PATH}`;

  const { client, server } = await createOpencode();

  // client.session.prompt({});

  // Keep the process alive
  await new Promise(() => {});
}
