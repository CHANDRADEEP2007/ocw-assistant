# OCW Assistant Desktop (Phase 0 + Phase 1 MVP Foundation)

This folder contains the desktop replatform scaffold for **OCW Assistant**:

- `apps/ui`: React + Vite UI with Tauri shell scaffold
- `apps/sidecar`: Node.js sidecar runtime (Express + SQLite + Drizzle + Ollama routing)

## Implemented now

- Messaging-first UI shell
- Local sidecar API (`/health`, `/api/chat`, approval/audit endpoints)
- SQLite schema + Drizzle config/migrations scaffold
- Approval state machine (`prepared -> approved -> executed | failed | cancelled`)
- Audit logging primitives
- Google OAuth desktop flow (PKCE, desktop loopback redirect)
- Google token storage (Keytar-first) + token refresh path
- Google Calendar sync to local SQLite + unified today/week/conflicts/summary
- Gmail draft center (local draft persistence + explicit approve/send)
- Gmail thread search/read (MVP)

## Still pending / next

- Structured calendar cards in chat canvas (currently summary is text-first)
- Gmail draft generation via local Ollama (currently template-based by design)
- Gmail reply-to-thread workflow with reply headers/thread metadata
- Project generator + Telegram polling client

## Run locally

Use `desktop/QUICKSTART.md` for setup and run commands.
