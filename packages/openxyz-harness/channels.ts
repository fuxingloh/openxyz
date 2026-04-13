import { join } from "node:path";
import type { Thread, Message, Channel } from "chat";

export type ThreadState = {
  summary?: {
    text: string;
    upToMessageId: string;
  };
};

export interface MessageContext {
  thread: Thread<ThreadState>;
  message: Message;
  channel?: Channel;
}

export type ShouldRespondFn = (ctx: MessageContext) => boolean | Promise<boolean>;

export interface ChannelEntry {
  adapter: unknown;
  agent: string;
  shouldRespond: ShouldRespondFn | undefined;
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
      shouldRespond: typeof mod.shouldRespond === "function" ? (mod.shouldRespond as ShouldRespondFn) : undefined,
    };
  }

  return channels;
}
