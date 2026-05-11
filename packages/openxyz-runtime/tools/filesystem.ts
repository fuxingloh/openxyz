import { Bash, MountableFs, type MountConfig } from "just-bash";
import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import type { Drive, Permission } from "../drive.ts";
import { ReadOnlyFs } from "../fs/readonly";

const MAX_BYTES = 50_000;

function digest(content: string): string {
  return Bun.hash(content).toString(36);
}

async function tryReadFile(shell: Bash, path: string): Promise<string | undefined> {
  try {
    return await shell.readFile(path);
  } catch {
    return undefined;
  }
}

const DrivePermEnum = z.enum(["read-only", "read-write"]);

// Record form keys are absolute mount paths (`/workspace`, `/mnt/notes`, …).
// `*` is a fallback applied to any mount not listed explicitly — lets agents
// say "/workspace read-write, everything else read-only" without enumerating
// template-defined mounts at agent-definition time.
export const FilesystemConfigSchema = z
  .union([DrivePermEnum, z.record(z.union([z.literal("*"), z.string().startsWith("/")]), DrivePermEnum)])
  .default("read-write");

export type FilesystemConfig = z.infer<typeof FilesystemConfigSchema>;

function getMountPermission(mountPath: string, config: FilesystemConfig): Permission | undefined {
  if (typeof config === "string") return config;
  if (mountPath in config) return config[mountPath];
  return config["*"];
}

export class FilesystemTools {
  readonly #bash: Bash;
  // path → content hash at last successful `read` / `write` / `edit`. Scoped
  // to this instance, which the factory creates fresh per agent turn — so the
  // read-set resets every turn. `edit` and `write`-over-existing require an
  // entry here whose hash still matches the file on disk; this catches both
  // "agent forgot to read" and "file changed since read" (including changes
  // made by `bash` between turns or out-of-band).
  readonly #reads = new Map<string, string>();

  /**
   * Build the agent's filesystem from pre-connected drives + a per-agent
   * permission config.
   *
   * - `drives` is keyed by absolute mount path (`/workspace`, `/mnt/notes`,
   *   …). The caller pre-instantiates every drive — including `WorkspaceDrive` at
   *   `/workspace`, which is always present — and has already called
   *   `refresh()` on each.
   * - `config` decides which paths this agent can see and at what permission.
   *   String form applies uniformly; record form gates per mount path. In
   *   record form a `*` key is a fallback for any mount not listed explicitly;
   *   without `*`, unlisted mounts are dropped.
   *
   * When the config says a mount is `read-only` but the drive itself is
   * read-write capable, we wrap in `ReadOnlyFs` to enforce the agent's
   * permission without mutating the drive's own state.
   */
  constructor(drives: Record<string, Drive>, config: FilesystemConfig) {
    const configs: MountConfig[] = [];
    for (const [mountPoint, drive] of Object.entries(drives)) {
      const perm = getMountPermission(mountPoint, config);
      if (perm === undefined) continue;
      const inner = drive.fs();
      const filesystem = perm === "read-only" ? new ReadOnlyFs(inner) : inner;
      configs.push({ mountPoint, filesystem });
    }

    const fs = new MountableFs({ mounts: configs });
    this.#bash = new Bash({
      fs,
      cwd: "/workspace",
      python: true,
      javascript: true,
      // Enables built-in `curl` / `wget` in just-bash. Skills that document
      // `curl -H "Authorization: …"` (TranscriptAPI, OpenAI direct, etc.)
      // need this — the agent has no host shell to fall back to.
      // `dangerouslyAllowFullInternetAccess` skips the allow-list and the
      // GET/HEAD-only method default. `denyPrivateRanges` blocks loopback /
      // RFC1918 / link-local so the bash sandbox can't probe the deployment's
      // metadata service or sibling internal containers.
      network: {
        dangerouslyAllowFullInternetAccess: true,
        denyPrivateRanges: true,
      },
    });
  }

  tools(): Record<string, Tool> {
    const shell = this.#bash;
    const reads = this.#reads;

    return {
      bash: tool({
        description: [
          "Executes a bash command in a sandboxed shell with optional timeout.",
          "",
          `All commands run in /workspace (your workspace) by default. Use \`workdir\` to run in a different directory. Prefer \`workdir\` over \`cd <dir> && <command>\`.`,
          "",
          "Layout:",
          `  /workspace/   — your workspace (tools, skills, channels, agents, documents)`,
          "  /mnt/<name>/     — mounted backends (e.g. gdrive, notion)",
          "",
          "Prefer the purpose-built filesystem tools (`read`, `write`, `edit`, `glob`, `grep`) over bash when the task fits one of them — they return structured output and are cheaper. Reach for `bash` when you need a real shell: piping, scripts, installed binaries, archive handling, process inspection.",
          "",
          "Notes:",
          "  - Write a clear 5-10 word `description` of what the command does.",
          "  - Optional `timeout` in milliseconds, default 120000.",
          "  - Output is concatenated stdout+stderr, capped at 50KB.",
          "  - For parallel work, issue multiple tool calls in one message.",
          "  - Use `;` for sequential commands where failures don't matter; `&&` when later commands depend on earlier success.",
          "  - Do NOT use newlines to separate commands (newlines are fine inside quoted strings).",
        ].join("\n"),
        inputSchema: z.object({
          command: z.string().describe("The bash command to execute."),
          workdir: z.string().describe("Working directory for the command."),
          timeout: z.number().optional().describe("Timeout in milliseconds. Defaults to 120000 (2 minutes)."),
          description: z.string().describe("Clear 5-10 word description of what the command does."),
        }),
        execute: async ({ command, workdir, timeout }) => {
          const res = await shell.exec(command, {
            cwd: workdir,
            signal: AbortSignal.timeout(timeout ?? 120_000),
          });
          const out = [res.stdout, res.stderr].filter(Boolean).join("\n");
          const body = out.length > MAX_BYTES ? `${out.slice(0, MAX_BYTES)}\n[truncated]` : out;
          return `<exit_code>${res.exitCode}</exit_code>\n${body}`;
        },
      }),

      read: tool({
        description:
          "Read a file from your workspace or a mounted backend. Returns line-numbered content. Defaults to the first 2000 lines; pass `offset` and `limit` to read further into long files. Every result reports the visible line range and total line count — if you want more of the file, call `read` again with `offset` set to the next unseen line.",
        inputSchema: z.object({
          path: z.string().describe(`Absolute path, e.g. /workspace/AGENTS.md`),
          offset: z.number().optional().describe("Line number to start reading from (1-indexed). Defaults to 1."),
          limit: z.number().optional().describe("Maximum number of lines to return. Defaults to 2000."),
        }),
        execute: async ({ path, offset, limit }) => {
          const content = await shell.readFile(path);
          reads.set(path, digest(content));
          const lines = content.split("\n");
          const total = lines.length;
          const start = Math.max(0, (offset ?? 1) - 1);
          const end = Math.min(total, start + (limit ?? 2000));
          const numbered = lines
            .slice(start, end)
            .map((line, i) => `${String(start + i + 1).padStart(6)}  ${line}`)
            .join("\n");
          const footer =
            end < total
              ? `\n[showing lines ${start + 1}-${end} of ${total} — call read again with offset=${end + 1} to continue]`
              : `\n[end of file — ${total} lines total]`;
          return numbered + footer;
        },
      }),

      write: tool({
        description: [
          "Write a file. Overwrites existing content. Parent directories are created automatically.",
          "",
          "If the file already exists you must `read` it first in this turn — even if you intend to overwrite it. The contents you saw must still be current at write time. Re-`read` if anything else may have touched the file (another tool, `bash`, a previous `edit`).",
          "",
          "If the file does not exist, no prior `read` is needed.",
        ].join("\n"),
        inputSchema: z.object({
          path: z.string().describe("Absolute path to the file to write."),
          content: z.string().describe("Full file content. Use \\n for newlines."),
        }),
        execute: async ({ path, content }) => {
          const existing = await tryReadFile(shell, path);
          if (existing !== undefined) {
            const recorded = reads.get(path);
            if (recorded === undefined) {
              throw new Error(
                `${path} already exists. Use the \`read\` tool to read it before overwriting with \`write\`.`,
              );
            }
            if (digest(existing) !== recorded) {
              throw new Error(
                `${path} has changed since you last read it. Re-read with the \`read\` tool before overwriting.`,
              );
            }
          }
          const parent = path.slice(0, path.lastIndexOf("/"));
          if (parent && parent !== "") await shell.exec(`mkdir -p "${parent}"`, { cwd: "/workspace" });
          await shell.writeFile(path, content);
          reads.set(path, digest(content));
          return `wrote ${content.length} bytes to ${path}`;
        },
      }),

      edit: tool({
        description: [
          "Replace an exact string in a file. Fails if the string is missing. Fails if the string appears more than once unless replaceAll is true.",
          "",
          "You must `read` the file in this turn before calling `edit`. If anything else may have modified the file since (another `edit`, `write`, `bash`), re-`read` first — the recorded contents must still match what's on disk.",
        ].join("\n"),
        inputSchema: z.object({
          path: z.string().describe("Absolute path to the file to edit."),
          oldString: z.string().describe("Exact string to find. Must be unique unless replaceAll is true."),
          newString: z.string().describe("String to replace it with."),
          replaceAll: z
            .boolean()
            .optional()
            .describe("Replace every occurrence instead of requiring uniqueness. Defaults to false."),
        }),
        execute: async ({ path, oldString, newString, replaceAll }) => {
          const recorded = reads.get(path);
          if (recorded === undefined) {
            throw new Error(`You must use the \`read\` tool on ${path} before calling \`edit\`.`);
          }
          const content = await shell.readFile(path);
          if (digest(content) !== recorded) {
            throw new Error(
              `${path} has changed since you last read it. Re-read with the \`read\` tool before editing.`,
            );
          }
          const count = content.split(oldString).length - 1;
          if (count === 0) throw new Error(`oldString not found in ${path}`);
          if (count > 1 && !replaceAll) {
            throw new Error(
              `oldString appears ${count} times in ${path}. Set replaceAll: true or provide a more unique excerpt.`,
            );
          }
          const updated = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);
          await shell.writeFile(path, updated);
          reads.set(path, digest(updated));
          const applied = replaceAll ? count : 1;
          return `replaced ${applied} occurrence${applied === 1 ? "" : "s"} in ${path}`;
        },
      }),

      glob: tool({
        description: "Find files matching a name pattern. Returns matching paths.",
        inputSchema: z.object({
          pattern: z
            .string()
            .describe("Glob pattern like '**/*.md' or '*.ts'. Matches against file names, not full paths."),
          cwd: z.string().describe(`Absolute directory path to search under, e.g. /workspace/AGENTS.md`),
        }),
        execute: async ({ pattern, cwd }) => {
          const res = await shell.exec(`find . -type f -name "${pattern}"`, { cwd });
          const out = res.stdout.trim();
          return out || "(no matches)";
        },
      }),

      grep: tool({
        description: "Search file contents for a regex pattern. Returns {file}:{line}:{match} lines.",
        inputSchema: z.object({
          pattern: z.string().describe("Extended regex pattern to search for."),
          path: z.string().describe(`Absolute directory path to search under, e.g. /workspace/AGENTS.md`),
          glob: z.string().optional().describe("Filter files by glob, e.g. '*.md'. Optional."),
        }),
        execute: async ({ pattern, path, glob }) => {
          const include = glob ? `--include="${glob}"` : "";
          const res = await shell.exec(`grep -rnE ${include} -- "${pattern}" .`, { cwd: path });
          const out = res.stdout.trim();
          return out || "(no matches)";
        },
      }),
    };
  }
}
