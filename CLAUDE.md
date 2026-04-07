# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenDev is a TypeScript monorepo managed with Bun and Turborepo. The primary package (`packages/opendev`) is an npm-published library that peer-depends on Vercel AI SDK v6 (`ai@^6`, `@ai-sdk/provider@^3`). It targets the Bun runtime (>=1.3.0).

## Commands

```bash
bun install              # Install dependencies
bun run build            # Build all packages (turbo)
bun run test             # Run all tests (turbo)
bun run lint             # Lint all packages with --fix (turbo)
bun run format           # Format all files with Prettier
bun prettier --check .   # Check formatting without writing
```

To run a single package task:

```bash
bun turbo run build --filter=opendev
bun turbo run test --filter=opendev
```

## Architecture

- **Monorepo root** (`package.json`): Bun workspaces (`packages/*`), Turborepo orchestration, shared Prettier config (120 char width, `prettier-plugin-packagejson`).
- **`packages/opendev`**: The main publishable package. ESM-only (`"type": "module"`), ships TypeScript source files directly. Has a `bin.js` CLI entry point.
- **Turborepo** (`turbo.json`): Tasks are `build`, `test`, `lint`, `clean`, `dev`. Build inputs are `tsconfig.json`, `opendev.config.ts`, `src/`, `app/`; outputs are `dist/`, `.vercel/output`.

## Publishing

Packages are published to npm via GitHub Releases. Version is extracted from the git tag (`v1.0.0` format). Prerelease tags (e.g., `v1.0.0-beta.1`) publish under the `next` dist-tag. Workspace dependency references (`workspace:*`) are resolved to the release version at publish time. Publishing uses npm provenance with OIDC.

## Pre-commit

Husky runs `lint-staged` on commit, which applies `prettier --write --ignore-unknown` to all staged files.

## Key Conventions

- Package manager is **Bun** (not npm/yarn/pnpm). Always use `bun` to run scripts and install dependencies.
- TypeScript 6 is used.
- All packages use `"version": "0.0.0"` in source; real versions are set during CI publish.
