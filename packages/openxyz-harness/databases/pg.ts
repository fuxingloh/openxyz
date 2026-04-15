import { Pool } from "pg";
import { createPostgresState } from "@chat-adapter/state-pg";

/**
 * chat-sdk state backed by a real Postgres server.
 *
 * Used in serverless / hosted deploys where on-disk PGlite isn't viable
 * (function dirs are ephemeral, only `/tmp` is writable, and you want
 * cross-invocation persistence). Point `DATABASE_URL` at a standard
 * Postgres connection string.
 */
export async function createPgState(connectionString: string) {
  const client = new Pool({ connectionString });
  return createPostgresState({ client });
}
