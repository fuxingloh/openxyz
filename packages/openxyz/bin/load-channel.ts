import { Channel, type ReplyFunc } from "@openxyz/runtime/channels";

/**
 * Validate and return the default-exported `Channel` instance from a channel
 * module, applying any sibling `agent`/`reply` exports on top. Template glue
 * — `openxyz start` calls this after dynamic-import. Lives in the facade
 * because the two-style convention (subclass vs sibling-exports) is a
 * template contract, not a runtime primitive.
 *
 * Two template styles are supported and can be mixed:
 * 1. **Subclass** — `class MyX extends TelegramChannel`, override `reply`
 *    and/or set `this.agent = "..."` in the constructor. `export default
 *    new MyX(...)`. Use `super.reply(...)` to defer to the parent's default.
 * 2. **Sibling exports** — `export default new TelegramChannel(...)` plus
 *    `export function reply(thread, message): boolean`, and optionally
 *    `export const agent = "..."`. The sibling reply IS the answer; it
 *    does not fall through to the channel's default. Templates that want
 *    the default's behavior should call into it explicitly via the
 *    subclass style.
 *
 * When both are present, sibling exports win (applied on top of the instance).
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

  const channel = mod.default as Channel;

  if (mod.agent !== undefined) {
    const resolved = typeof mod.agent === "function" ? (mod.agent as () => unknown)() : mod.agent;
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw new Error(
        `[openxyz] channels/${filename} \`agent\` export must be a non-empty string (or a function returning one)`,
      );
    }
    channel.agent = resolved;
  }

  if (mod.reply !== undefined) {
    if (typeof mod.reply !== "function") {
      throw new Error(`[openxyz] channels/${filename} \`reply\` export is not a function`);
    }
    const userReply = mod.reply as ReplyFunc;
    channel.reply = async (thread, message) => Boolean(await userReply(thread, message));
  }

  return channel;
}
