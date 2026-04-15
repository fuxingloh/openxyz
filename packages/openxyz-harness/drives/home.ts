import { ReadWriteFs, OverlayFs, type MountConfig } from "just-bash";
import type { Drive, Permission } from "./drive.ts";
import { IgnoredFs } from "./ignored-fs.ts";

/**
 * Paths hidden from the agent — secrets (`.env*`) and local build/deploy
 * output (`.openxyz/`, `.vercel/`). The same list is duplicated in
 * `packages/openxyz/bin/scan.ts` so the build-time pack step strips them
 * from the packed snapshot. Keep both in sync.
 */
// `**/.env*` catches nested `.env` files too (e.g. templates with subprojects).
const IGNORES = ["**/.env*", ".openxyz", ".vercel"];

/**
 * Drive backing the agent's home directory.
 *
 * Default: disk-backed via the template's `cwd` — read-write or read-only
 * depending on the agent's declared filesystem permission. Wrapped in
 * `IgnoredFs` to hide secrets and local build output.
 *
 * `openxyz build` intercepts this module via a Bun plugin and swaps it for
 * a generated variant whose `HomeDrive` wraps an `InMemoryFs` pre-populated
 * with the packed template snapshot (already filtered at scan time — see
 * `packages/openxyz/bin/scan.ts`). See `packages/openxyz/bin/cmds/build.ts`.
 */
export class HomeDrive implements Drive {
  constructor(
    readonly cwd: string,
    readonly permission: Permission,
  ) {}

  mountConfig(mountPoint: string): MountConfig {
    const inner =
      this.permission === "read-write"
        ? new ReadWriteFs({ root: this.cwd })
        : new OverlayFs({ root: this.cwd, readOnly: true });
    return { mountPoint, filesystem: new IgnoredFs(IGNORES, inner) };
  }
}
