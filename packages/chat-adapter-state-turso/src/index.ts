import type { Lock, Logger, QueueEntry, StateAdapter } from "chat";
import { ConsoleLogger } from "chat";
import type { Connection } from "@tursodatabase/serverless";
import type { Database } from "@tursodatabase/database";

/**
 * A constructed turso driver client. `@tursodatabase/serverless` for remote
 * (fetch-based, edge/serverless safe); `@tursodatabase/database` for local
 * (native binding, embedded file). The two packages are kept API-compatible
 * upstream, so the adapter treats them uniformly: `await client.prepare(sql)`
 * (sync returns pass through), `stmt.run([args])` as an array.
 */
export type TursoClient = Connection | Database;

export interface TursoStateAdapterOptions {
  /** A constructed client — `connect()` result from either turso driver. */
  client: TursoClient;
  /** Key prefix for all rows (default: "chat-sdk"). */
  keyPrefix?: string;
  /** Logger instance for error reporting. */
  logger?: Logger;
}

export class TursoStateAdapter implements StateAdapter {
  private readonly client: TursoClient;
  private readonly keyPrefix: string;
  private readonly logger: Logger;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(options: TursoStateAdapterOptions) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix || DEFAULT_KEY_PREFIX;
    this.logger = options.logger ?? new ConsoleLogger("info").child("turso");
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        try {
          await this.ensureSchema();
          this.connected = true;
        } catch (error) {
          this.connectPromise = null;
          this.logger.error("turso connect failed", { error });
          throw error;
        }
      })();
    }
    await this.connectPromise;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.connectPromise = null;
  }

  async subscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    const stmt = await this.client.prepare(
      `INSERT INTO chat_state_subscriptions (key_prefix, thread_id)
       VALUES (?, ?) ON CONFLICT DO NOTHING`,
    );
    await stmt.run([this.keyPrefix, threadId]);
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    const stmt = await this.client.prepare(
      `DELETE FROM chat_state_subscriptions WHERE key_prefix = ? AND thread_id = ?`,
    );
    await stmt.run([this.keyPrefix, threadId]);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    this.ensureConnected();
    const stmt = await this.client.prepare(
      `SELECT 1 AS present FROM chat_state_subscriptions
       WHERE key_prefix = ? AND thread_id = ? LIMIT 1`,
    );
    const row = await stmt.get([this.keyPrefix, threadId]);
    return row !== undefined && row !== null;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.ensureConnected();
    const token = generateToken();
    const now = Date.now();
    const expiresAt = now + ttlMs;

    const delExpired = await this.client.prepare(
      `DELETE FROM chat_state_locks
       WHERE key_prefix = ? AND thread_id = ? AND expires_at <= ?`,
    );
    const insert = await this.client.prepare(
      `INSERT INTO chat_state_locks (key_prefix, thread_id, token, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key_prefix, thread_id) DO NOTHING
       RETURNING thread_id, token, expires_at`,
    );

    const row = await this.client.transaction(async () => {
      await delExpired.run([this.keyPrefix, threadId, now]);
      return await insert.get([this.keyPrefix, threadId, token, expiresAt, now]);
    })();

    if (!row) return null;
    return {
      threadId: row.thread_id as string,
      token: row.token as string,
      expiresAt: Number(row.expires_at),
    };
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.ensureConnected();
    const stmt = await this.client.prepare(`DELETE FROM chat_state_locks WHERE key_prefix = ? AND thread_id = ?`);
    await stmt.run([this.keyPrefix, threadId]);
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.ensureConnected();
    const stmt = await this.client.prepare(
      `DELETE FROM chat_state_locks
       WHERE key_prefix = ? AND thread_id = ? AND token = ?`,
    );
    await stmt.run([this.keyPrefix, lock.threadId, lock.token]);
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    this.ensureConnected();
    const now = Date.now();
    const stmt = await this.client.prepare(
      `UPDATE chat_state_locks
       SET expires_at = ?, updated_at = ?
       WHERE key_prefix = ? AND thread_id = ? AND token = ? AND expires_at > ?
       RETURNING thread_id`,
    );
    const row = await stmt.get([now + ttlMs, now, this.keyPrefix, lock.threadId, lock.token, now]);
    return row !== undefined && row !== null;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.ensureConnected();
    const now = Date.now();
    const select = await this.client.prepare(
      `SELECT value FROM chat_state_cache
       WHERE key_prefix = ? AND cache_key = ?
         AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
    );
    const row = await select.get([this.keyPrefix, key, now]);
    if (!row) {
      const del = await this.client.prepare(
        `DELETE FROM chat_state_cache
         WHERE key_prefix = ? AND cache_key = ?
           AND expires_at IS NOT NULL AND expires_at <= ?`,
      );
      await del.run([this.keyPrefix, key, now]);
      return null;
    }
    return decodeStored<T>(row.value as string);
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.ensureConnected();
    const now = Date.now();
    const serialized = JSON.stringify(value);
    const expiresAt = ttlMs ? now + ttlMs : null;
    const stmt = await this.client.prepare(
      `INSERT INTO chat_state_cache (key_prefix, cache_key, value, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key_prefix, cache_key) DO UPDATE
         SET value = excluded.value,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
    );
    await stmt.run([this.keyPrefix, key, serialized, expiresAt, now]);
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    this.ensureConnected();
    const now = Date.now();
    const serialized = JSON.stringify(value);
    const expiresAt = ttlMs ? now + ttlMs : null;

    const delExpired = await this.client.prepare(
      `DELETE FROM chat_state_cache
       WHERE key_prefix = ? AND cache_key = ?
         AND expires_at IS NOT NULL AND expires_at <= ?`,
    );
    const insert = await this.client.prepare(
      `INSERT INTO chat_state_cache (key_prefix, cache_key, value, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key_prefix, cache_key) DO NOTHING
       RETURNING cache_key`,
    );

    const row = await this.client.transaction(async () => {
      await delExpired.run([this.keyPrefix, key, now]);
      return await insert.get([this.keyPrefix, key, serialized, expiresAt, now]);
    })();

    return row !== undefined && row !== null;
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected();
    const stmt = await this.client.prepare(`DELETE FROM chat_state_cache WHERE key_prefix = ? AND cache_key = ?`);
    await stmt.run([this.keyPrefix, key]);
  }

  async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }): Promise<void> {
    this.ensureConnected();
    const serialized = JSON.stringify(value);
    const expiresAt = options?.ttlMs ? Date.now() + options.ttlMs : null;

    const insert = await this.client.prepare(
      `INSERT INTO chat_state_lists (key_prefix, list_key, value, expires_at)
       VALUES (?, ?, ?, ?)`,
    );
    const refreshTtl = await this.client.prepare(
      `UPDATE chat_state_lists SET expires_at = ?
       WHERE key_prefix = ? AND list_key = ?`,
    );
    const trim = await this.client.prepare(
      `DELETE FROM chat_state_lists
       WHERE key_prefix = ? AND list_key = ? AND seq NOT IN (
         SELECT seq FROM chat_state_lists
         WHERE key_prefix = ? AND list_key = ?
         ORDER BY seq DESC LIMIT ?
       )`,
    );

    await this.client.transaction(async () => {
      await insert.run([this.keyPrefix, key, serialized, expiresAt]);
      if (expiresAt !== null) await refreshTtl.run([expiresAt, this.keyPrefix, key]);
      if (options?.maxLength && options.maxLength > 0) {
        await trim.run([this.keyPrefix, key, this.keyPrefix, key, options.maxLength]);
      }
    })();
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    this.ensureConnected();
    const now = Date.now();
    const del = await this.client.prepare(
      `DELETE FROM chat_state_lists
       WHERE key_prefix = ? AND list_key = ?
         AND expires_at IS NOT NULL AND expires_at <= ?`,
    );
    await del.run([this.keyPrefix, key, now]);

    const select = await this.client.prepare(
      `SELECT value FROM chat_state_lists
       WHERE key_prefix = ? AND list_key = ? ORDER BY seq ASC`,
    );
    const rows = await select.all([this.keyPrefix, key]);
    return rows.map((row) => decodeStored<T>(row.value as string));
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    this.ensureConnected();
    const now = Date.now();
    const serialized = JSON.stringify(entry);

    const purge = await this.client.prepare(
      `DELETE FROM chat_state_queues
       WHERE key_prefix = ? AND thread_id = ? AND expires_at <= ?`,
    );
    const insert = await this.client.prepare(
      `INSERT INTO chat_state_queues (key_prefix, thread_id, value, expires_at)
       VALUES (?, ?, ?, ?)`,
    );
    const trim = await this.client.prepare(
      `DELETE FROM chat_state_queues
       WHERE key_prefix = ? AND thread_id = ? AND seq NOT IN (
         SELECT seq FROM chat_state_queues
         WHERE key_prefix = ? AND thread_id = ?
         ORDER BY seq DESC LIMIT ?
       )`,
    );
    const countStmt = await this.client.prepare(
      `SELECT COUNT(*) AS depth FROM chat_state_queues
       WHERE key_prefix = ? AND thread_id = ? AND expires_at > ?`,
    );

    return await this.client.transaction(async () => {
      await purge.run([this.keyPrefix, threadId, now]);
      await insert.run([this.keyPrefix, threadId, serialized, entry.expiresAt]);
      if (maxSize > 0) {
        await trim.run([this.keyPrefix, threadId, this.keyPrefix, threadId, maxSize]);
      }
      const row = await countStmt.get([this.keyPrefix, threadId, now]);
      return toNumber(row?.depth);
    })();
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    this.ensureConnected();
    const now = Date.now();
    const purge = await this.client.prepare(
      `DELETE FROM chat_state_queues
       WHERE key_prefix = ? AND thread_id = ? AND expires_at <= ?`,
    );
    const pick = await this.client.prepare(
      `SELECT seq, value FROM chat_state_queues
       WHERE key_prefix = ? AND thread_id = ? AND expires_at > ?
       ORDER BY seq ASC LIMIT 1`,
    );
    const del = await this.client.prepare("DELETE FROM chat_state_queues WHERE seq = ?");

    const value = await this.client.transaction(async () => {
      await purge.run([this.keyPrefix, threadId, now]);
      const row = await pick.get([this.keyPrefix, threadId, now]);
      if (!row) return null;
      await del.run([row.seq]);
      return row.value as string;
    })();

    if (value === null) return null;
    return JSON.parse(value) as QueueEntry;
  }

  async queueDepth(threadId: string): Promise<number> {
    this.ensureConnected();
    const stmt = await this.client.prepare(
      `SELECT COUNT(*) AS depth FROM chat_state_queues
       WHERE key_prefix = ? AND thread_id = ? AND expires_at > ?`,
    );
    const row = await stmt.get([this.keyPrefix, threadId, Date.now()]);
    return toNumber(row?.depth);
  }

  private async ensureSchema(): Promise<void> {
    for (const sql of SCHEMA_SQL) await this.client.exec(sql);
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("TursoStateAdapter is not connected. Call connect() first.");
    }
  }
}

const DEFAULT_KEY_PREFIX = "chat-sdk";

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS chat_state_subscriptions (
    key_prefix TEXT NOT NULL,
    thread_id  TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (key_prefix, thread_id)
  )`,
  `CREATE TABLE IF NOT EXISTS chat_state_locks (
    key_prefix TEXT NOT NULL,
    thread_id  TEXT NOT NULL,
    token      TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (key_prefix, thread_id)
  )`,
  `CREATE TABLE IF NOT EXISTS chat_state_cache (
    key_prefix TEXT NOT NULL,
    cache_key  TEXT NOT NULL,
    value      TEXT NOT NULL,
    expires_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (key_prefix, cache_key)
  )`,
  `CREATE INDEX IF NOT EXISTS chat_state_locks_expires_idx ON chat_state_locks (expires_at)`,
  `CREATE INDEX IF NOT EXISTS chat_state_cache_expires_idx ON chat_state_cache (expires_at)
   WHERE expires_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS chat_state_lists (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    key_prefix TEXT NOT NULL,
    list_key   TEXT NOT NULL,
    value      TEXT NOT NULL,
    expires_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS chat_state_lists_key_idx ON chat_state_lists (key_prefix, list_key, seq)`,
  `CREATE INDEX IF NOT EXISTS chat_state_lists_expires_idx ON chat_state_lists (expires_at)
   WHERE expires_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS chat_state_queues (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    key_prefix TEXT NOT NULL,
    thread_id  TEXT NOT NULL,
    value      TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS chat_state_queues_thread_idx ON chat_state_queues (key_prefix, thread_id, seq)`,
  `CREATE INDEX IF NOT EXISTS chat_state_queues_expires_idx ON chat_state_queues (expires_at)`,
];

function toNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

function generateToken(): string {
  return `turso_${crypto.randomUUID()}`;
}

function decodeStored<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as unknown as T;
  }
}
