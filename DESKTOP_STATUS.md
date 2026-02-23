# OCW Assistant Desktop Status (Pre-GitHub Push)

## Implemented

### Desktop Foundation
- Tauri + React UI shell scaffold (`desktop/apps/ui`)
- Node sidecar runtime (Express + SQLite + Drizzle) (`desktop/apps/sidecar`)
- Approval state machine + audit logging backbone
- Local Ollama chat routing (quick/deep model profile registry)

### Google OAuth + Accounts
- Google OAuth desktop PKCE flow (start/complete)
- Keytar-first token storage
- Connected account persistence (`connected_accounts`)
- Token refresh support + retry on 401 for Google APIs

### Calendar (Google MVP)
- Google Calendar sync into local SQLite (`calendars`, `calendar_events`)
- Unified today/week queries
- Conflict detection (hard/soft)
- Back-to-back detection
- Focus block suggestions
- Summary endpoints
- Demo seed fallback when no Google account is connected

### Email (Gmail MVP)
- Local draft persistence (`draft_emails`)
- Draft generation endpoint (template-based, no Ollama for drafts yet)
- Explicit approve-and-send workflow tied to approval engine
- Gmail send endpoint (plain-text MIME)
- Gmail thread search/read endpoints
- Structured email preview cards in chat canvas UI (drafts + thread previews)

## Deferred (Intentional)
- Ollama-based email draft generation (template-based for now)
- Gmail reply-to-thread headers/thread-aware sending
- Rich HTML email + attachments
- Final structured calendar cards (currently summary is text-first)
- Project generator + Telegram integration

## Validation
- Python regression tests: `./.venv/bin/pytest -q` -> `10 passed`
- Desktop TS/Rust build/typecheck not run in this environment (deps/toolchains not installed here)

## Key Desktop Docs
- `desktop/README.md`
- `desktop/QUICKSTART.md`
- `desktop/.env.example`

## Ready for GitHub Push
- Yes, code and docs are at a good checkpoint for pushing.
