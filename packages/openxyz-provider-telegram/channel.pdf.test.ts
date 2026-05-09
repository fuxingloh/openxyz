import { describe, expect, mock, test } from "bun:test";
import type { ModelMessage } from "ai";
import type { Thread } from "@openxyz/runtime/channels";
import type { Message } from "chat";

// Skip the resvg WASM init triggered at module-load by render-table.ts —
// `bun test` doesn't surface the `with { type: "binary" }` import the way
// `bun run` does, and we don't exercise rendering here.
mock.module("@resvg/resvg-wasm", () => ({
  initWasm: () => Promise.resolve(),
  Resvg: class {
    render() {
      return { asPng: () => new Uint8Array() };
    }
  },
}));

const { TelegramChannel } = await import("./channel.ts");
type LocalRaw = import("./channel.ts").LocalRaw;

/**
 * Covers mnemonic/170 — PDF inline-passthrough. Asserts the property:
 * a `file` attachment with `application/pdf` mimeType reaches the model
 * as an AI SDK `FilePart`, despite chat-sdk's `attachmentToPart` dropping it.
 */

const PDF_BYTES = Buffer.from("%PDF-1.4\n%fake\n");

function pdfMessage(overrides?: { caption?: string; failFetch?: boolean }): Message<LocalRaw> {
  return {
    id: "m1",
    threadId: "t1",
    text: overrides?.caption ?? "",
    author: { userId: "u1", userName: "alice", fullName: "Alice", isBot: false, isMe: false },
    metadata: { dateSent: new Date(1_700_000_000_000), edited: false },
    attachments: [
      {
        type: "file",
        mimeType: "application/pdf",
        name: "report.pdf",
        size: PDF_BYTES.length,
        fetchData: async () => {
          if (overrides?.failFetch) throw new Error("download failed");
          return PDF_BYTES;
        },
      },
    ],
    raw: { document: { mime_type: "application/pdf", file_id: "f1", file_name: "report.pdf" } } as unknown as LocalRaw,
  } as unknown as Message<LocalRaw>;
}

const thread = { isDM: true } as unknown as Thread;

function findFileParts(result: ModelMessage[]): Array<{ mediaType?: string; filename?: string; data?: unknown }> {
  const parts: Array<{ mediaType?: string; filename?: string; data?: unknown }> = [];
  for (const msg of result) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") continue;
    for (const part of msg.content) {
      if ((part as { type: string }).type === "file") parts.push(part as never);
    }
  }
  return parts;
}

describe("TelegramChannel.toModelMessages — PDF passthrough", () => {
  test("emits a FilePart with application/pdf mediaType for empty-caption PDF", async () => {
    const channel = new TelegramChannel({ botToken: "test" });
    const result = await channel.toModelMessages(thread, [pdfMessage()]);
    const fileParts = findFileParts(result);
    expect(fileParts).toHaveLength(1);
    expect(fileParts[0]!.mediaType).toBe("application/pdf");
    expect(fileParts[0]!.filename).toBe("report.pdf");
    expect(String(fileParts[0]!.data)).toMatch(/^data:application\/pdf;base64,/);
    expect(String(fileParts[0]!.data)).toContain(PDF_BYTES.toString("base64"));
  });

  test("preserves user caption alongside the PDF FilePart", async () => {
    const channel = new TelegramChannel({ botToken: "test" });
    const result = await channel.toModelMessages(thread, [pdfMessage({ caption: "summarise this" })]);
    const userMsg = result.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(typeof userMsg!.content).not.toBe("string");
    const parts = userMsg!.content as Array<{ type: string; text?: string }>;
    expect(parts.find((p) => p.type === "text")?.text).toBe("summarise this");
    expect(parts.filter((p) => p.type === "file")).toHaveLength(1);
  });

  test("fetchData failure skips the FilePart but keeps the message", async () => {
    const channel = new TelegramChannel({ botToken: "test" });
    const result = await channel.toModelMessages(thread, [pdfMessage({ failFetch: true })]);
    expect(findFileParts(result)).toHaveLength(0);
    // Empty-caption fallback runs first, so the message survives chat-sdk's
    // empty-text filter — agent still sees a user turn with the placeholder.
    expect(result.find((m) => m.role === "user")).toBeDefined();
  });
});
