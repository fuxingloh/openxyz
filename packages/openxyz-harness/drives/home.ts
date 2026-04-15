import { ReadWriteFs, OverlayFs, type MountConfig } from "just-bash";
import type { Drive, Permission } from "./drive.ts";

/**
 * Drive backing the agent's home directory.
 *
 * Default: disk-backed via the template's `cwd` — read-write or read-only
 * depending on the agent's declared filesystem permission.
 *
 * `openxyz build` intercepts this module via a Bun plugin and swaps it for
 * a generated variant whose `HomeDrive` wraps an `InMemoryFs` pre-populated
 * with the packed template snapshot. See `packages/openxyz/bin/cmds/build.ts`.
 */
export class HomeDrive implements Drive {
  constructor(
    readonly cwd: string,
    readonly permission: Permission,
  ) {}

  mountConfig(mountPoint: string): MountConfig {
    if (this.permission === "read-write") {
      return { mountPoint, filesystem: new ReadWriteFs({ root: this.cwd }) };
    }
    return { mountPoint, filesystem: new OverlayFs({ root: this.cwd, readOnly: true }) };
  }
}
