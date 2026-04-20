import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lock, Logger } from "chat";
import Database from "libsql/promise";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createLibSqlState, LibSqlStateAdapter } from "./index";

const mockLogger: Logger = {
  child: mock(() => mockLogger),
  debug: mock(),
  info: mock(),
  warn: mock(),
  error: mock(),
};

function withEnv<T>(key: string, value: string, fn: () => T): T {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

const LIBSQL_TOKEN_RE = /^libsql_/;

function tmpFilePath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "chat-libsql-"));
  const file = join(dir, "state.db");
  return {
    path: file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeTmpDb(): { db: Database; cleanup: () => void } {
  const { path, cleanup } = tmpFilePath();
  const db = new Database(path, {});
  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
      cleanup();
    },
  };
}

describe("LibSqlStateAdapter (libsql/promise)", () => {
  it("exports createLibSqlState", () => {
    expect(typeof createLibSqlState).toBe("function");
  });

  it("exports LibSqlStateAdapter", () => {
    expect(typeof LibSqlStateAdapter).toBe("function");
  });

  describe("createLibSqlState", () => {
    it("creates an adapter from a file path", () => {
      const { path, cleanup } = tmpFilePath();
      try {
        const adapter = createLibSqlState({ url: path, logger: mockLogger });
        expect(adapter).toBeInstanceOf(LibSqlStateAdapter);
      } finally {
        cleanup();
      }
    });

    it("accepts an existing Database", () => {
      const { db, cleanup } = makeTmpDb();
      try {
        const adapter = createLibSqlState({ client: db, logger: mockLogger });
        expect(adapter).toBeInstanceOf(LibSqlStateAdapter);
      } finally {
        cleanup();
      }
    });

    it("throws when no url or TURSO_DATABASE_URL is available", () => {
      withEnv("TURSO_DATABASE_URL", "", () => {
        expect(() => createLibSqlState({ logger: mockLogger })).toThrow("libSQL url is required");
      });
    });

    it("uses TURSO_DATABASE_URL env var as fallback", () => {
      const { path, cleanup } = tmpFilePath();
      try {
        withEnv("TURSO_DATABASE_URL", path, () => {
          const adapter = createLibSqlState({ logger: mockLogger });
          expect(adapter).toBeInstanceOf(LibSqlStateAdapter);
        });
      } finally {
        cleanup();
      }
    });

    describe("URL types", () => {
      it("connects to a local file path", async () => {
        const { path, cleanup } = tmpFilePath();
        try {
          const adapter = createLibSqlState({
            url: path,
            logger: mockLogger,
          });
          await adapter.connect();
          await adapter.subscribe("slack:C1:1.2");
          expect(await adapter.isSubscribed("slack:C1:1.2")).toBe(true);
          await adapter.disconnect();
        } finally {
          cleanup();
        }
      });

      it("connects to a file: URL", async () => {
        const { path, cleanup } = tmpFilePath();
        try {
          const adapter = createLibSqlState({
            url: `file:${path}`,
            logger: mockLogger,
          });
          await adapter.connect();
          await adapter.subscribe("slack:C1:1.2");
          expect(await adapter.isSubscribed("slack:C1:1.2")).toBe(true);
          await adapter.disconnect();
        } finally {
          cleanup();
        }
      });

      it("connects to an in-memory database", async () => {
        const adapter = createLibSqlState({
          url: ":memory:",
          logger: mockLogger,
        });
        await adapter.connect();
        await adapter.subscribe("slack:C1:1.2");
        expect(await adapter.isSubscribed("slack:C1:1.2")).toBe(true);
        await adapter.disconnect();
      });

      // Remote URLs the native binding supports at construction time.
      // It lazily dials the network on the first query, so construction
      // succeeds without a live server. `ws://`/`wss://` are only supported
      // by `@chat-adapter/state-libsql/client` (`@libsql/client`), not by
      // the native binding.
      it.each([["libsql://db.turso.io"], ["https://db.turso.io"], ["http://127.0.0.1:8080"]])(
        "accepts remote URL %s",
        (url) => {
          const adapter = createLibSqlState({
            url,
            authToken: "tok",
            logger: mockLogger,
          });
          expect(adapter).toBeInstanceOf(LibSqlStateAdapter);
        },
      );
    });
  });

  describe("ensureConnected", () => {
    let db: Database;
    let cleanup: () => void;

    beforeEach(() => {
      ({ db, cleanup } = makeTmpDb());
    });

    afterEach(() => {
      cleanup();
    });

    it.each([
      ["subscribe", (a: LibSqlStateAdapter) => a.subscribe("t1")],
      ["unsubscribe", (a: LibSqlStateAdapter) => a.unsubscribe("t1")],
      ["isSubscribed", (a: LibSqlStateAdapter) => a.isSubscribed("t1")],
      ["acquireLock", (a: LibSqlStateAdapter) => a.acquireLock("t1", 5000)],
      ["get", (a: LibSqlStateAdapter) => a.get("key")],
      ["set", (a: LibSqlStateAdapter) => a.set("key", "value")],
      ["setIfNotExists", (a: LibSqlStateAdapter) => a.setIfNotExists("key", "value")],
      ["delete", (a: LibSqlStateAdapter) => a.delete("key")],
      ["appendToList", (a: LibSqlStateAdapter) => a.appendToList("list", "value")],
      ["getList", (a: LibSqlStateAdapter) => a.getList("list")],
      [
        "enqueue",
        (a: LibSqlStateAdapter) =>
          a.enqueue(
            "t1",
            {
              message: { id: "m1" },
              enqueuedAt: 0,
              expiresAt: 1,
            } as never,
            10,
          ),
      ],
      ["dequeue", (a: LibSqlStateAdapter) => a.dequeue("t1")],
      ["queueDepth", (a: LibSqlStateAdapter) => a.queueDepth("t1")],
    ])("throws when calling %s before connect", async (_, fn) => {
      const adapter = new LibSqlStateAdapter({
        client: db,
        logger: mockLogger,
      });
      await expect(fn(adapter)).rejects.toThrow("not connected");
    });

    it("throws for releaseLock before connect", async () => {
      const adapter = new LibSqlStateAdapter({
        client: db,
        logger: mockLogger,
      });
      const lock: Lock = {
        threadId: "t1",
        token: "tok",
        expiresAt: Date.now(),
      };
      await expect(adapter.releaseLock(lock)).rejects.toThrow("not connected");
    });

    it("throws for extendLock before connect", async () => {
      const adapter = new LibSqlStateAdapter({
        client: db,
        logger: mockLogger,
      });
      const lock: Lock = {
        threadId: "t1",
        token: "tok",
        expiresAt: Date.now(),
      };
      await expect(adapter.extendLock(lock, 5000)).rejects.toThrow("not connected");
    });

    it("throws for forceReleaseLock before connect", async () => {
      const adapter = new LibSqlStateAdapter({
        client: db,
        logger: mockLogger,
      });
      await expect(adapter.forceReleaseLock("t1")).rejects.toThrow("not connected");
    });
  });

  describe("with a real libsql file database", () => {
    let db: Database;
    let cleanupDb: () => void;
    let adapter: LibSqlStateAdapter;

    beforeEach(async () => {
      ({ db, cleanup: cleanupDb } = makeTmpDb());
      adapter = new LibSqlStateAdapter({ client: db, logger: mockLogger });
      await adapter.connect();
    });

    afterEach(async () => {
      await adapter.disconnect();
      cleanupDb();
    });

    describe("connect / disconnect", () => {
      it("is idempotent on connect", async () => {
        await adapter.connect();
        await adapter.connect();
      });

      it("deduplicates concurrent connect calls", async () => {
        const { db: d, cleanup } = makeTmpDb();
        try {
          const a = new LibSqlStateAdapter({ client: d, logger: mockLogger });
          await Promise.all([a.connect(), a.connect()]);
          await a.disconnect();
        } finally {
          cleanup();
        }
      });

      it("is idempotent on disconnect", async () => {
        await adapter.disconnect();
        await adapter.disconnect();
        await adapter.connect();
      });

      it("does not close external client on disconnect", async () => {
        await adapter.disconnect();
        // The Database is still usable — proving the adapter did not close
        // a client it didn't own.
        const stmt = await db.prepare("SELECT 1 AS v");
        expect(stmt.get().v).toBe(1);
        await adapter.connect();
      });

      it("closes owned client on disconnect", async () => {
        const { path, cleanup } = tmpFilePath();
        try {
          const a = createLibSqlState({ url: path, logger: mockLogger });
          await a.connect();
          const innerDb = a.getClient();
          await a.disconnect();
          // libsql/promise doesn't flip `open` on close(), so assert via
          // behaviour: the closed Database should reject further use.
          await expect(innerDb.prepare("SELECT 1")).rejects.toThrow();
        } finally {
          cleanup();
        }
      });

      it("handles connect failure and allows retry", async () => {
        const { db: broken, cleanup } = makeTmpDb();
        try {
          broken.close();
          const a = new LibSqlStateAdapter({
            client: broken,
            logger: mockLogger,
          });
          await expect(a.connect()).rejects.toThrow();
          expect(mockLogger.error).toHaveBeenCalled();
          await expect(a.connect()).rejects.toThrow();
        } finally {
          cleanup();
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
        const other = new LibSqlStateAdapter({
          client: db,
          keyPrefix: "other",
          logger: mockLogger,
        });
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
        expect(lock?.token).toMatch(LIBSQL_TOKEN_RE);
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
        if (lock) {
          await adapter.releaseLock(lock);
        }
        expect(await adapter.acquireLock("t1", 5000)).not.toBeNull();
      });

      it("extends a lock when the token matches", async () => {
        const lock = await adapter.acquireLock("t1", 5000);
        expect(lock).not.toBeNull();
        if (!lock) {
          return;
        }
        const extended = await adapter.extendLock(lock, 10_000);
        expect(extended).toBe(true);
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

    describe("getClient", () => {
      it("returns the underlying Database", () => {
        expect(adapter.getClient()).toBe(db);
      });
    });
  });

  describe.skip("integration tests against TURSO_DATABASE_URL", () => {
    it("connects to the configured remote", async () => {
      const adapter = createLibSqlState({ logger: mockLogger });
      await adapter.connect();
      await adapter.subscribe("slack:C1:1.2");
      expect(await adapter.isSubscribed("slack:C1:1.2")).toBe(true);
      await adapter.unsubscribe("slack:C1:1.2");
      await adapter.disconnect();
    });
  });
});
