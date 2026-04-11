# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What OpenXyz is

OpenXyz is an AI agent harness for human workflows — **not** a coding tool. A platform for building personal assistants (chief-of-staff, janitor, researcher) that a user talks to through multiple channels (Telegram, terminal, more later) backed by one shared AI agent session. The AI lives in a virtual filesystem it can self-modify (write its own tools, skills, agents, channels).

**Core goal:** `openxyz start` runs a single process where a user talks to one agent across a TUI and chat channels, with custom tools/skills/agents discovered from the template directory.

The reference template is `templates/openxyz-janitor` — the team's own chief-of-staff, dogfooded.

## Tech direction

OpenXyz is **Vercel AI SDK-native**. All tool, agent, streaming, and model primitives come from `ai` (v6) and the `@ai-sdk/*` provider packages. `openxyz/tools` re-exports `tool` from `ai` and `z` from `zod`. No `@opencode-ai/*` or `opencode-ai` runtime dependency — those are gone.

```ts
// templates/*/tools/echo.ts
import { tool, z } from "openxyz/tools";

export default tool({
  description: "...",
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => `"${text}"`,
});
```

Patterns from opencode's codebase are still fair game to learn from (see `working/013`, `working/014`), but the runtime is entirely AI SDK. Default to AI Gateway model strings (`provider/model`) over direct provider SDK wiring where possible.

## Project history

An earlier iteration experimented with a hard fork of opencode. The current direction builds on Vercel AI SDK directly, learning from opencode's and openclaw's implementations without inheriting their runtimes. See `working/012` for the tradeoff analysis, `working/017` for the blueprint.

**All design docs are in `working/*.md` and are load-bearing context.** When in doubt, read them before editing.

## Reference checkouts (outside this repo)

Two sibling projects are referenced for learning and examples. They are **not dependencies** — do not import from them.

- **opencode** — `../opencode`. When the user says "look at opencode", look here. Details and what's worth referencing: `working/020`.
- **openclaw** — `../openclaw`. When the user says "look at openclaw", look here. Details and what's worth referencing: `working/021`.

Learn patterns from both; don't port code wholesale. Both predate the current Bun + AI SDK + chat-sdk direction, so their stack choices are informational only.

## Monorepo layout

- **Root** (`package.json`): Bun workspaces (`packages/*`, `templates/*`) via the `workspaces` field, Turborepo, shared Prettier config (120-char width, `prettier-plugin-packagejson`). Package manager and runtime is **Bun** (not npm/pnpm/yarn). No `engines.node` pin.
- **`packages/openxyz`**: the publishable CLI + library. ESM-only. **No build step** — Bun runs TypeScript natively. `bin.openxyz` in `package.json` points directly at `commands/bin.ts` (which has `#!/usr/bin/env bun`). The `openxyz/tools` subpath export also points at source (`./tools.ts`) — consumers need Bun. Peer-deps `ai@^6` and `@ai-sdk/provider@^3`. When adding a new public module, add it to `package.json` `exports` and `files`.
- **`packages/openxyz-vfs-telegram`**: placeholder for the telegram VFS adapter (`/mnt/telegram` append-only semantics, see `working/008`). Not implemented yet.
- **`templates/openxyz-janitor`**: reference template. `channels/telegram.ts`, `tools/echo.ts`, `skills/prd/`, `AGENTS.md`, `package.json` with a `permissions` block. Depends on `openxyz: workspace:*`. (On disk the dir is still named `sessions/` — legacy, rename pending.)
- **Turborepo** (`turbo.json`): `build`, `test`, `lint`, `clean`, `dev` task definitions remain for future packages that may need them; `packages/openxyz` currently has no build script (runs source directly).

## Commands

```bash
bun install              # Install dependencies
bun run test             # Run all tests (turbo)
bun run lint             # Lint all packages with --fix (turbo)
bun run format           # Format all files with Prettier
bun x prettier --check . # Check formatting without writing

# Run the CLI from a template (no build — Bun runs .ts directly)
cd templates/openxyz-janitor && bun start
```

## Architecture

### Template convention

A template is a project directory the user runs `openxyz start` from. Filename = identity (`channels/telegram.ts` → channel type `telegram` with sessions `telegram:<user-id>`; `tools/echo.ts` → tool id `echo`).

```
my-template/
├── package.json              # deps: openxyz + adapter packages
├── AGENTS.md                 # project-specific instructions for the AI
├── .env.local                # TELEGRAM_BOT_TOKEN, etc.
├── channels/                 # transport adapters (telegram, slack, ...)
│   └── telegram.ts           # export default createTelegramAdapter()
├── tools/                    # custom AI tools (AI SDK shape)
│   └── echo.ts               # default export = tool({ description, inputSchema, execute })
├── skills/                   # custom skills (optional)
│   └── my-skill/SKILL.md
└── agents/                   # custom agents (optional)
```

### Terminology (important — don't mix up)

- **Template** = project directory with the conventions above
- **Harness** = the self-modifying config layer (tools/skills/agents/channels) the AI can edit
- **Channel** = transport type (telegram, slack, terminal) — lives in `channels/`. A channel is the parent container.
- **Session** = one conversation context, child of a channel. One channel contains many sessions (one per user/thread). Naming: `<channel>:<id>`, e.g. `telegram:7601560926`.
- **VFS** = virtual filesystem the AI lives inside (`/home/openxyz/` + `/mnt/*`, see `working/008`)
- **Working docs** = `working/*.md` scratch space for design thinking (git-ignored, numbered sequentially)

## Key design decisions (index)

| #   | Decision                                                                     | Doc                             |
| --- | ---------------------------------------------------------------------------- | ------------------------------- |
| 1   | Channels are the parent; sessions are children of channels                   | `working/002`                   |
| 2   | `openxyz/tools` re-exports `tool` from `ai` + `z` from `zod`                 | `working/003` (+ new direction) |
| 3   | Scan `cwd/tools/[!_]*.{js,ts}` for custom tools                              | `working/003`                   |
| 4   | Skills from `cwd/skills/**/SKILL.md` only                                    | `working/006`                   |
| 5   | VFS as the AI's entire world (`/home/openxyz` + `/mnt/*`)                    | `working/008`                   |
| 6   | Stateless bash per call (`workdir` param, not `cd`)                          | `working/008`                   |
| 7   | Harness is an opt-in menu per template                                       | `working/008`                   |
| 8   | `openxyz.config.ts` (TypeScript) for mount config                            | `working/008`                   |
| 9   | Per-user sessions for Telegram (`telegram:<uid>`)                            | `working/016`                   |
| 10  | Fire-and-forget bridge handlers (avoid chat-sdk LockError)                   | `working/004`                   |
| 11  | Telegram markdown → fall back to plain text on parse error                   | `working/004`                   |
| 12  | Build on Vercel AI SDK, not fork opencode                                    | `working/012`                   |
| 13  | All channels go through `chat` + `@chat-adapter/*` (no direct platform SDKs) | `working/022`                   |
| 14  | Reference opencode at `../opencode` (not a dependency)                       | `working/020`                   |
| 15  | Reference openclaw at `../../openclaw` (not a dependency)                    | `working/021`                   |

## Patterns to learn from

From `working/013-opencode-architecture-learnings.md` and `working/014-opencode-code-style-guide.md`:

- **Namespace pattern** — `export namespace X { ... }` per domain
- **Zod + `z.infer` pairs** for every exported schema; `.describe()` every field the LLM sees
- **Typed IDs** — `Identifier.ascending("session")` → `ses_<ulid>`
- **`.txt` prompt files** with `${placeholder}` substitution
- **Small utility helpers** — `defer`, `iife`, `lazy`, `isRecord`, `fn`
- **Structured logging** — `Log.create({ service })`, `using _ = log.time(...)`
- **`NamedError` types** per domain with cause chains
- **`@/` path alias** for internal imports
- **Tool wrapper pattern** — auto validation + output truncation around the AI SDK `tool()` primitive

## Agentic loop (from `working/018`)

15 techniques for reliable AI agent loops built on AI SDK `streamText()`. Essentials:

1. Loop termination requires multiple signals (finish reason + no pending tools + user/assistant ordering)
2. Stream events and persist to DB atomically — crash-recoverable
3. **Tool errors continue the loop, LLM errors break it**
4. Retry needs `Retry-After` header parsing (AI SDK's `maxRetries` isn't smart enough)
5. Fire-and-forget chat-sdk handlers (sync awaits cause LockError)
6. `AbortController` propagation to both `streamText()` and tools
7. Cost tracking with Decimal.js (float errors compound)
8. **Skip context compaction for v1** — modern 200k+ windows rarely hit limits

## Known gotchas

1. `child_process.spawnSync` + `stdio: "inherit"` is unreliable for nested Bun processes — TTY handoff fails. Use `Bun.spawn` with the exact dev command.
2. Do not import `chat` under `--conditions=browser` — transitive deps touch `document`.
3. chat-sdk thread handlers must be fire-and-forget. Holding the lock across `await` causes `LockError` on concurrent messages (`working/004`, `working/022`).
4. Telegram markdown posts need a plain-text fallback — the parser rejects some outputs (`working/004`).
5. `MountableFs` options shape is `{ mounts: [{ mountPoint, filesystem }] }`, not `{ mounts: { path: fs } }`.

## Code style

From `AGENTS.md`:

- **Single-word variable names** — `cfg` not `config`, `pid` not `inputPID`, `err` not `existingError`
- **No `try/catch`** where possible
- **No `any`** type
- **Avoid `let`** — ternaries and early returns instead
- **Early returns over else blocks**
- **Dot notation over destructuring** when single use
- **Functional array methods** (flatMap/filter/map) over for loops
- **snake_case** for Drizzle schema fields (no column name strings needed)
- **Type inference over explicit annotations**

## Working style

- Terse, direct responses — no preamble, **no emojis**
- Give reasoning and tradeoffs, not recipes
- "simpler" and "smaller" are strong signals — prefer those paths
- Match the level of the question (architecture, specific line, or anywhere in between)
- `working/` is the design scratchpad — "log this" = create or update a numbered working doc
- When debugging, ask for actual command output rather than guessing

Full notes in `working/015`.

## Publishing

Packages are published to npm via GitHub Releases. Version is extracted from the git tag (`v1.0.0` format). Prerelease tags (e.g. `v1.0.0-beta.1`) publish under the `next` dist-tag. Workspace dependency references (`workspace:*`) are resolved to the release version at publish time. Publishing uses npm provenance with OIDC.

## Pre-commit

Husky runs `lint-staged` on commit, which applies `prettier --write --ignore-unknown` to all staged files.

## Key conventions

- Package manager and runtime is **Bun** (not npm/pnpm/yarn). Always use `bun` to run scripts, install deps, and execute the CLI.
- **TypeScript 6**. `@types/bun` (not `@types/node`). `tsconfig.json` has `types: ["bun"]`.
- Prefer **Bun-native APIs** over Node equivalents: `Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.env`, `Bun.serve`, `new Glob()`. Bun auto-loads `.env.local` — no `dotenv`/`@next/env` needed.
- All packages use `"version": "0.0.0"` in source; real versions are set during CI publish.
- All packages use `"type": "module"` (ESM-only).
- **Never describe the filesystem as "virtual" in AI-facing tool descriptions** — the AI should think it's a normal filesystem.

## Working docs quick reference

Read these first for deep context on any topic.

### Core architecture

- **008** — **VFS harness architecture** (the core abstraction — read first for any VFS/tools/mounts work)
- **017** — Fresh-start architecture blueprint
- **018** — Agentic loop techniques (streaming, termination, retries, errors, cost)

### Decisions and direction

- **002** — Channel/session naming and state ownership
- **003** — Custom tools API
- **006** — Skills discovery rules
- **012** — Fork vs fresh start decision
- **022** — **Channels go through chat-sdk only** (no direct platform SDKs)

### Reference checkouts (outside this repo)

- **020** — opencode reference path and what's worth reading there
- **021** — openclaw reference path and what's worth reading there

### Patterns to learn from

- **013** — Architecture patterns from opencode (what to look at)
- **014** — Code style guide from opencode (how to write code)

### Historical context (read when investigating prior art)

- **001** — opencode engine architecture notes
- **004** — Telegram bridge fixes (fire-and-forget, markdown fallback, lock contention)
- **005** — Tool filtering architecture
- **007** — Early unified-fs draft (superseded by 008)
- **009** — External mount design (deferred)
- **010-011** — Bridge browser-condition issue and fresh iteration goals
- **015** — Working style notes
- **016** — Inventory of the prior iteration's work
- **019** — Earlier CLAUDE.md draft (this file is canonical)
