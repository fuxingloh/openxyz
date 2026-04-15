import { createPgliteState } from "./pglite";
import { createPgState } from "./pg";

/**
 * Pick the chat-sdk state adapter based on env.
 *
 * `PG_DATABASE_URL` (if set) → real Postgres — for serverless / hosted deploys.
 * Otherwise → PGlite on disk under `.openxyz/pglite` — for local dev.
 */
export async function createChatState(cwd: string) {
  const url = process.env.PG_DATABASE_URL;
  if (url && url.length > 0) return createPgState(url);
  return createPgliteState(cwd);
}

export { createPgliteState, createPgState };
