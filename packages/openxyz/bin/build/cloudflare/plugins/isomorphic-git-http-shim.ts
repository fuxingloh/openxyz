import { dirname } from "node:path";
import type { BunPlugin } from "bun";

/**
 * `isomorphic-git/http/node` pulls in `simple-get`, which imports `node:http`
 * at module top level. Workers' deploy-time validator rejects `node:http`
 * regardless of nodejs_compat flags (the import is statically analyzed), so
 * any drive built on isomorphic-git fails to upload — the bundle never even
 * gets a chance to run.
 *
 * `isomorphic-git/http/web` is the same HTTP adapter implemented over `fetch`
 * with no Node dependencies. It works on workerd. Aliasing the node entry to
 * the web entry on the cloudflare build lets `GitHubDrive` and
 * `CloudflareArtifactsDrive` ship — and at runtime they speak the same Git
 * wire protocol either way.
 */
export function isomorphicGitHttpShimPlugin(): BunPlugin {
  return {
    name: "openxyz-isomorphic-git-http-shim",
    setup(build) {
      // Resolve from the importer's directory so we find the same
      // `isomorphic-git` install the importer depends on (it's a dep of the
      // vendor packages, not of the openxyz facade).
      build.onResolve({ filter: /^isomorphic-git\/http\/node$/ }, (args) => ({
        path: Bun.resolveSync("isomorphic-git/http/web", dirname(args.importer)),
      }));
    },
  };
}
