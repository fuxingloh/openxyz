import { join } from "node:path";
import type { Thread as ChatThread, Message as ChatMessage, Adapter as ChatAdapter } from "chat";

export type Summary = {
  text: string;
  upToMessageId: string;
};

export type Thread = ChatThread<{
  summary?: Summary;
}>;

export type Message = ChatMessage;

export type Action = {
  /**
   * What agent to route to for this action.
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

export type Respond = boolean | Promise<boolean> | Action | Promise<Action>;

export type HandleFn = (thread: Thread, message: Message) => Respond;

/**
 * Representation of a channel file within the OpenXyz harness.
 */
export type ChannelFile = {
  adapter: ChatAdapter;
  handle: (thread: Thread, message: Message) => Promise<Action>;
};

export async function scanChannels(cwd: string): Promise<Record<string, ChannelFile>> {
  // TODO(agent): support .js and .ts
  const glob = new Bun.Glob("channels/[!_]*.ts");
  const channels: Record<string, ChannelFile> = {};

  for await (const path of glob.scan({ cwd })) {
    const file = path.split("/").pop()!;
    const name = file.replace(/\.ts$/, "");
    const mod = await import(join(cwd, path));

    if (!mod.default) {
      console.warn(`[openxyz] channels/${file} has no default export, skipping`);
      continue;
    }

    channels[name] = {
      adapter: mod.default,
      handle: newHandler(mod.handle, file),
    };
  }

  return channels;
}

function newHandler(handle: HandleFn, file: string): (thread: Thread, message: Message) => Promise<Action> {
  if (typeof handle !== "function") {
    throw new Error(`[openxyz] channels/${file} handle export is not a function`);
  }

  if (!handle) {
    console.warn(`[openxyz] channels/${file} has no handle export, using default handle that always returns true`);
    return async (thread: Thread, message: Message) => {
      return defaultAction(thread, message);
    };
  }

  return async (thread: Thread, message: Message): Promise<Action> => {
    const respond = await handle(thread, message);
    if (typeof respond !== "boolean") {
      return respond;
    }

    if (respond) {
      return defaultAction(thread, message);
    }

    return {};
  };
}

function defaultAction(thread: Thread, message: Message): Action {
  if (thread.isDM) {
    return {
      agent: "general",
      typing: true,
    };
  }

  if (message.isMention) {
    return {
      agent: "general",
      typing: true,
      reaction: "👀",
    };
  }

  // Default is doing nothing.
  return {};
}
