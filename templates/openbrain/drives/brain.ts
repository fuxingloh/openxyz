import { GitHubDrive } from "@openxyz-provider/github/drive";
import { env } from "openxyz/env";

export default new GitHubDrive({
  owner: env.BRAIN_GH_OWNER.describe("GitHub owner (user or org) of the repo backing this brain"),
  repo: env.BRAIN_GH_REPO.describe("GitHub repo name backing this brain"),
  branch: "main",
  permission: "read-write",
  token: env.BRAIN_GH_TOKEN.describe(
    "GitHub token with read+write access to the brain repo (fine-grained PAT or App installation token)",
  ),
});
