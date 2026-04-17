# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Internal scratchpad, open work, design history, and mnemonic cross-references live in `mnemonic/000-help.md`. Read that first if you want the full context behind decisions; this file is the public-facing project guide.

## Mnemonic cross-references

> "Mind-Palace"

@mnemonic/000-help.md

You MUST ALWAYS look at mnemonic/\* when writing a new feature or bugfix.

## What OpenXyz is

OpenXyz is an AI agent harness for human workflows — **not** a coding tool. A platform for building personal assistants (chief-of-staff, janitor, researcher) that a user talks to through multiple channels (Telegram, terminal, more later) backed by one shared AI agent session. The AI lives in a virtual filesystem it can self-modify (write its own tools, skills, agents, channels).

**Core goal:** `openxyz start` runs a single process where a user talks to one agent across a TUI and chat channels, with custom tools/skills/agents discovered from the template directory.

The reference template is `templates/openxyz-janitor` — the team's own chief-of-staff, dogfooded.

## Reference source (read these when the question touches them)

- `../ai` — the `ai` SDK monorepo we depend on. Source for `ToolLoopAgent`, `wrapLanguageModel`, `convertToLanguageModelPrompt`, `streamText`, middleware spec, per-provider packages (`../ai/packages/{ai,anthropic,amazon-bedrock,openai,openai-compatible,gateway,...}`). Go here when you need exact types, marker shapes, or call semantics.
- `../chat` — the chat-sdk monorepo. Source for `Chat`, `Thread`, `Adapter`, `toAiMessages`, `@chat-adapter/*`. Go here for dispatch tiering, thread lifecycle, webhook decoding, state adapter contracts.
- Full reference checkouts table lives in `mnemonic/000-help.md`.

## Tech direction

OpenXyz is **Vercel AI SDK-native**. All tool, agent, streaming, and model primitives come from `ai` (v6) and the `@ai-sdk/*` provider packages. `openxyz/tools` re-exports `tool` from `ai` and `z` from `zod`. No `@opencode-ai/*` or `opencode-ai` runtime dependency.

```ts
// templates/*/tools/echo.ts
import { tool, z } from "openxyz/tools";

export default tool({
  description: "...",
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => `"${text}"`,
});
```

Default to AI Gateway model strings (`provider/model`) over direct provider SDK wiring where possible.

## Monorepo layout

- **Root** (`package.json`): Bun workspaces (`packages/*`, `templates/*`) via the `workspaces` field, Turborepo, shared Prettier config (120-char width, `prettier-plugin-packagejson`). Package manager and runtime is **Bun** (not npm/pnpm/yarn). No `engines.node` pin.
- **`packages/openxyz`**: the publishable **CLI + thin facade** that templates (downstream users) depend on. Owns the `openxyz` bin and the re-export surface (`openxyz/tools`, etc.). ESM-only. **No build step** — Bun runs TypeScript natively. `bin.openxyz` in `package.json` points directly at `commands/bin.ts` (`#!/usr/bin/env bun`). Subpath exports point at source (`./tools.ts`) — consumers need Bun. Peer-deps `ai@^6` and `@ai-sdk/provider@^3`. When adding a new public module, add it to `package.json` `exports` and `files`. Keep this package small — the real work lives in `@openxyz/harness`.
- **`packages/openxyz-harness`** (`@openxyz/harness`): the **engine**. Agent loop, tool registry/discovery, VFS (`just-bash` + `MountableFs`), channel bridge, session store, streaming. Scoped package, internal to the openxyz family. Templates do **not** import from here directly — they import from `openxyz`, which re-exports whatever harness surface the template needs. This keeps template imports simple (`import { tool } from "openxyz/tools"`) and lets the engine evolve independently of the public API.
- **`templates/openxyz-janitor`**: reference template. `channels/telegram.ts`, `tools/echo.ts`, `skills/prd/`, `AGENTS.md`, `package.json` with a `permissions` block. Depends on `openxyz: workspace:*`.
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
- **VFS** = virtual filesystem the AI lives inside (`/home/openxyz/` + `/mnt/*`)

## Patterns to learn from

- **Namespace pattern** — `export namespace X { ... }` per domain
- **Zod + `z.infer` pairs** for every exported schema; `.describe()` every field the LLM sees
- **Typed IDs** — `Identifier.ascending("session")` → `ses_<ulid>`
- **`.txt` prompt files** with `${placeholder}` substitution
- **Small utility helpers** — `defer`, `iife`, `lazy`, `isRecord`, `fn`
- **Structured logging** — `Log.create({ service })`, `using _ = log.time(...)`
- **`NamedError` types** per domain with cause chains
- **`@/` path alias** for internal imports
- **Tool wrapper pattern** — auto validation + output truncation around the AI SDK `tool()` primitive

## Agentic loop

Reliable AI agent loops built on AI SDK `streamText()`. Essentials:

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
3. chat-sdk thread handlers must be fire-and-forget. Holding the lock across `await` causes `LockError` on concurrent messages.
4. Telegram markdown posts need a plain-text fallback — the parser rejects some outputs.
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

### Comments: WHY, not WHAT

Default to no comments. Write one only when the reader can't recover the reasoning from the code alone. Specifically:

- **Framework/library contracts that aren't visible at the call site** — chat-sdk's tiered dispatch (`onDirectMessage` → `onSubscribedMessage` → `onNewMention` → `onNewMessage` with early returns), AI SDK's `stopWhen` semantics, Telegram's forum-topic thread IDs, prompt cache-control ordering. If the "why" lives in another repo, mention it.
- **Non-obvious ordering, fan-out, or sequencing** — why we auto-`thread.subscribe()` inside `onNewMention`, why `environment` prepends to `context()` instead of merging, why a handler is fire-and-forget instead of awaited.
- **Surprising upstream limits** — `thread.refresh()` caps at 50 (thread.ts:726); `fetchChannelMessages` is cache-backed on Telegram; chat-sdk's `isMention` is set by dispatcher, preserved if already truthy.

Never comment what the code already says. `// increment counter` above `i++` adds noise. `// Telegram's adapter.fetchChannelMessages is cache-backed — messages before process start won't appear` adds load-bearing context.

When in doubt, ask: "could a future maintainer reconstruct this reasoning from a clean read of the code?" If yes, skip the comment. If no, write it — and keep it tight.

## Working style

- Terse, direct responses — no preamble, **no emojis**
- Give reasoning and tradeoffs, not recipes
- "simpler" and "smaller" are strong signals — prefer those paths
- Match the level of the question (architecture, specific line, or anywhere in between)
- When debugging, ask for actual command output rather than guessing

## Publishing

Packages are published to npm via GitHub Releases. Version is extracted from the git tag (`v1.0.0` format). Prerelease tags (e.g. `v1.0.0-beta.1`) publish under the `next` dist-tag. Workspace dependency references (`workspace:*`) are resolved to the release version at publish time. Publishing uses npm provenance with OIDC.

## Pre-commit

Husky runs `lint-staged` on commit, which applies `prettier --write --ignore-unknown` to all staged files.
Not something you need to worry about.

## Key conventions

- Package manager and runtime is **Bun** (not npm/pnpm/yarn). Always use `bun` to run scripts, install deps, and execute the CLI.
- **TypeScript 6**. `@types/bun` (not `@types/node`). `tsconfig.json` has `types: ["bun"]`.
- Prefer **Bun-native APIs** over Node equivalents: `Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.env`, `Bun.serve`, `new Glob()`. Bun auto-loads `.env.local` — no `dotenv`/`@next/env` needed.
- All packages use `"version": "0.0.0"` in source; real versions are set during CI publish.
- All packages use `"type": "module"` (ESM-only).
- **Never describe the filesystem as "virtual" in AI-facing tool descriptions** — the AI should think it's a normal filesystem.
