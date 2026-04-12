import { Chat, toAiMessages } from "chat";
import type { Thread } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { basename } from "node:path";
import { scanChannels } from "./channels";
import { Filesystem } from "./tools/filesystem";
import { web_fetch, web_search } from "./tools/web";
import { scanSkills, createSkillTool } from "./tools/skill";
import { scanTools } from "./tools/custom";
import { create as createAgent } from "./agents/main.ts";
import type { Tool } from "ai";

export class OpenXyzHarness {
  readonly cwd: string;
  #agent?: Awaited<ReturnType<typeof createAgent>>;
  #chat?: Chat;
  #channels: Record<string, { adapter: unknown; allowlist: Set<string> | undefined }> = {};

  constructor(opts: { cwd: string }) {
    this.cwd = opts.cwd;
  }

  async start(): Promise<void> {
    const [{ tools, skills }, channels] = await Promise.all([this.#loadTools(), this.#loadChannels()]);
    this.#agent = await createAgent(this.cwd, tools, skills);
    this.#channels = channels;

    const adapters = Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, v.adapter]));
    const chat = new Chat({
      adapters: adapters as Record<string, never>,
      state: createMemoryState(),
      userName: "openxyz",
      logger: "silent",
      fallbackStreamingPlaceholderText: null,
    });
    this.#chat = chat;

    // fire-and-forget — awaiting here holds the chat-sdk thread lock and causes LockError on concurrent messages (working/004)
    chat.onDirectMessage((thread) => {
      this.#reply(thread).catch((err) => console.error("[openxyz] handler error", err));
    });

    chat.onSubscribedMessage((thread) => {
      this.#reply(thread).catch((err) => console.error("[openxyz] handler error", err));
    });

    // initialize() auto-starts polling for adapters in "auto" mode when no webhook is configured.
    await chat.initialize();
  }

  async #loadTools() {
    const fs = new Filesystem(this.cwd);
    const [skills, custom] = await Promise.all([scanSkills(this.cwd), scanTools(this.cwd)]);

    const tools: Record<string, Tool> = {
      ...fs.tools(),
      web_fetch,
      web_search,
      skill: createSkillTool(skills),
      ...custom,
    };

    return { tools, skills };
  }

  async #loadChannels() {
    const channels = await scanChannels(this.cwd);
    if (Object.keys(channels).length === 0) {
      // Fail fast: without at least one channel, the harness has no way to receive messages. See working/027.
      throw new Error("[openxyz] no channels found under channels/*.ts — nothing to run");
    }
    return channels;
  }

  async #reply(thread: Thread): Promise<void> {
    // Allowlist check: thread.id is "channel:user_id", match against the channel's allowlist
    const [channel, userId] = thread.id.split(":") as [string, string];
    const allowlist = this.#channels[channel]?.allowlist;
    if (allowlist && !allowlist.has(userId)) return;

    // TODO: subscribe() is idempotent but called on every reply — redundant after first contact.
    //  Move to onDirectMessage handler only, or remove if all channels are pure DM.
    await thread.subscribe();
    await thread.startTyping();
    const fetched = await thread.adapter.fetchMessages(thread.id, { limit: 20 });
    const history = await toAiMessages(fetched.messages);
    const env = {
      role: "system" as const,
      content: [
        "## Environment",
        "",
        `- Date: ${new Date().toISOString().split("T")[0]}`,
        `- Home: /home/${basename(this.cwd)}`,
        // TODO: list mounted /mnt/* paths when VFS mounts are implemented
      ].join("\n"),
    };
    const result = await this.#agent!.stream({ prompt: [env, ...history] });
    try {
      await thread.post(result.fullStream);
    } catch {
      // TODO: chat-sdk's Telegram adapter doesn't escape MarkdownV2 entities properly.
      //  Fall back to plain text (no parse_mode) until upstream fixes it.
      let text = "";
      for await (const chunk of result.textStream) {
        text += chunk;
      }
      await thread.post(text);
    }
  }

  async stop(): Promise<void> {
    await this.#chat?.shutdown();
  }
}
