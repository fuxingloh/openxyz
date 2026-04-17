# group-agent

A **group-chat participant**. Drop it into a Telegram group — family, friends, book club, project channel, whatever — and it lurks until addressed, then joins the conversation briefly and gets out of the way.

## What it does

- **Lurks by default** — doesn't respond to every message. Groups are other people's conversations; the bot is a guest, not a host.
- **Responds when addressed** — either an @-mention or a reply to one of its earlier messages
- **Attributes authors** — sees who said what in the recent context, so it can reason about multiple participants and reply to the right person
- **Keeps replies short** — group chats move fast, long bot replies clog the thread

## Who it's for

People who want an on-demand assistant in a shared chat without it taking over. Good for:

- A **family group** — "hey bot, what's our dinner plan tonight?"
- A **friend group** — trivia, settling arguments, quick research
- A **purpose-specific group** — book club summaries, project standups, travel-planning help
- A **hobby group** — rules lookups, recommendations, light moderation-adjacent help

It deliberately does _not_ moderate, police content, or summarize unprompted. It participates when invited and stays silent otherwise.

## Setup

1. Create the bot on [@BotFather](https://t.me/BotFather), then **disable privacy mode** in BotFather (`/setprivacy` → Disable) so the bot can see all group messages (not just mentions). Without this, it can't build context from prior messages.
2. Add the bot to your group. Grab the group's chat ID — the easiest way is to send any message in the group and check the Telegram API response, or use a bot like [@username_to_id_bot](https://t.me/username_to_id_bot). Group chat IDs are negative, like `-1001234567890`.
3. Edit `.env.local`:
   - `TELEGRAM_BOT_TOKEN` — from @BotFather
   - `TELEGRAM_GROUP_ALLOWLIST` — comma-separated group chat IDs where the bot is allowed to participate (the allowlist is **groups**, not users — so the bot can't be dragged into a stranger's group if someone adds it uninvited)
   - `OPENXYZ_MODEL` — e.g. `bedrock/zai.glm-5`, `openai/gpt-5`; plus any provider credentials
4. From the repo root: `bun install`
5. Run it: `cd templates/group-agent && bun start`

## Deploy to Vercel

`bun run build` → `.vercel/output/`. Deploy via Vercel CLI or a git-connected project, set the env vars in the dashboard, point Telegram's webhook at `https://<deployment>/api/webhooks/telegram`.

## Why no DMs?

DMs are explicitly rejected — the persona and context handling are tuned for multi-participant conversations. If you want a one-on-one bot, use `templates/pkbm-agent` (knowledge base) or `templates/openxyz-janitor` (project chief-of-staff).

## Making it yours

- **Tune the persona** — `AGENTS.md` controls how chatty, how formal, and what topics the bot engages with. A family bot sounds different from a book-club bot.
- **Add tools/skills** — drop files under `tools/` or `skills/` for domain-specific abilities (event scheduling, recipe lookup, trivia databases, etc.).
- **Per-group customization** — you can branch the `reply()` logic in `channels/telegram.ts` to pick different agents based on `thread.channel.id`, if one instance serves multiple groups with different personas.

## Layout

```
group-agent/
├── AGENTS.md              # the persona prompt (guest-mode behavior)
├── channels/telegram.ts   # group allowlist + mention/reply gate
└── package.json
```
