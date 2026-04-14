import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { Thread as ChatThread, Message as ChatMessage, Adapter } from "chat";

export type Thread = ChatThread<{
  // summary?: Summary;
}>;

export type Message<Raw = unknown> = ChatMessage<Raw>;

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
   * Action to take when a message is received.
   * If returns `true`, uses default action.
   * If returns `false`, does nothing.
   * If returns `Action`, uses that action.
   */
  action: (thread: Thread, message: Message<Raw>) => Promise<Action>;
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
    action: mapActionFunc(mod, filename),
  };
}

export type ActionFunc = (thread: Thread, message: Message) => boolean | Promise<boolean> | Action | Promise<Action>;

function mapActionFunc(mod: any, filename: string): ChannelFile["action"] {
  const file = mod.default as ChannelFile;
  if (mod.action === undefined) {
    console.warn(`[openxyz] channels/${filename} has no export function action, using default handler.`);
    return file.action;
  }

  const func: ActionFunc = mod.action;
  if (typeof func !== "function") {
    throw new Error(`[openxyz] channels/${filename} handle export is not a function`);
  }

  return async (thread: Thread, message: Message): Promise<Action> => {
    const booleanOrAction = await func(thread, message);
    if (typeof booleanOrAction === "boolean") {
      if (booleanOrAction) {
        return file.action(thread, message);
      }
      return {};
    }
    return booleanOrAction;
  };
}
