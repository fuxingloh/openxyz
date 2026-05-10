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
type LocalRaw = import("./channel.ts").TelegramRaw;

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
    // Filename sanitized for Bedrock Converse: dots/etc. stripped, runs collapsed.
    expect(fileParts[0]!.filename).toBe("report pdf");
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

  test("sanitizes filenames to satisfy Bedrock Converse", async () => {
    const channel = new TelegramChannel({ botToken: "test" });
    const cases: Array<[string, string]> = [
      ["report.pdf", "report pdf"], // dot
      ["My_File.pdf", "My File pdf"], // underscore
      ["a   b.pdf", "a b pdf"], // consecutive whitespace
      ["中文.pdf", "pdf"], // non-ASCII stripped
      ["???", "document"], // fully-stripped fallback
    ];
    for (const [input, expected] of cases) {
      const msg = pdfMessage();
      (msg.attachments![0] as { name: string }).name = input;
      const result = await channel.toModelMessages(thread, [msg]);
      expect(findFileParts(result)[0]!.filename).toBe(expected);
    }
  });

  test("fetchData failure skips the FilePart but keeps the message", async () => {
    const channel = new TelegramChannel({ botToken: "test" });
    const result = await channel.toModelMessages(thread, [pdfMessage({ failFetch: true })]);
    expect(findFileParts(result)).toHaveLength(0);
    // Empty-caption fallback runs first, so the message survives chat-sdk's
    // empty-text filter — agent still sees a user turn with the placeholder.
    expect(result.find((m) => m.role === "user")).toBeDefined();
  });

  test("declared size over inline limit short-circuits before download", async () => {
    // Bedrock Converse rejects Document above ~4.5 MB and the base64-encoded
    // PDF blows the input window via `bytes/4` estimation. Stub upstream so
    // the agent sees the attachment landed but knows it wasn't read.
    const channel = new TelegramChannel({ botToken: "test" });
    let fetched = false;
    const msg = pdfMessage();
    (msg.attachments![0] as { size: number }).size = 5_000_000;
    (msg.attachments![0] as { fetchData: () => Promise<Buffer> }).fetchData = async () => {
      fetched = true;
      return PDF_BYTES;
    };
    const result = await channel.toModelMessages(thread, [msg]);
    expect(fetched).toBe(false);
    expect(findFileParts(result)).toHaveLength(0);
    const userMsg = result.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const parts = userMsg!.content as Array<{ type: string; text?: string }>;
    const stub = parts.find((p) => p.type === "text" && /skipped/.test(p.text ?? ""));
    expect(stub).toBeDefined();
    expect(stub!.text).toMatch(/report\.pdf/);
  });

  test("downloaded buffer over inline limit substitutes a stub", async () => {
    // `att.size` may be unset (older platforms / quirky payloads). Re-check
    // post-fetch so the cap still bites.
    const channel = new TelegramChannel({ botToken: "test" });
    const big = Buffer.alloc(5_000_000, 0x20);
    const msg = pdfMessage();
    (msg.attachments![0] as { size?: number }).size = undefined;
    (msg.attachments![0] as { fetchData: () => Promise<Buffer> }).fetchData = async () => big;
    const result = await channel.toModelMessages(thread, [msg]);
    expect(findFileParts(result)).toHaveLength(0);
    const userMsg = result.find((m) => m.role === "user");
    const parts = userMsg!.content as Array<{ type: string; text?: string }>;
    expect(parts.find((p) => p.type === "text" && /skipped/.test(p.text ?? ""))).toBeDefined();
  });
});
