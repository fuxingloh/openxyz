import { Bash, MountableFs, ReadWriteFs, OverlayFs } from "just-bash";
import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
const MAX_BYTES = 50_000;

const access = z.enum(["read-only", "read-write"]);

export const FilesystemConfigSchema = z.union([access, z.record(z.string(), access)]).default("read-write");

export type FilesystemConfig = z.infer<typeof FilesystemConfigSchema>;

export class FilesystemTools {
  readonly #bash: Bash;

  constructor(cwd: string, config?: FilesystemConfig) {
    const permissions = typeof config === "string" ? { harness: config } : (config ?? {});

    // TODO(?): IMPORTANT make sure .env, .gitignore, node_modules (maybe?) are not exposed to the agent-
    //  OpenXyz Approved Plugins Hub?
    //  Advanced users can just give "real Bash" access
    const harness =
      (permissions.harness ?? "read-write") === "read-write"
        ? new ReadWriteFs({ root: cwd })
        : new OverlayFs({ root: cwd, readOnly: true });

    // TODO: mount /mnt/* paths from perms when external mounts are implemented
    const fs = new MountableFs({
      mounts: [{ mountPoint: "/home/openxyz", filesystem: harness }],
    });
    this.#bash = new Bash({ fs, cwd: "/home/openxyz", python: true, javascript: true });
  }

  tools(): Record<string, Tool> {
    const shell = this.#bash;

    return {
      bash: tool({
        description: [
          "Executes a bash command in a sandboxed shell with optional timeout.",
          "",
          `All commands run in /home/openxyz (your workspace) by default. Use \`workdir\` to run in a different directory. Prefer \`workdir\` over \`cd <dir> && <command>\`.`,
          "",
          "Layout:",
          `  /home/openxyz/   — your workspace (tools, skills, channels, agents, documents)`,
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
        description: "Read a file from your workspace or a mounted backend. Returns line-numbered content.",
        inputSchema: z.object({
          path: z.string().describe(`Absolute path, e.g. /home/openxyz/AGENTS.md`),
          offset: z.number().optional().describe("Line number to start reading from (1-indexed). Defaults to 1."),
          limit: z.number().optional().describe("Maximum number of lines to return. Defaults to 2000."),
        }),
        execute: async ({ path, offset, limit }) => {
          const content = await shell.readFile(path);
          const lines = content.split("\n");
          const start = Math.max(0, (offset ?? 1) - 1);
          const end = Math.min(lines.length, start + (limit ?? 2000));
          const numbered = lines
            .slice(start, end)
            .map((line, i) => `${String(start + i + 1).padStart(6)}  ${line}`)
            .join("\n");
          const more = lines.length > end ? `\n[... ${lines.length - end} more lines]` : "";
          return numbered + more;
        },
      }),

      write: tool({
        description:
          "Write a file to your workspace. Overwrites existing content. Parent directories are created automatically.",
        inputSchema: z.object({
          path: z.string().describe("Absolute path to the file to write."),
          content: z.string().describe("Full file content. Use \\n for newlines."),
        }),
        execute: async ({ path, content }) => {
          const parent = path.slice(0, path.lastIndexOf("/"));
          if (parent && parent !== "") await shell.exec(`mkdir -p "${parent}"`, { cwd: "/home/openxyz" });
          await shell.writeFile(path, content);
          return `wrote ${content.length} bytes to ${path}`;
        },
      }),

      edit: tool({
        description:
          "Replace an exact string in a file. Fails if the string is missing. Fails if the string appears more than once unless replaceAll is true.",
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
          const content = await shell.readFile(path);
          const count = content.split(oldString).length - 1;
          if (count === 0) throw new Error(`oldString not found in ${path}`);
          if (count > 1 && !replaceAll) {
            throw new Error(
              `oldString appears ${count} times in ${path}. Set replaceAll: true or provide a more unique excerpt.`,
            );
          }
          const updated = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);
          await shell.writeFile(path, updated);
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
          cwd: z.string().describe(`Absolute directory path to search under, e.g. /home/openxyz/AGENTS.md`),
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
          path: z.string().describe(`Absolute directory path to search under, e.g. /home/openxyz/AGENTS.md`),
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
