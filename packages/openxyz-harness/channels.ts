import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { Thread as ChatThread, Message as ChatMessage, Adapter } from "chat";

export type Thread = ChatThread<{
  // summary?: Summary;
}>;

export type Message<Raw = unknown> = ChatMessage<Raw>;

export type ReplyAction = {
  /**
   * What agent to route to for this reply.
   * Undefined = do nothing.
   */
  agent?: string;
  /**
   * Whether to start the "typing indicator".
   */
  typing?: string | boolean;
  /**
   * Whether to add a reaction to the user's message.
   */
  reaction?: string;
};

/**
 * Representation of a channel file within the OpenXyz harness.
 */
export type ChannelFile<Raw = unknown> = {
  /**
   * Channel Adapter from `import("chat").Adapter`
   */
  adapter: Adapter;
  /**
   * Prepare context for the message (e.g. summarize, etc.).
   *
   * To override in `channels/name.ts`:
   * ```ts
   * export async function context(thread: Thread, message: Message) {
   *   return [];
   * };
   * ```
   */
  context: (thread: Thread, message: Message<Raw>) => Promise<ModelMessage[]>;
  /**
   * Reply to take when a message is received.
   * If returns `true`, uses default reply.
   * If returns `false`, does nothing.
   * If returns `ReplyAction`, uses that reply.
   */
  reply: (thread: Thread, message: Message<Raw>) => Promise<ReplyAction>;
};

export async function scanChannelFiles(cwd: string): Promise<Record<string, ChannelFile>> {
  // TODO(agent): support .js and .ts
  const glob = new Bun.Glob("channels/[!_]*.ts");
  const channels: Record<string, ChannelFile> = {};

  for await (const path of glob.scan({ cwd })) {
    const file = path.split("/").pop()!;
    const name = file.replace(/\.ts$/, "");
    const mod = await import(join(cwd, path));
    channels[name] = newChannelFile(mod, name);
  }

  return channels;
}

function newChannelFile(mod: any, filename: string): ChannelFile {
  if (!mod.default) {
    throw new Error(`[openxyz] channel file has no default export`);
  }

  const file = mod.default as ChannelFile;

  return {
    adapter: file.adapter,
    // TODO(?): mod.context allow `export function context() {}`
    context: file.context,
    reply: mapReplyFunc(mod, filename),
  };
}

export type ReplyFunc = (
  thread: Thread,
  message: Message,
) => boolean | Promise<boolean> | ReplyAction | Promise<ReplyAction>;

function mapReplyFunc(mod: any, filename: string): ChannelFile["reply"] {
  const file = mod.default as ChannelFile;
  if (mod.reply === undefined) {
    console.warn(`[openxyz] channels/${filename} has no export function reply, using default handler.`);
    return file.reply;
  }

  const func: ReplyFunc = mod.reply;
  if (typeof func !== "function") {
    throw new Error(`[openxyz] channels/${filename} reply export is not a function`);
  }

  return async (thread: Thread, message: Message): Promise<ReplyAction> => {
    const booleanOrReply = await func(thread, message);
    if (typeof booleanOrReply === "boolean") {
      if (booleanOrReply) {
        return file.reply(thread, message);
      }
      return {};
    }
    return booleanOrReply;
  };
}
