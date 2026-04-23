import type { BunPlugin } from "bun";

/**
 * Vercel-target build plugin — replaces `getDb` with a serverless-only
 * implementation so a misconfigured deploy fails loudly at first cold-start
 * instead of silently falling back to the local `@tursodatabase/database`
 * driver and writing to Vercel's read-only cwd (mnemonic/067).
 *
 * Requires `TURSO_DATABASE_URL` (+ optional `TURSO_AUTH_TOKEN`).
 */
export function forceTursoServerlessPlugin(): BunPlugin {
  const indexPath = new URL("../../../../openxyz-runtime/databases/index.ts", import.meta.url).pathname;

  return {
    name: "openxyz-force-turso-serverless",
    setup(build) {
      build.onLoad({ filter: /[\\/]databases[\\/]index\.ts$/ }, (args) => {
        if (args.path !== indexPath) return;
        return {
          loader: "ts",
          contents: [
            `import { connect } from "@tursodatabase/serverless";`,
            ``,
            `export async function getDb() {`,
            `  const url = process.env.TURSO_DATABASE_URL;`,
            `  if (!url || url.length === 0) {`,
            `    throw new Error(`,
            `      "[openxyz] Vercel deploy requires TURSO_DATABASE_URL (+ optional TURSO_AUTH_TOKEN). The local turso driver is stripped from the bundle."`,
            `    );`,
            `  }`,
            `  console.log("[openxyz] state: turso (serverless)");`,
            `  return connect({ url, authToken: process.env.TURSO_AUTH_TOKEN });`,
            `}`,
          ].join("\n"),
        };
      });
    },
  };
}
