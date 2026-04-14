import { Chat, toAiMessages } from "chat";
import type { Thread, Message } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { scanChannels, type ChannelFile } from "./channels";
import { AgentFactory } from "./agents/factory";
import type { ModelMessage } from "ai";

export class OpenXyz {
  readonly cwd: string;
  readonly agentFactory: AgentFactory;
  #chat?: Chat;
  #channels: Record<string, ChannelFile> = {};

  constructor(opts: { cwd: string }) {
    this.cwd = opts.cwd;
    this.agentFactory = new AgentFactory(this.cwd);
  }

  async start(): Promise<void> {
    const [, channels] = await Promise.all([this.agentFactory.init(), scanChannels(this.cwd)]);
    this.#channels = channels;

    if (Object.keys(channels).length === 0) {
      throw new Error("[openxyz] no channels found under channels/*.ts — nothing to run");
    }

    const chat = new Chat({
      adapters: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, v.adapter])) as Record<string, never>,
      state: createMemoryState(),
      userName: "openxyz",
      logger: "info",
      fallbackStreamingPlaceholderText: null,
    });

    chat.onNewMessage(/.+/, async (thread, message) => {
      const channel = this.#channels[thread.adapter.name];
      if (!channel) {
        throw new Error(`[openxyz] received message for adapter "${thread.adapter.name}" but no channel config found`);
      }

      const action = await channel.handle(thread, message);

      if (action.typing) {
        const status = typeof action.typing === "string" ? action.typing : undefined;
        thread.startTyping(status).catch((err) => console.warn("[openxyz] startTyping failed", err));
      }

      if (action.reaction) {
        thread.adapter
          .addReaction(thread.id, message.id, action.reaction)
          .catch((err) => console.warn("[openxyz] addReaction failed", err));
      }

      if (action.agent) {
        this.#reply(thread, message, action.agent).catch((err) => console.error("[openxyz] reply failed", err));
      }

      console.log(`[openxyz] new message in thread ${thread.id} on adapter ${thread.adapter.name}: ${message.text}`);
    });

    // initialize() auto-starts polling for adapters in "auto" mode when no webhook is configured.
    await chat.initialize();
    this.#chat = chat;
  }

  async #reply(thread: Thread, message: Message, agentName: string): Promise<void> {
    const agent = await this.agentFactory.create(agentName);
    const prompt = await getPrompt(thread, message);
    const result = await agent.stream({ prompt: prompt });
    await thread.post(result.fullStream);
  }

  async stop(): Promise<void> {
    await this.#chat?.shutdown();
  }
}

async function getPrompt(thread: Thread, message: Message): Promise<ModelMessage[]> {
  // date sent
  const messages: ModelMessage[] = await toAiMessages(thread.recentMessages, {
    transformMessage: (msg, source) => {
      const content = ["<reply_to>", source.author, "</reply_to>", msg.content].join("\n");
      // AiMessagePart

      return {
        role: msg.role,
        content: [msg.content],
      };
    },
  });

  messages.push({
    role: "system" as const,
    content: `Current datetime: ${new Date().toISOString()}`,
  });

  return messages;
}

/**
 * Provider error messages aren't typed — detect context-overflow by regex on
 * the error text. Matches OpenAI ("context_length_exceeded", "maximum context
 * length"), Anthropic ("prompt is too long"), and generic phrasings.
 */
function isContextOverflow(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /context[_ ]?(length|window)|token limit|prompt is too long|exceeds?.*context|too many tokens/.test(msg);
}
