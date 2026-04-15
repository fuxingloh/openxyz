import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createPostgresState } from "@chat-adapter/state-pg";

/**
 * chat-sdk state backed by PGlite on disk.
 *
 * PGlite is Postgres compiled to WASM — no external server, single embedded
 * file store. `@chat-adapter/state-pg` targets `pg.Pool`, so we duck-type a
 * Pool around PGlite (it only calls `.query(text, params)` and `.end()`;
 * PGlite's query result shape — `{ rows, affectedRows }` — is compatible
 * since state-pg never reads `rowCount`).
 */
export async function createPgliteState(cwd: string) {
  const dataDir = join(cwd, ".openxyz", "pglite");
  // PGlite does a bare `mkdir(dataDir)` (non-recursive) — create parents ourselves.
  await mkdir(dataDir, { recursive: true });
  const pg = new PGlite(dataDir);
  await pg.waitReady;

  const pool = {
    query: (text: string, params?: unknown[]) => pg.query(text, params as unknown[] | undefined),
    end: () => pg.close(),
  };

  // Cast: state-pg demands pg.Pool at the type level but only uses `.query` + `.end`.
  return createPostgresState({ client: pool as never });
}
