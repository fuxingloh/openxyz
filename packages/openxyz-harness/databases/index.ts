import { createPgliteState } from "./pglite";
import { createPgState } from "./pg";

/**
 * Pick the chat-sdk state adapter based on env.
 *
 */
export async function createChatState(cwd: string) {
  const url = process.env.PG_DATABASE_POSTGRES_URL;
  if (url && url.length > 0) return createPgState(url);
  return createPgliteState(cwd);
}

export { createPgliteState, createPgState };
