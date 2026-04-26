import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lock, Logger } from "chat";
import { connect, type Database } from "@tursodatabase/database";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { TursoStateAdapter } from "./index";

const mockLogger: Logger = {
  child: mock(() => mockLogger),
  debug: mock(),
  info: mock(),
  warn: mock(),
  error: mock(),
};

const TURSO_TOKEN_RE = /^turso_/;

function tmpFilePath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "chat-turso-"));
  const file = join(dir, "state.db");
  return { path: file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function makeTmpDb(): Promise<{ db: Database; cleanup: () => Promise<void> }> {
  const { path, cleanup } = tmpFilePath();
  const db = await connect(path);
  return {
    db,
    cleanup: async () => {
      try {
        await db.close();
      } catch {
        // already closed
      }
      cleanup();
    },
  };
}

describe("TursoStateAdapter", () => {
  it("exports TursoStateAdapter", () => {
    expect(typeof TursoStateAdapter).toBe("function");
  });

  describe("ensureConnected", () => {
    let db: Database;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ db, cleanup } = await makeTmpDb());
    });

    afterEach(async () => {
      await cleanup();
    });

    it.each([
      ["subscribe", (a: TursoStateAdapter) => a.subscribe("t1")],
      ["unsubscribe", (a: TursoStateAdapter) => a.unsubscribe("t1")],
      ["isSubscribed", (a: TursoStateAdapter) => a.isSubscribed("t1")],
      ["acquireLock", (a: TursoStateAdapter) => a.acquireLock("t1", 5000)],
      ["get", (a: TursoStateAdapter) => a.get("key")],
      ["set", (a: TursoStateAdapter) => a.set("key", "value")],
      ["setIfNotExists", (a: TursoStateAdapter) => a.setIfNotExists("key", "value")],
      ["delete", (a: TursoStateAdapter) => a.delete("key")],
      ["appendToList", (a: TursoStateAdapter) => a.appendToList("list", "value")],
      ["getList", (a: TursoStateAdapter) => a.getList("list")],
      [
        "enqueue",
        (a: TursoStateAdapter) => a.enqueue("t1", { message: { id: "m1" }, enqueuedAt: 0, expiresAt: 1 } as never, 10),
      ],
      ["dequeue", (a: TursoStateAdapter) => a.dequeue("t1")],
      ["queueDepth", (a: TursoStateAdapter) => a.queueDepth("t1")],
    ])("throws when calling %s before connect", async (_, fn) => {
      const adapter = new TursoStateAdapter({ client: db, logger: mockLogger });
      expect(fn(adapter)).rejects.toThrow("not connected");
    });

    it("throws for releaseLock before connect", async () => {
      const adapter = new TursoStateAdapter({ client: db, logger: mockLogger });
      const lock: Lock = { threadId: "t1", token: "tok", expiresAt: Date.now() };
      expect(adapter.releaseLock(lock)).rejects.toThrow("not connected");
    });

    it("throws for extendLock before connect", async () => {
      const adapter = new TursoStateAdapter({ client: db, logger: mockLogger });
      const lock: Lock = { threadId: "t1", token: "tok", expiresAt: Date.now() };
      expect(adapter.extendLock(lock, 5000)).rejects.toThrow("not connected");
    });

    it("throws for forceReleaseLock before connect", async () => {
      const adapter = new TursoStateAdapter({ client: db, logger: mockLogger });
      expect(adapter.forceReleaseLock("t1")).rejects.toThrow("not connected");
    });
  });

  describe("with a real turso file database", () => {
    let db: Database;
    let cleanupDb: () => Promise<void>;
    let adapter: TursoStateAdapter;

    beforeEach(async () => {
      ({ db, cleanup: cleanupDb } = await makeTmpDb());
      adapter = new TursoStateAdapter({ client: db, logger: mockLogger });
      await adapter.connect();
    });

    afterEach(async () => {
      await adapter.disconnect();
      await cleanupDb();
    });

    describe("connect / disconnect", () => {
      it("is idempotent on connect", async () => {
        await adapter.connect();
        await adapter.connect();
      });

      it("deduplicates concurrent connect calls", async () => {
        const { db: d, cleanup } = await makeTmpDb();
        try {
          const a = new TursoStateAdapter({ client: d, logger: mockLogger });
          await Promise.all([a.connect(), a.connect()]);
          await a.disconnect();
        } finally {
          await cleanup();
        }
      });

      it("is idempotent on disconnect", async () => {
        await adapter.disconnect();
        await adapter.disconnect();
        await adapter.connect();
      });

      it("never closes the passed-in client on disconnect", async () => {
        await adapter.disconnect();
        // DI contract: caller owns client lifecycle. The Database must still
        // be usable — the adapter never touches it.
        const stmt = db.prepare("SELECT 1 AS v");
        const row = await stmt.get();
        expect(row.v).toBe(1);
        await adapter.connect();
      });

      it("handles connect failure and allows retry", async () => {
        const { db: broken, cleanup } = await makeTmpDb();
        try {
          await broken.close();
          const a = new TursoStateAdapter({ client: broken, logger: mockLogger });
          expect(a.connect()).rejects.toThrow();
          expect(mockLogger.error).toHaveBeenCalled();
          expect(a.connect()).rejects.toThrow();
        } finally {
          await cleanup();
        }
      });
    });

    describe("subscriptions", () => {
      it("round-trips subscribe / isSubscribed / unsubscribe", async () => {
        expect(await adapter.isSubscribed("slack:C1:1.2")).toBe(false);
        await adapter.subscribe("slack:C1:1.2");
        expect(await adapter.isSubscribed("slack:C1:1.2")).toBe(true);
        await adapter.subscribe("slack:C1:1.2"); // idempotent
        expect(await adapter.isSubscribed("slack:C1:1.2")).toBe(true);
        await adapter.unsubscribe("slack:C1:1.2");
        expect(await adapter.isSubscribed("slack:C1:1.2")).toBe(false);
      });

      it("isolates subscriptions by keyPrefix", async () => {
        const other = new TursoStateAdapter({ client: db, keyPrefix: "other", logger: mockLogger });
        await other.connect();
        await adapter.subscribe("t1");
        expect(await other.isSubscribed("t1")).toBe(false);
        await other.disconnect();
      });
    });

    describe("locking", () => {
      it("acquires a lock with a token and expiry", async () => {
        const lock = await adapter.acquireLock("t1", 5000);
        expect(lock).not.toBeNull();
        expect(lock?.threadId).toBe("t1");
        expect(lock?.token).toMatch(TURSO_TOKEN_RE);
        expect(lock?.expiresAt).toBeGreaterThan(Date.now());
      });

      it("returns null when the lock is held", async () => {
        const first = await adapter.acquireLock("t1", 5000);
        expect(first).not.toBeNull();
        const second = await adapter.acquireLock("t1", 5000);
        expect(second).toBeNull();
      });

      it("allows reacquiring an expired lock", async () => {
        const first = await adapter.acquireLock("t1", 1);
        expect(first).not.toBeNull();
        await new Promise((r) => setTimeout(r, 10));
        const second = await adapter.acquireLock("t1", 5000);
        expect(second).not.toBeNull();
        expect(second?.token).not.toBe(first?.token);
      });

      it("releases a lock only with the right token", async () => {
        const lock = await adapter.acquireLock("t1", 5000);
        expect(lock).not.toBeNull();
        await adapter.releaseLock({
          threadId: "t1",
          token: "wrong",
          expiresAt: lock?.expiresAt ?? 0,
        });
        expect(await adapter.acquireLock("t1", 5000)).toBeNull();
        if (lock) await adapter.releaseLock(lock);
        expect(await adapter.acquireLock("t1", 5000)).not.toBeNull();
      });

      it("extends a lock when the token matches", async () => {
        const lock = await adapter.acquireLock("t1", 5000);
        expect(lock).not.toBeNull();
        if (!lock) return;
        expect(await adapter.extendLock(lock, 10_000)).toBe(true);
      });

      it("returns false when extending with the wrong token", async () => {
        await adapter.acquireLock("t1", 5000);
        const extended = await adapter.extendLock(
          { threadId: "t1", token: "nope", expiresAt: Date.now() + 5000 },
          5000,
        );
        expect(extended).toBe(false);
      });

      it("force-releases a lock without checking token", async () => {
        const lock = await adapter.acquireLock("t1", 5000);
        expect(lock).not.toBeNull();
        await adapter.forceReleaseLock("t1");
        expect(await adapter.acquireLock("t1", 5000)).not.toBeNull();
      });
    });

    describe("cache", () => {
      it("round-trips JSON values", async () => {
        await adapter.set("key", { foo: "bar" });
        expect(await adapter.get<{ foo: string }>("key")).toEqual({ foo: "bar" });
      });

      it("returns null on miss", async () => {
        expect(await adapter.get("missing")).toBeNull();
      });

      it("respects TTL", async () => {
        await adapter.set("key", "value", 1);
        await new Promise((r) => setTimeout(r, 10));
        expect(await adapter.get("key")).toBeNull();
      });

      it("setIfNotExists inserts only when absent", async () => {
        expect(await adapter.setIfNotExists("key", "first")).toBe(true);
        expect(await adapter.setIfNotExists("key", "second")).toBe(false);
        expect(await adapter.get<string>("key")).toBe("first");
      });

      it("setIfNotExists succeeds after TTL expiry", async () => {
        expect(await adapter.setIfNotExists("key", "first", 1)).toBe(true);
        await new Promise((r) => setTimeout(r, 10));
        expect(await adapter.setIfNotExists("key", "second")).toBe(true);
        expect(await adapter.get<string>("key")).toBe("second");
      });

      it("delete removes a value", async () => {
        await adapter.set("key", "value");
        await adapter.delete("key");
        expect(await adapter.get("key")).toBeNull();
      });
    });

    describe("lists", () => {
      it("appends values and returns them in insertion order", async () => {
        await adapter.appendToList("mylist", { id: 1 });
        await adapter.appendToList("mylist", { id: 2 });
        await adapter.appendToList("mylist", { id: 3 });
        expect(await adapter.getList("mylist")).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      });

      it("trims to maxLength, keeping newest", async () => {
        for (let i = 1; i <= 5; i++) {
          await adapter.appendToList("mylist", { id: i }, { maxLength: 3 });
        }
        expect(await adapter.getList("mylist")).toEqual([{ id: 3 }, { id: 4 }, { id: 5 }]);
      });

      it("expires the whole list when TTL passes", async () => {
        await adapter.appendToList("mylist", { id: 1 }, { ttlMs: 1 });
        await new Promise((r) => setTimeout(r, 10));
        expect(await adapter.getList("mylist")).toEqual([]);
      });

      it("returns empty for unknown keys", async () => {
        expect(await adapter.getList("nope")).toEqual([]);
      });
    });

    describe("statement cache", () => {
      it("prepares each SQL string at most once across repeated calls", async () => {
        const spy = spyOn(db, "prepare");
        await adapter.set("k", "v1");
        await adapter.set("k", "v2");
        await adapter.set("k", "v3");
        const insertCalls = spy.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO chat_state_cache"));
        expect(insertCalls.length).toBe(1);
        spy.mockRestore();
      });

      it("collapses concurrent first-uses of the same SQL into one prepare", async () => {
        const spy = spyOn(db, "prepare");
        await Promise.all([adapter.subscribe("t1"), adapter.subscribe("t2"), adapter.subscribe("t3")]);
        const subscribeCalls = spy.mock.calls.filter(([sql]) =>
          String(sql).includes("INSERT INTO chat_state_subscriptions"),
        );
        expect(subscribeCalls.length).toBe(1);
        spy.mockRestore();
      });

      it("uses distinct cache entries for distinct SQL strings", async () => {
        const spy = spyOn(db, "prepare");
        await adapter.set("k", "v");
        await adapter.get("k");
        await adapter.delete("k");
        const distinct = new Set(spy.mock.calls.map(([sql]) => String(sql)));
        expect(distinct.size).toBe(spy.mock.calls.length);
        spy.mockRestore();
      });

      it("evicts a failed prepare so a retry can succeed", async () => {
        // Force prepare to fail on the first call, then restore.
        const original = db.prepare.bind(db);
        let calls = 0;
        const flaky = mock((sql: string) => {
          calls++;
          if (calls === 1) throw new Error("boom");
          return original(sql);
        });
        const spy = spyOn(db, "prepare").mockImplementation(flaky as never);
        expect(adapter.set("k", "v")).rejects.toThrow("boom");
        // Cache must not retain the rejected promise — second call re-enters prepare and succeeds.
        await adapter.set("k", "v");
        expect(calls).toBeGreaterThanOrEqual(2);
        spy.mockRestore();
      });
    });

    describe("queue", () => {
      const makeEntry = (id: string, offsetMs = 90_000) => ({
        message: { id },
        enqueuedAt: Date.now(),
        expiresAt: Date.now() + offsetMs,
      });

      it("enqueues and dequeues in FIFO order", async () => {
        await adapter.enqueue("t1", makeEntry("m1") as never, 10);
        await adapter.enqueue("t1", makeEntry("m2") as never, 10);
        await adapter.enqueue("t1", makeEntry("m3") as never, 10);

        const a = await adapter.dequeue("t1");
        const b = await adapter.dequeue("t1");
        const c = await adapter.dequeue("t1");
        const d = await adapter.dequeue("t1");

        expect(a?.message.id).toBe("m1");
        expect(b?.message.id).toBe("m2");
        expect(c?.message.id).toBe("m3");
        expect(d).toBeNull();
      });

      it("returns current depth from enqueue", async () => {
        const d1 = await adapter.enqueue("t1", makeEntry("m1") as never, 10);
        const d2 = await adapter.enqueue("t1", makeEntry("m2") as never, 10);
        expect(d1).toBe(1);
        expect(d2).toBe(2);
      });

      it("trims to maxSize, keeping newest entries", async () => {
        for (let i = 1; i <= 5; i++) {
          await adapter.enqueue("t1", makeEntry(`m${i}`) as never, 3);
        }
        expect(await adapter.queueDepth("t1")).toBe(3);
        const entries: (string | undefined)[] = [];
        let next = await adapter.dequeue("t1");
        while (next) {
          entries.push(next.message.id as string);
          next = await adapter.dequeue("t1");
        }
        expect(entries).toEqual(["m3", "m4", "m5"]);
      });

      it("drops expired entries", async () => {
        await adapter.enqueue("t1", makeEntry("old", 1) as never, 10);
        await new Promise((r) => setTimeout(r, 10));
        await adapter.enqueue("t1", makeEntry("fresh") as never, 10);
        const entry = await adapter.dequeue("t1");
        expect(entry?.message.id).toBe("fresh");
      });

      it("queueDepth returns 0 for empty queues", async () => {
        expect(await adapter.queueDepth("nobody")).toBe(0);
      });
    });
  });
});
