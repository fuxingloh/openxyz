import { join } from "node:path";
import type { Thread, Message, Channel } from "chat";

/**
 * Return value of a channel's `should()` hook. Decides what the harness does
 * with an incoming message.
 *
 * - `Should.respond` — subscribe + run the agent reply flow
 * - `Should.listen` — subscribe so the thread stays warm, but skip the reply
 * - `Should.skip` — ignore entirely (no subscribe, no reply)
 */
export enum Should {
  respond = "respond",
  listen = "listen",
  skip = "skip",
}

export interface MessageContext<TState = Record<string, unknown>> {
  thread: Thread<TState>;
  message: Message;
  channel?: Channel<TState>;
}

export type ShouldFn = (ctx: MessageContext) => Should | Promise<Should>;

export interface ChannelEntry {
  adapter: unknown;
  agent: string;
  should: ShouldFn | undefined;
}

export async function scanChannels(cwd: string): Promise<Record<string, ChannelEntry>> {
  const glob = new Bun.Glob("channels/[!_]*.ts");
  const channels: Record<string, ChannelEntry> = {};

  for await (const rel of glob.scan({ cwd })) {
    const file = rel.split("/").pop()!;
    const name = file.replace(/\.ts$/, "");
    const mod = await import(join(cwd, rel));
    if (!mod.default) {
      console.warn(`[openxyz] channels/${file} has no default export, skipping`);
      continue;
    }
    channels[name] = {
      adapter: mod.default,
      agent: mod.agent ?? "general",
      should: typeof mod.should === "function" ? (mod.should as ShouldFn) : undefined,
    };
  }

  return channels;
}
