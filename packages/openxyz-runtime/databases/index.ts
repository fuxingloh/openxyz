import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { connect as connectLocal } from "@tursodatabase/database";
import { connect as connectServerless } from "@tursodatabase/serverless";
import type { TursoClient } from "@chat-adapter/state-turso";

/**
 * Resolve a Turso driver client from the environment.
 *
 * - `TURSO_DATABASE_URL` (+ optional `TURSO_AUTH_TOKEN`) → serverless driver
 *   (fetch-based, edge/Vercel safe). Accepts `libsql://`, `https://`,
 *   `wss://`, and `http://…` for a local `turso dev` server.
 * - else → native `@tursodatabase/database` binding against an embedded
 *   SQLite file at `{cwd}/.openxyz/data/chat-state.db`.
 *
 * The caller wires this into `new TursoStateAdapter({ client })` and is
 * responsible for `client.close()` on shutdown.
 */
export async function getDb(cwd: string): Promise<TursoClient> {
  const url = process.env.TURSO_DATABASE_URL;
  if (url && url.length > 0) {
    console.log("[openxyz] state: turso (serverless)");
    return connectServerless({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  const dataDir = join(cwd, ".openxyz", "data");
  await mkdir(dataDir, { recursive: true });
  console.log("[openxyz] state: turso (local)");
  return connectLocal(join(dataDir, "chat-state.db"));
}
