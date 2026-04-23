import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { connect as connectLocal } from "@tursodatabase/database";
import { connect as connectServerless } from "@tursodatabase/serverless";
import { TursoStateAdapter, type TursoClient } from "@chat-adapter/state-turso";

/**
 * Build a chat-sdk state adapter over Turso.
 *
 * - `TURSO_DATABASE_URL` (+ optional `TURSO_AUTH_TOKEN`) → serverless driver
 *   (fetch-based, edge/Vercel safe). Accepts `libsql://`, `https://`,
 *   `wss://`, and `http://…` for a local `turso dev` server.
 * - else → native `@tursodatabase/database` binding against an embedded
 *   SQLite file at `{cwd}/.openxyz/data/chat-state.db`.
 *
 * Both clients satisfy `TursoClient` structurally. The returned `close()`
 * closes the underlying client — call it after `openxyz.stop()`; the
 * adapter itself is pure DI and never touches the client's lifecycle.
 */
export async function createChatState(cwd: string) {
  const client = await resolveClient(cwd);
  const state = new TursoStateAdapter({ client });
  const close = () => client.close();
  return { state, close };
}

async function resolveClient(cwd: string): Promise<TursoClient> {
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
