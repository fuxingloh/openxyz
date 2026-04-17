import type { ModelMessage } from "ai";
import type { Thread as ChatSdkThread, Message as ChatSdkMessage, Adapter as ChatSdkAdapter } from "chat";

export type Thread = ChatSdkThread<{
  // summary?: Summary;
}>;

export type Message<Raw = unknown> = ChatSdkMessage<Raw>;

export type ReplyAction = {
  /** What agent to route to for this reply. Undefined = do nothing. */
  agent?: string;
  /** Whether to start the "typing indicator". */
  typing?: string | boolean;
  /** Whether to add a reaction to the user's message. */
  reaction?: string;
};

/**
 * Abstract base class for channel adapters. Concrete adapters shipped by
 * `openxyz` (e.g. `TelegramChannel`) extend this; template channel files
 * typically subclass the concrete adapter and `export default new Foo(...)`.
 *
 * `this.adapter` is the chat-sdk `Adapter` — composed, not inherited. It owns
 * platform plumbing (webhooks, polling, raw-message parsing). The methods on
 * this class are the harness-level hooks templates override.
 */
export abstract class Channel<Raw = unknown> {
  abstract readonly adapter: ChatSdkAdapter;

  /**
   * Environment frame — prepended on top, do not use unstable data.
   * Use for values that change per-request (thread name, etc.). Session-scoped.
   * Return lines; the harness joins with `\n` and wraps into a system message.
   */
  abstract environment(thread: Thread, message: Message<Raw>): Promise<string[]>;

  /**
   * Prepare context (conversation history) for the agent. Concrete adapters
   * typically iterate `thread.channel.messages`, honor `this.filter?`, and
   * return `ModelMessage[]` via `toAiMessages`.
   */
  abstract context(thread: Thread, message: Message<Raw>): Promise<ModelMessage[]>;

  /**
   * Decide what to do with an incoming message. Return `{}` to stay silent;
   * `{ agent, typing, reaction }` to dispatch to an agent. Templates that
   * want partial overrides can `return super.reply(thread, message)` after
   * their own allowlist/gate checks pass.
   */
  abstract reply(thread: Thread, message: Message<Raw>): Promise<ReplyAction>;

  /**
   * Optional message-level predicate. Concrete adapters' `context()` should
   * drop messages where this returns `false`. Adapter-agnostic shape —
   * templates override it to scope context (e.g. PKBM-in-a-group filtering).
   */
  filter?(message: Message<Raw>, thread: Thread): boolean;
}

/**
 * Validate and return the default-exported `Channel` instance from a
 * channel module. Called from `openxyz start` (runtime) and from the built
 * artifact (code-gen'd by `openxyz build`).
 */
export function loadChannel(mod: any, filename: string): Channel {
  if (!mod.default) {
    throw new Error(`[openxyz] channels/${filename} has no default export`);
  }
  if (!(mod.default instanceof Channel)) {
    throw new Error(
      `[openxyz] channels/${filename} default export is not a Channel instance — did you forget \`new\`?`,
    );
  }
  return mod.default as Channel;
}
