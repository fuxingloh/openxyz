import { describe, expect, test } from "bun:test";
import { splitOnFinishStep } from "./split-stream.ts";

type Event = { type: string; text?: string };

async function* fromArray<T>(events: T[], delayMs = 0): AsyncIterable<T> {
  for (const e of events) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    yield e;
  }
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

async function collectBubbles(events: Event[]): Promise<Event[][]> {
  const bubbles: Event[][] = [];
  for await (const sub of splitOnFinishStep(fromArray(events))) {
    bubbles.push(await collect(sub));
  }
  return bubbles;
}

const text = (t: string): Event => ({ type: "text-delta", text: t });
const finishStep = (): Event => ({ type: "finish-step" });
const toolCall = (): Event => ({ type: "tool-call" });
const toolResult = (): Event => ({ type: "tool-result" });

describe("splitOnFinishStep", () => {
  test("single step with text yields one bubble", async () => {
    const bubbles = await collectBubbles([text("hello "), text("world"), finishStep()]);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.filter((e) => e.type === "text-delta").map((e) => e.text)).toEqual(["hello ", "world"]);
  });

  test("two text steps yield two bubbles", async () => {
    const bubbles = await collectBubbles([text("first"), finishStep(), text("second"), finishStep()]);
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]!.find((e) => e.type === "text-delta")?.text).toBe("first");
    expect(bubbles[1]!.find((e) => e.type === "text-delta")?.text).toBe("second");
  });

  test("step with only tool-calls yields a textless substream", async () => {
    // Emit-immediate: every step is yielded as a substream, including ones
    // with no text-delta. The consumer drops textless ones via
    // `if (!text) continue` after `collectTextDeltas` returns "".
    const bubbles = await collectBubbles([toolCall(), finishStep(), toolResult(), text("answer"), finishStep()]);
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]!.find((e) => e.type === "text-delta")).toBeUndefined();
    expect(bubbles[1]!.find((e) => e.type === "text-delta")?.text).toBe("answer");
  });

  test("text-then-tool-call within a step keeps the bubble", async () => {
    // ack-then-tool pattern — text appears, model decides to call a tool,
    // then finish-step. The text must still render.
    const bubbles = await collectBubbles([text("on it…"), toolCall(), finishStep()]);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.find((e) => e.type === "text-delta")?.text).toBe("on it…");
  });

  test("trailing text without finish-step still yields", async () => {
    // Defensive — fullStream usually ends with finish-step, but if a stream
    // terminates abruptly, an already-published segment must drain.
    const bubbles = await collectBubbles([text("hello")]);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.find((e) => e.type === "text-delta")?.text).toBe("hello");
  });

  test("empty stream yields nothing", async () => {
    const bubbles = await collectBubbles([]);
    expect(bubbles).toHaveLength(0);
  });

  test("stream of only tool-calls yields textless substreams", async () => {
    // Emit-immediate: one substream per step regardless of contents.
    const bubbles = await collectBubbles([toolCall(), finishStep(), toolCall(), finishStep()]);
    expect(bubbles).toHaveLength(2);
    for (const b of bubbles) expect(b.find((e) => e.type === "text-delta")).toBeUndefined();
  });

  test("stream error after publish surfaces on iterator", async () => {
    async function* failing(): AsyncIterable<Event> {
      yield text("partial");
      throw new Error("boom");
    }
    const seen: string[] = [];
    let caught: unknown = null;
    try {
      for await (const sub of splitOnFinishStep(failing())) {
        for await (const e of sub) {
          if (e.type === "text-delta" && e.text) seen.push(e.text);
        }
      }
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe("boom");
    expect(seen).toEqual(["partial"]);
  });

  test("stream error before any text yields nothing and rethrows", async () => {
    async function* failing(): AsyncIterable<Event> {
      yield toolCall();
      throw new Error("kaboom");
    }
    const out: Event[][] = [];
    let caught: unknown = null;
    try {
      for await (const sub of splitOnFinishStep(failing())) {
        out.push(await collect(sub));
      }
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe("kaboom");
    expect(out).toHaveLength(0);
  });

  test("slow consumer doesn't deadlock the pump", async () => {
    // Master pump should drive to completion even if the consumer takes its
    // time iterating each substream.
    const events = [text("a"), finishStep(), text("b"), finishStep(), text("c"), finishStep()];
    const bubbles: string[] = [];
    for await (const sub of splitOnFinishStep(fromArray(events))) {
      await new Promise((r) => setTimeout(r, 5));
      const collected = await collect(sub);
      bubbles.push(collected.find((e) => e.type === "text-delta")!.text!);
    }
    expect(bubbles).toEqual(["a", "b", "c"]);
  });

  test("step with multiple text chunks streams them in order to the same bubble", async () => {
    const bubbles = await collectBubbles([text("one "), text("two "), text("three"), finishStep()]);
    expect(bubbles).toHaveLength(1);
    const texts = bubbles[0]!.filter((e) => e.type === "text-delta").map((e) => e.text);
    expect(texts).toEqual(["one ", "two ", "three"]);
  });
});
