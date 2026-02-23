---
title: Ollama Chat Wrapper
emoji: 🤖
colorFrom: blue
colorTo: indigo
sdk: gradio
sdk_version: 4.44.1
app_file: app.py
pinned: false
---

# Ollama Chat Wrapper

OpenAI-compatible chat wrapper over Ollama with document upload/context and resilient backend behavior.

Set these Space Variables/Secrets:

- `OLLAMA_BASE_URL` (example: `https://ollama.com`)
- `OLLAMA_API_KEY` (Secret)
- `OLLAMA_API_STYLE` = `openai`
- `OCW_BACKEND_URL` = `http://127.0.0.1:7860`
- `DEFAULT_MODEL` = `gpt-oss:20b`

Optional:

- `OCW_API_TOKEN` (Secret)
- `MAX_UPLOAD_MB`, `MAX_DOC_CONTEXT_CHARS`, `MAX_DOC_CHUNKS`
- `OCW_RETRY_ATTEMPTS`, `OCW_RETRY_BASE_DELAY`, `OCW_BREAKER_THRESHOLD`, `OCW_BREAKER_COOLDOWN_SEC`
