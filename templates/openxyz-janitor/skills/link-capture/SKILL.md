---
name: link-capture
description: |
  Capture a URL the user pasted into a rich note plus a NocoDB row, filed under a narrative. Use whenever the user pastes a URL — with or without a message. Writes to /mnt/documents/links/ and to the NocoDB Links + Narratives tables.
---

# Skill: link-capture

The user pasted a URL. Capture it.

## Flow

1. **Fetch the page** with `web_fetch`. Extract: title, 2–3 sentence summary, 3–5 key points, author/source (domain), publish date if available. If the fetch fails, ask the user to paste title + summary manually.
2. **Match to a narrative.** Call `nocodb_queryRecords` against the Narratives table. Pick the closest fit. If nothing fits, propose a new narrative with a short name and description.
3. **Confirm in one line** — "Capturing **{title}** → narrative: **{narrative}**. OK?" Skip confirmation if the user pasted the URL with no other message, or said go / just confirm / equivalent.
4. **On confirm**, in this order:
   - If a new narrative was proposed: `nocodb_createRecords` on Narratives first, capture the id.
   - Write the rich note to `/mnt/documents/links/YYYY-MM-DD-{slug}.md`.
   - `nocodb_createRecords` on Links with the fields below, linking to the narrative.

## Rich note format

Path: `/mnt/documents/links/YYYY-MM-DD-{slug}.md`

```markdown
# {title}

- **URL**: {url}
- **Source**: {source}
- **Date**: {date}
- **Narrative**: {narrative name(s)}

## Summary

{2–3 sentence summary}

## Key Points

- {point}
- {point}
- {point}

## So What

{1–2 sentences on why this matters / what it signals}

## Quotes

> {notable quote if available}
```

## Writing the Links row

Fields are defined in AGENTS.md. When populating:

- `Date` — today in `YYYY-MM-DD`.
- `Narrative` — pass the record **id** (not the name); linked-record field.
- `Doc Path` — relative to `/mnt/documents/`, matches the file you just wrote.

## Slug rules

- Lowercase the title.
- Spaces → hyphens.
- Strip special chars (keep `[a-z0-9-]`).
- Max 60 chars — trim on a word boundary.
- If the doc path already exists, append `-2`, `-3`, … to the slug. Never overwrite.

## Notes

- Don't paste the full fetched page body into chat — put it in the doc.
