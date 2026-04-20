# @chat-adapter/state-libsql

Vendored from [vercel/chat#packages/state-libsql](https://github.com/vercel/chat/tree/main/packages/state-libsql) until the upstream PR merges and the package is published to npm. Once it lands, delete this workspace package and swap `workspace:*` → `catalog:` in consumers.

Owned by this repo in the meantime — edit `src/*.ts` directly.

## Entry points

- `@chat-adapter/state-libsql` — `libsql` native binding. Used for Node / Bun with local file access.
- `@chat-adapter/state-libsql/client` — `@libsql/client` pure JS. Used on edge / serverless where native modules aren't available.

`@openxyz/runtime` imports the `/client` entry (Vercel Bun native-module friction — see `mnemonic/068-070`).
