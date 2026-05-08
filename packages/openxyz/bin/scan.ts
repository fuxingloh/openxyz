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
    /** Named `Model` instances (LanguageModel + systemPrompt). Flat namespace — `providers/<name>.ts` is merged in. */
    models: Record<string, string>;
    /** Template-provided `Drive` instances. Filename `drives/<name>.ts` → mount `/mnt/<name>/`. */
    drives: Record<string, string>;
    skills: Record<string, string>;
    /**
     * Path to top-level `AGENTS.md` if present, else undefined. Other top-level
     * `*.md` files (except `README.md`) trigger a warn at scan time so users
     * notice typos / unsupported files. See mnemonic/121 for prior multi-file
     * shape (SOUL/USER/AGENTS) — collapsed to AGENTS-only on 2026-04-30.
     */
    "AGENTS.md"?: string;
  };
  files: string[];
};

export async function scanDir(cwd: string): Promise<OpenXyzFiles> {
  const [channels, tools, agents, models, drives, skills, files] = await Promise.all([
    scanNamed(cwd, "channels/[!_]*.{js,ts}", /\.(js|ts)$/),
    scanNamed(cwd, "tools/[!_]*.{js,ts}", /\.(js|ts)$/),
    scanNamed(cwd, "agents/[!_]*.md", /\.md$/),
    scanNamed(cwd, "models/[!_]*.{js,ts}", /\.(js|ts)$/),
    scanNamed(cwd, "drives/[!_]*.{js,ts}", /\.(js|ts)$/),
    scanSkills(cwd),
    scanFiles(cwd),
  ]);

  // Sweep top-level `*.md`. AGENTS.md loads. README.md is the template
  // author's concern — skip silently, any case. Anything else gets a warning
  // so users notice typos / unsupported files instead of wondering why their
  // `Agents.md` or `notes.md` had no effect.
  let agentsMdPath: string | undefined;
  for await (const entry of new Bun.Glob("*.md").scan({ cwd, onlyFiles: true })) {
    if (entry === "AGENTS.md") {
      agentsMdPath = entry;
      continue;
    }
    if (entry.toLowerCase() === "readme.md") continue;
    console.warn(`[openxyz] "${entry}" not loaded — only AGENTS.md is injected into the system prompt`);
  }

  if (!models["auto"]) {
    throw new Error(
      "missing required file: models/auto.ts\n" +
        '  The shipped default agents (auto, explore, research, compact) reference `model: "auto"`.\n' +
        "  Create models/auto.ts with a `default` export that returns a LanguageModel,\n" +
        '  e.g. dispatch on OPENXYZ_MODEL or `export default anthropic("claude-sonnet-4-5")`.\n' +
        "  See templates/openxyz-janitor/models/auto.ts for a reference implementation.",
    );
  }

  return {
    cwd,
    template: { channels, tools, agents, models, drives, skills, "AGENTS.md": agentsMdPath },
    files,
  };
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

// Agent-facing deny (`.env*`, `.openxyz/`, `.vercel/`, `dist/`, `public/`,
// `wrangler.{jsonc,toml}`) also enforced at runtime by
// `@openxyz/runtime/drives/filtered-fs` — keep the two lists in sync.
// Build-only noise (`node_modules/`, `.git/`, `.DS_Store`) is appended here;
// those don't need runtime enforcement, they'd just bloat the packed bundle.
const IGNORE = [
  /(^|\/)\.env/,
  /^\.openxyz(\/|$)/,
  /^\.vercel(\/|$)/,
  /^dist(\/|$)/,
  /^public(\/|$)/,
  /^wrangler\.(jsonc|toml)$/,
  /^node_modules\//,
  /^\.git\//,
  /(^|\/)\.DS_Store$/,
];

/**
 * Walks the whole template dir, minus the ignore list. Anything that survives
 * the filter goes into the VFS as-is — source files, markdown, package.json,
 * plus anything else the template author chose to drop in.
 */
async function scanFiles(cwd: string): Promise<string[]> {
  const out: string[] = [];
  for await (const rel of new Bun.Glob("**/*").scan({ cwd, onlyFiles: true })) {
    if (IGNORE.some((re) => re.test(rel))) continue;
    out.push(rel);
  }
  return out;
}
