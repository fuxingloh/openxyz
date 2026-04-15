import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Filesystem enumeration of a template. No module execution, no file reads —
 * just paths keyed by name. Consumers decide what to do with them:
 *
 * - `openxyz start` loads modules + parses markdown (see `loadTemplate`)
 * - `openxyz build` code-gens static imports
 *
 * Every value is a path relative to `cwd`.
 */
export type OpenXyzTemplateFiles = {
  cwd: string;
  channels: Record<string, string>;
  tools: Record<string, string>;
  agents: Record<string, string>;
  skills: Record<string, string>;
  /** Top-level markdown injected into prompts, e.g. `agents` → `AGENTS.md`. */
  mds: Record<string, string>;
  /** All files that should be packed into the runtime VFS. */
  vfs: string[];
};

export async function scanTemplate(cwd: string): Promise<OpenXyzTemplateFiles> {
  const [channels, tools, agents, skills, vfs] = await Promise.all([
    scanNamed(cwd, "channels/[!_]*.ts", /\.ts$/),
    scanNamed(cwd, "tools/[!_]*.{js,ts}", /\.(js|ts)$/),
    scanNamed(cwd, "agents/[!_]*.md", /\.md$/),
    scanSkills(cwd),
    scanVfs(cwd),
  ]);

  const mds: Record<string, string> = {};
  if (existsSync(join(cwd, "AGENTS.md"))) mds.agents = "AGENTS.md";

  return { cwd, channels, tools, agents, skills, mds, vfs };
}

async function scanNamed(cwd: string, pattern: string, stripExt: RegExp): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const path of new Bun.Glob(pattern).scan({ cwd })) {
    const name = path.split("/").pop()!.replace(stripExt, "");
    out[name] = path;
  }
  return out;
}

/** Skills are keyed by their containing directory name: `skills/<name>/SKILL.md`. */
async function scanSkills(cwd: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const path of new Bun.Glob("skills/**/SKILL.md").scan({ cwd })) {
    const parts = path.split("/");
    const name = parts[parts.length - 2]!;
    out[name] = path;
  }
  return out;
}

/**
 * Walks the template dir for every file that should be packed into the runtime
 * VFS — source files, markdown, package.json. Skips build output, deps, git,
 * env files, and the usual darwin noise.
 */
async function scanVfs(cwd: string): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const patterns = ["channels/**/*", "tools/**/*", "agents/**/*", "skills/**/*", "*.md", "package.json"];
  for (const pattern of patterns) {
    for await (const rel of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) {
      if (seen.has(rel) || isExcluded(rel)) continue;
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

function isExcluded(rel: string): boolean {
  const skip = ["node_modules/", ".openxyz/", ".vercel/", ".git/", ".env", ".DS_Store"];
  return skip.some((p) => rel.startsWith(p) || rel.endsWith(p) || rel.includes(`/${p.replace(/\/$/, "")}/`));
}
