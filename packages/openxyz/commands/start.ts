import { Command } from "commander";
import { createInterface } from "node:readline/promises";

export default new Command("start").option("-p, --port <port>", "Port to listen on").action(action);

async function action(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // TODO: wire streamText() from "ai" with provider + tools + VFS (see working/017, working/018)
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    if (text === "/quit") break;
    console.log(text);
  }
  rl.close();
}

// TODO(?): detect isTTY and decide whether to open tui channel.
