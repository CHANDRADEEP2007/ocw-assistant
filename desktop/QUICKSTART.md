# OCW Assistant Desktop Quickstart

This quickstart gets the desktop foundation running locally (UI + sidecar) and enables Google Calendar/Gmail features.

## 1. Prerequisites

Required:
- Node.js 20+
- npm 10+
- Ollama running locally (`http://127.0.0.1:11434`)

For Tauri desktop shell (optional during early dev):
- Rust toolchain (`rustup`)
- Tauri system prerequisites for macOS/Windows

## 2. Install dependencies

```bash
cd desktop
npm install
```

## 3. Configure environment

Copy and edit env file:

```bash
cp .env.example .env
```

Minimum for local UI/sidecar without Google integration:
- `PORT`
- `VITE_SIDECAR_URL`
- `OLLAMA_BASE_URL`

To enable Google Calendar/Gmail:
- Set `GOOGLE_CLIENT_ID`
- Set `GOOGLE_CLIENT_SECRET` (if your OAuth client requires it)
- Keep `GOOGLE_REDIRECT_URI` as configured in Google Cloud Console

Google Cloud setup checklist:
- Create OAuth client credentials
- Enable `Google Calendar API`
- Enable `Gmail API`
- Add redirect URI: `http://127.0.0.1:8765/oauth/google/callback`

## 4. Start the sidecar (Node runtime)

```bash
cd desktop/apps/sidecar
npm run dev
```

What it does on startup:
- Opens/creates local SQLite DB
- Runs SQL migrations from `apps/sidecar/drizzle/*.sql`
- Starts local API server (default `:4318`)

## 5. Start the React UI

In a second terminal:

```bash
cd desktop/apps/ui
npm run dev
```

Open the Vite URL (default `http://localhost:1420`).

## 6. (Optional) Start Tauri shell

After installing Rust + Tauri prerequisites:

```bash
cd desktop/apps/ui
npm run tauri:dev
```

## 7. Verify key flows

### Google connect + Calendar sync
1. In the right panel, use `Google Connect (MVP)`.
2. Click `Start Google Connect`.
3. Complete Google consent in the browser.
4. Paste `state` and authorization `code` into the UI.
5. Click `Complete Connect`.
6. Click `Sync Google Calendar`.
7. Use `/today` or `/week` in chat.

### Gmail draft + send (approval-based)
1. In `Email Draft Center (Gmail MVP)`, enter recipient + prompt.
2. Click `Generate Draft`.
3. Review draft preview card and side-panel draft row.
4. Click `Approve & Send`.

### Gmail thread search/read
1. In `Email Draft Center`, use `Gmail Thread Search / Read`.
2. Enter a Gmail search query (for example: `in:inbox newer_than:7d`).
3. Click `Search Threads`.
4. Click `Open` on a thread result.
5. Thread preview renders in chat canvas email cards.

## 8. Current limitations (intentional)

- Email draft generation is template-based (local Ollama draft generation is deferred)
- Gmail send is plain-text only (no attachments / rich HTML yet)
- Calendar and email UI cards are functional MVPs, not final polished components
- No signing/notarization for desktop builds in MVP

## 9. Useful API endpoints (sidecar)

- `GET /health`
- `POST /api/chat`
- `GET /api/actions`
- `GET /api/audit-logs`
- `GET /api/accounts`
- `POST /api/accounts/google/oauth/start`
- `POST /api/accounts/google/oauth/complete`
- `POST /api/calendar/google/sync`
- `GET /api/calendar/today`
- `GET /api/calendar/week`
- `GET /api/email/drafts`
- `POST /api/email/drafts/generate`
- `POST /api/email/drafts/:draftId/approve-send`
- `GET /api/email/threads`
- `GET /api/email/threads/:threadId`
