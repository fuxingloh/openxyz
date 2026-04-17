/**
 * Which deploy target is hosting this process.
 *
 * - `local` — `openxyz start`, dev loops, bare Bun server
 * - `vercel` — `openxyz build --output vercel` bakes this into the bundle
 * - `unknown` — env var not provided or set to `"unknown"`. Callers should
 *   treat this as "don't assume anything" and pick a safe default.
 *
 * Channel adapters can branch on `backend()` to pick e.g. webhook vs polling
 * without the template author touching env wiring.
 */
export type Backend = "local" | "vercel" | "unknown";

export function backend(): Backend {
  const v = process.env.OPENXYZ_BACKEND;
  if (v === "local") return "local";
  if (v === "vercel") return "vercel";
  return "unknown";
}
