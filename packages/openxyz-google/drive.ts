import type { IFileSystem } from "just-bash";
import { GDriveFs } from "just-bash-gdrive";
import type { Drive, Permission } from "@openxyz/runtime/drive";
import { ReadOnlyFs } from "@openxyz/runtime/fs/readonly";

export type GoogleDriveConfig = {
  /**
   * OAuth2 access token for Google Drive. Accepts a string for scripts/testing
   * or an async provider for long-running agents — the provider is called on
   * each request so tokens can be refreshed transparently.
   *
   * Scopes: `https://www.googleapis.com/auth/drive` for read-write,
   * `https://www.googleapis.com/auth/drive.readonly` is enough for read-only.
   */
  accessToken: string | (() => Promise<string>);
  /**
   * Google Drive folder ID to mount as the drive root. Defaults to the user's
   * entire Drive (`root`). Constrain to a specific folder to scope the agent's
   * visibility and write surface.
   */
  rootFolderId?: string;
  /**
   * Defaults to `read-only`. On `read-only` the drive is wrapped with
   * `ReadOnlyFs` so writes throw `EACCES` before touching Drive. On
   * `read-write` writes propagate directly to Drive (there's no commit
   * ceremony — writes are synchronous against the remote).
   */
  permission?: Permission;
  /**
   * Pre-list every path under `rootFolderId` on first `refresh()` so
   * `glob`/`find` work. Listing is eager and recursive, so expect long waits
   * on large drives. Off by default — enable for bounded folders where the
   * agent needs directory-wide search.
   */
  prefetch?: boolean;
};

/**
 * Mount a Google Drive folder at `/mnt/<name>/`. Reads and writes hit Drive's
 * REST API directly via `just-bash-gdrive`'s `GDriveFs`.
 *
 * ### Lifecycle
 *
 * - `refresh()` — no-op by default. With `prefetch: true`, calls
 *   `GDriveFs.prefetchAllPaths()` on first invocation so glob/find see the
 *   full tree. Runs before every agent turn.
 * - `fs()` — returns `GDriveFs` (writable) or `ReadOnlyFs` wrapping it
 *   (read-only). There is no cloned working copy; each filesystem call is
 *   a live Drive request.
 * - `commit()` — not implemented. Writes are synchronous against Drive,
 *   so there's nothing to flush at the end of the turn.
 *
 * Serverless note: `GDriveFs` caches path→id lookups in memory. On Vercel's
 * per-invocation isolation, the cache is lost between cold starts — that's
 * fine for correctness (Drive is the source of truth) but means the first
 * turn after a cold start pays listing latency.
 */
export class GoogleDrive implements Drive {
  readonly rootFolderId: string | undefined;
  readonly permission: Permission;
  readonly prefetch: boolean;
  readonly #accessToken: GoogleDriveConfig["accessToken"];
  #gdrive?: GDriveFs;
  #fs?: IFileSystem;
  #prefetched = false;

  constructor(cfg: GoogleDriveConfig) {
    this.#accessToken = cfg.accessToken;
    this.rootFolderId = cfg.rootFolderId;
    this.permission = cfg.permission ?? "read-only";
    this.prefetch = cfg.prefetch ?? false;
  }

  async refresh(): Promise<void> {
    if (!this.#gdrive) {
      this.#gdrive = new GDriveFs({
        accessToken: this.#accessToken,
        rootFolderId: this.rootFolderId,
      });
    }
    if (this.prefetch && !this.#prefetched) {
      await this.#gdrive.prefetchAllPaths();
      this.#prefetched = true;
    }
  }

  fs(): IFileSystem {
    if (this.#fs) return this.#fs;
    if (!this.#gdrive) {
      throw new Error(`[openxyz/google] GoogleDrive.fs() called before refresh() — runtime must await refresh() first`);
    }
    this.#fs = this.permission === "read-write" ? this.#gdrive : new ReadOnlyFs(this.#gdrive);
    return this.#fs;
  }
}
