import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Filesystem enumeration of a template. No module execution, no file reads —
 * just paths keyed by name. Consumers decide what to do with them:
 *
 * - `openxyz start` loads modules + parses markdown (see `loadTemplate`)
 * - `openxyz build` code-gens static imports
 *
 * Paths under `template` are relative to `cwd`. `files` is every other
 * template-dir file we found but didn't route into a specific slot — the
 * build packs them into the runtime VFS as-is.
 */
export type OpenXyzFiles = {
  cwd: string;
  template: {
    channels: Record<string, string>;
    tools: Record<string, string>;
    agents: Record<string, string>;
    skills: Record<string, string>;
    /** Top-level markdown injected into prompts, e.g. `agents` → `AGENTS.md`. */
    mds: Record<string, string>;
  };
  files: string[];
};

export async function scanTemplate(cwd: string): Promise<OpenXyzFiles> {
  const [channels, tools, agents, skills, files] = await Promise.all([
    scanNamed(cwd, "channels/[!_]*.ts", /\.ts$/),
    scanNamed(cwd, "tools/[!_]*.{js,ts}", /\.(js|ts)$/),
    scanNamed(cwd, "agents/[!_]*.md", /\.md$/),
    scanSkills(cwd),
    scanVfs(cwd),
  ]);

  const mds: Record<string, string> = {};
  if (existsSync(join(cwd, "AGENTS.md"))) mds.agents = "AGENTS.md";

  return { cwd, template: { channels, tools, agents, skills, mds }, files };
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
 * Walks the whole template dir, minus the ignore list. Anything that survives
 * the filter goes into the VFS as-is — source files, markdown, package.json,
 * plus anything else the template author chose to drop in.
 */
const IGNORE = [/^node_modules\//, /^\.openxyz\//, /^\.vercel\//, /^\.git\//, /(^|\/)\.env/, /(^|\/)\.DS_Store$/];

async function scanVfs(cwd: string): Promise<string[]> {
  const out: string[] = [];
  for await (const rel of new Bun.Glob("**/*").scan({ cwd, onlyFiles: true })) {
    if (IGNORE.some((re) => re.test(rel))) continue;
    out.push(rel);
  }
  return out;
}
