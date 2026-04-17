# pkbm-agent

A **Personal Knowledge Base Management** agent. Think of it as a notebook you can talk to — you send it thoughts, URLs, quotes, ideas, and questions; it captures, organizes, and retrieves them over time.

## What it does

- **Capture** — you send it a fragment (voice-of-thought, URL, PDF, quote, random idea), it saves it to its knowledge base and confirms where it landed
- **Organize** — it groups related notes, adds cross-links, and proposes structure when a pattern emerges
- **Retrieve** — ask "what did I say about X last month" or "pull up the article on Y" and it finds it
- **Summarize** — daily/weekly roll-ups, topic digests, reading queues, whatever you ask for

The agent's home directory _is_ the knowledge base. Markdown files, light YAML frontmatter, flat structure + tags. Nothing exotic — the point is that your notes stay human-readable even if you stop using the agent.

## Who it's for

Anyone who wants an always-on, chat-accessible notebook with a brain. Optimized for "I just thought of something, let me send it" flows rather than structured note-taking apps.

Works in DMs or group chats:

- **DM**: anyone on the allowlist can talk to it
- **Group**: the bot lurks; only responds when an allowlisted user @-mentions it or replies to one of its messages. Even then, context is filtered to _only_ the allowlisted user's messages + the bot's own replies — other group members' chatter is ignored entirely. The knowledge base stays yours, even when the bot sits in a shared chat.

If you want a bot that actively participates in group conversations (not scoped to one person), see `templates/group-agent`.

## Setup

1. Edit `.env.local`:
   - `TELEGRAM_BOT_TOKEN` — get one from [@BotFather](https://t.me/BotFather)
   - `TELEGRAM_ALLOWLIST` — your own Telegram user ID (comma-separated if sharing with a partner/collaborator). Only users in this list can trigger replies _or_ contribute to context.
   - `OPENXYZ_MODEL` — e.g. `bedrock/zai.glm-5`, `openai/gpt-5`; plus any provider credentials the model needs
2. From the repo root: `bun install`
3. Run it: `cd templates/pkbm-agent && bun start`

If you want to use it in a group chat, also **disable privacy mode** in @BotFather (`/setprivacy` → Disable) so the bot can see all messages in the group. The allowlist still restricts what it actually reads and responds to.

## Deploy to Vercel

`bun run build` produces `.vercel/output/`. Deploy with the Vercel CLI or a git-connected project, set the same env vars in the Vercel dashboard, and point Telegram's webhook at `https://<deployment>/api/webhooks/telegram`.

## Making it yours

- **Add tools** — drop a `tools/*.ts` file exporting an AI SDK tool and the agent picks it up. Useful for integrating calendars, bookmark services, transcription, etc.
- **Add skills** — drop a `skills/<name>/SKILL.md` with a frontmatter `name`/`description` and a body prompt. The agent loads the skill on demand.
- **Tune the persona** — edit `AGENTS.md` to shift tone (more terse, more chatty, more structured, more tag-driven).

## Layout

```
pkbm-agent/
├── AGENTS.md              # the persona prompt
├── channels/telegram.ts   # Telegram adapter + allowlist
└── package.json
```
