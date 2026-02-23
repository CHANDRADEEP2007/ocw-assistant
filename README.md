---
title: Ollama Chat Wrapper
emoji: 🤖
colorFrom: blue
colorTo: indigo
sdk: gradio
sdk_version: 4.44.1
app_file: app.py
python_version: "3.10"
pinned: false
---

# Ollama Chat Wrapper (OCW)

FastAPI + Gradio app that provides an OpenAI-compatible chat endpoint on top of Ollama, plus a document-aware chat UI.

## What is implemented

- OpenAI-style endpoint: `POST /v1/chat/completions`
- Streaming and non-streaming responses
- Model listing: `GET /models`
- Health check: `GET /health`
- Document upload: `POST /api/upload`
- Session file listing/removal:
  - `GET /sessions/{session_id}/files`
  - `DELETE /sessions/{session_id}/files/{file_id}`
- Document context injection into chat (`session_id` + `file_ids`)
- UI workbench layout (sessions, attachments, settings, token usage)
- Retry + circuit breaker in Ollama client

## Setup

```bash
cd /Users/saichandradeep/deepseek-chat-app
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Set your key in `.env`:

- `OLLAMA_API_KEY=<your_ollama_key>`

## Run

```bash
uvicorn app:app --host 0.0.0.0 --port 5001
```

Open:

- `http://127.0.0.1:5001`

## Environment variables

Core:

- `OLLAMA_BASE_URL` (default `https://ollama.com`)
- `OLLAMA_API_KEY`
- `OLLAMA_API_STYLE` (`openai` or `native`)
- `OCW_API_TOKEN` (optional wrapper auth)
- `OCW_BACKEND_URL` (UI -> API, default `http://127.0.0.1:5001`)
- `DEFAULT_MODEL` (default `gpt-oss:20b`)

Uploads:

- `MAX_UPLOAD_MB` (default `20`)
- `MAX_DOC_CONTEXT_CHARS` (default `10000`)
- `MAX_DOC_CHUNKS` (default `4`)

Resilience:

- `OCW_RETRY_ATTEMPTS` (default `2`)
- `OCW_RETRY_BASE_DELAY` (default `0.5`)
- `OCW_BREAKER_THRESHOLD` (default `5`)
- `OCW_BREAKER_COOLDOWN_SEC` (default `30`)

## API examples

Upload:

```bash
curl -X POST http://127.0.0.1:5001/api/upload \
  -F "session_id=s1" \
  -F "file=@/path/to/report.pdf"
```

Chat with files:

```bash
curl -X POST http://127.0.0.1:5001/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"gpt-oss:20b",
    "messages":[{"role":"user","content":"Summarize key findings"}],
    "session_id":"s1",
    "file_ids":["<file_id>"],
    "stream":false
  }'
```

## Tests

```bash
pip install -r requirements-dev.txt
pytest -q
```
