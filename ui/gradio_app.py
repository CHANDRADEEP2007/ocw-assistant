import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Generator, List, Tuple

import gradio as gr
import requests

MODERN_WORKSPACE_CSS = """
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

:root {
  --ocw-bg: #eef2f6;
  --ocw-panel: #fbfcfe;
  --ocw-panel-2: #f4f7fb;
  --ocw-ink: #18212f;
  --ocw-muted: #607086;
  --ocw-border: #d8e0ea;
  --ocw-accent: #0b7a75;
  --ocw-accent-2: #0e5fd8;
  --ocw-warn: #d27c12;
}

.gradio-container {
  font-family: 'Manrope', sans-serif !important;
  background:
    radial-gradient(900px 500px at 90% -20%, rgba(14,95,216,0.12), transparent 60%),
    radial-gradient(800px 420px at 0% 10%, rgba(11,122,117,0.10), transparent 55%),
    var(--ocw-bg) !important;
}

.ocw-topbar, .ocw-shell, .ocw-card, .ocw-chatwrap, .ocw-composer, .ocw-drawer {
  border: 1px solid var(--ocw-border);
  border-radius: 16px;
  background: var(--ocw-panel);
  box-shadow: 0 12px 34px rgba(11, 26, 46, 0.05);
}

.ocw-topbar {
  padding: 10px 14px;
  margin-bottom: 10px;
  background: linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%);
}

.ocw-shell {
  padding: 10px;
  background: rgba(255,255,255,0.78);
  backdrop-filter: blur(4px);
}

.ocw-sidebar .gr-button,
.ocw-sidebar .gr-dropdown,
.ocw-sidebar .gr-textbox,
.ocw-composer .gr-button,
.ocw-composer .gr-dropdown,
.ocw-composer .gr-textbox,
.ocw-composer .gr-number,
.ocw-composer .gr-checkbox {
  border-radius: 12px !important;
}

.ocw-navlabel { color: var(--ocw-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; margin-top: 8px; }
.ocw-muted { color: var(--ocw-muted); }
.ocw-small { font-size: 12px; }
.ocw-chiprow { margin: 2px 0 8px 0; }

.ocw-chatwrap { padding: 10px; background: linear-gradient(180deg, #ffffff 0%, #f9fbfd 100%); }
.ocw-composer { padding: 10px; background: #ffffff; }
.ocw-drawer { padding: 10px; background: var(--ocw-panel-2); }

.ocw-code .cm-editor { border-radius: 12px !important; }

.ocw-inline-card {
  border: 1px solid #cfe0ff;
  border-radius: 14px;
  background: linear-gradient(180deg, #f7fbff 0%, #eef5ff 100%);
  padding: 10px 12px;
}

.ocw-inline-success {
  border: 1px solid #bfe8cf;
  border-radius: 14px;
  background: linear-gradient(180deg, #f5fff8 0%, #eafaf0 100%);
  padding: 10px 12px;
}

.ocw-mono, .ocw-mono * { font-family: 'IBM Plex Mono', monospace !important; }
"""

SLASH_COMMANDS = ["/schedule", "/summarize", "/send-email", "/search", "/rewrite"]
TOOL_OPTIONS = ["Gmail", "Outlook", "Google Calendar", "Web Search", "Database Query"]


def _auth_headers() -> Dict[str, str]:
    token = os.getenv("OCW_API_TOKEN", "").strip()
    if token:
        return {"Authorization": f"Bearer {token}"}
    return {}


def _backend_url() -> str:
    if "OCW_BACKEND_URL" in os.environ and os.getenv("OCW_BACKEND_URL"):
        return os.getenv("OCW_BACKEND_URL", "").rstrip("/")
    default_port = "7860" if os.getenv("SPACE_ID") else "5001"
    return f"http://127.0.0.1:{os.getenv('PORT', default_port)}".rstrip("/")


def _api_get(path: str, params: Dict[str, Any] | None = None) -> Dict[str, Any]:
    response = requests.get(f"{_backend_url()}{path}", headers=_auth_headers(), params=params or {}, timeout=20)
    response.raise_for_status()
    return response.json()


def _api_post(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    response = requests.post(
        f"{_backend_url()}{path}",
        headers={**_auth_headers(), "Content-Type": "application/json"},
        json=payload,
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def _tool_chip_markdown(enabled_tools: List[str], web_enabled: bool) -> str:
    chips = list(enabled_tools or [])
    if web_enabled and "Web Search" not in chips:
        chips.append("Web Search")
    if not chips:
        return "_No tools enabled_"
    formatted = " ".join([f"`{tool} ✓`" for tool in chips])
    return f"**Enabled Tools:** {formatted}"


def _slash_command_help(message: str) -> str:
    text = (message or "").strip()
    if not text.startswith("/"):
        return ""
    matches = [cmd for cmd in SLASH_COMMANDS if cmd.startswith(text.lower())]
    if not matches:
        return "No slash commands match."
    return "Suggestions: " + " | ".join(f"`{cmd}`" for cmd in matches[:5])


def _estimate_context_and_cost(chat_history: List[Dict[str, str]], message: str, model: str) -> str:
    hist = chat_history or []
    total_chars = sum(len((m or {}).get("content") or "") for m in hist) + len(message or "")
    est_tokens = max(1, total_chars // 4)
    window_map = {"gpt-oss:20b": 8192, "mixtral": 32768, "llama3": 8192}
    cost_per_1k = {"gpt-oss:20b": 0.0015, "mixtral": 0.0030, "llama3": 0.0020}
    context_window = window_map.get((model or "").lower(), 8000)
    cost = (est_tokens / 1000.0) * cost_per_1k.get((model or "").lower(), 0.0023)
    return (
        f"Context Used: {est_tokens:,} / {context_window:,} tokens  \n"
        f"Estimated Cost: ${cost:.4f}"
    )


def _productivity_snapshot(user_id: str) -> Tuple[str, str, str, str, str]:
    user_id = (user_id or "").strip() or "demo-user"
    try:
        connections = _api_get("/v1/productivity/connections", {"user_id": user_id}).get("connections", [])
        calendars = _api_get("/v1/productivity/calendars", {"user_id": user_id}).get("calendars", [])
        unified = _api_get("/v1/productivity/calendar/unified", {"user_id": user_id, "timezone": "UTC"}).get("events", [])
        conflicts = _api_get("/v1/productivity/calendar/conflicts", {"user_id": user_id}).get("conflicts", [])
        audits = _api_get("/v1/productivity/audit-logs", {"user_id": user_id, "limit": 20}).get("entries", [])
    except Exception as exc:
        err = f"API error: {exc}"
        return err, err, err, err, err

    conn_lines = ["### Connections"]
    if not connections:
        conn_lines.append("- No providers connected")
    for c in connections:
        conn_lines.append(f"- `{c['provider']}` | `{c['account_label']}` | `{c['account_id']}`")

    cal_lines = ["### Calendars"]
    if not calendars:
        cal_lines.append("- No calendars")
    for c in calendars:
        marker = "ON" if c.get("included") else "OFF"
        cal_lines.append(f"- `{marker}` {c['name']} ({c['provider']}) [`{c['id']}`]")

    event_lines = ["### Unified Calendar"]
    if not unified:
        event_lines.append("- No events")
    for e in unified[:20]:
        event_lines.append(
            f"- `{e['start']}` -> `{e['end']}` | {e['title']} | {e['provider']} | {e['status']}"
        )

    conflict_lines = ["### Conflicts"]
    if not conflicts:
        conflict_lines.append("- No conflicts detected")
    for c in conflicts:
        conflict_lines.append(f"- `{c['type']}` {c['start']} - {c['end']} | {c['explanation']}")

    audit_lines = ["### Audit Logs"]
    if not audits:
        audit_lines.append("- No audit entries")
    for a in audits[:10]:
        audit_lines.append(
            f"- `{a['timestamp']}` | {a['action_type']} | {a['status']} | {a.get('provider') or 'n/a'}"
        )

    return "\n".join(conn_lines), "\n".join(cal_lines), "\n".join(event_lines), "\n".join(conflict_lines), "\n".join(audit_lines)


def _connect_provider_and_refresh(user_id: str, provider: str, account_label: str):
    user_id = (user_id or "").strip() or "demo-user"
    label = (account_label or "").strip() or f"{provider}-account"
    try:
        _api_post(
            "/v1/productivity/connections/connect",
            {"user_id": user_id, "provider": provider, "account_label": label},
        )
    except Exception as exc:
        err = f"API error: {exc}"
        return err, err, err, err, err
    return _productivity_snapshot(user_id)


def _disconnect_provider_and_refresh(user_id: str, provider: str):
    user_id = (user_id or "").strip() or "demo-user"
    try:
        _api_post("/v1/productivity/connections/disconnect", {"user_id": user_id, "provider": provider})
    except Exception as exc:
        err = f"API error: {exc}"
        return err, err, err, err, err
    return _productivity_snapshot(user_id)


def _toggle_calendar_and_refresh(user_id: str, calendar_id: str, included: bool):
    user_id = (user_id or "").strip() or "demo-user"
    if not (calendar_id or "").strip():
        return _productivity_snapshot(user_id)
    try:
        _api_post(
            f"/v1/productivity/calendars/{calendar_id.strip()}/toggle",
            {"user_id": user_id, "included": bool(included)},
        )
    except Exception as exc:
        err = f"API error: {exc}"
        return err, err, err, err, err
    return _productivity_snapshot(user_id)


def _suggest_times(user_id: str, duration_minutes: int, timezone_name: str, preferred_start: str, preferred_end: str) -> str:
    user_id = (user_id or "").strip() or "demo-user"
    payload = {
        "user_id": user_id,
        "date": datetime.now(timezone.utc).date().isoformat(),
        "timezone": timezone_name or "UTC",
        "duration_minutes": int(duration_minutes or 30),
        "buffer_minutes": 10,
        "working_hours_start": "09:00",
        "working_hours_end": "17:00",
        "min_suggestions": 3,
        "preferred_start": preferred_start or None,
        "preferred_end": preferred_end or None,
    }
    try:
        data = _api_post("/v1/productivity/calendar/suggestions", payload)
    except Exception as exc:
        return f"API error: {exc}"
    suggestions = data.get("suggestions", [])
    if not suggestions:
        return "No suggestions available for the selected constraints."
    lines = ["### Smart Scheduling Suggestions"]
    for s in suggestions:
        lines.append(f"- `{s['start']}` -> `{s['end']}` | score={s.get('score', 0)} | {s.get('reason', '')}")
    return "\n".join(lines)


def _suggest_times_card(user_id: str, duration_minutes: int, timezone_name: str, preferred_start: str, preferred_end: str) -> str:
    user_id = (user_id or "").strip() or "demo-user"
    payload = {
        "user_id": user_id,
        "date": datetime.now(timezone.utc).date().isoformat(),
        "timezone": timezone_name or "UTC",
        "duration_minutes": int(duration_minutes or 30),
        "buffer_minutes": 10,
        "working_hours_start": "09:00",
        "working_hours_end": "17:00",
        "min_suggestions": 3,
        "preferred_start": preferred_start or None,
        "preferred_end": preferred_end or None,
    }
    try:
        data = _api_post("/v1/productivity/calendar/suggestions", payload)
        conflicts = _api_get("/v1/productivity/calendar/conflicts", {"user_id": user_id}).get("conflicts", [])
    except Exception as exc:
        return f"### Scheduling\nAPI error: {exc}"

    suggestions = data.get("suggestions", [])
    lines = [
        "<div class='ocw-inline-card'>",
        "📅 <strong>Scheduling with Google Calendar / Outlook</strong><br>",
        f"Duration: {int(duration_minutes or 30)} mins<br>",
        f"Timezone: {timezone_name or 'UTC'}<br>",
        f"Conflicts Found: {len(conflicts)}<br><br>",
        "Suggested Times:<br>",
    ]
    if not suggestions:
        lines.append("• No available slots found<br>")
    else:
        for s in suggestions[:3]:
            lines.append(f"• {s['start']} → {s['end']}<br>")
    lines.extend(["<br>[ Accept ] &nbsp;&nbsp; [ Modify ]", "</div>"])
    return "\n".join(lines)


def _draft_invite(user_id: str, provider: str, title: str, attendees_csv: str, duration_minutes: int, proposed_start: str) -> Tuple[str, str]:
    user_id = (user_id or "").strip() or "demo-user"
    attendees = [a.strip() for a in (attendees_csv or "").split(",") if a.strip()]
    payload = {
        "user_id": user_id,
        "provider": provider,
        "title": title or "Meeting",
        "agenda": "Draft invite generated from Phase 2 Smart Scheduling panel.",
        "attendees": attendees,
        "duration_minutes": int(duration_minutes or 30),
        "timezone": "UTC",
        "proposed_start": proposed_start or None,
    }
    try:
        data = _api_post("/v1/productivity/calendar/draft_invite", payload)
    except Exception as exc:
        return f"API error: {exc}", ""
    preview = json.dumps(data.get("preview", {}), indent=2)
    return f"Draft action `{data.get('action_id')}` (confirm required)", preview


def _confirm_action_and_refresh(user_id: str, action_id: str) -> Tuple[str, str, str, str, str, str]:
    user_id = (user_id or "").strip() or "demo-user"
    status_md = ""
    if (action_id or "").strip():
        try:
            data = requests.post(
                f"{_backend_url()}/v1/productivity/actions/{action_id.strip()}/confirm",
                headers=_auth_headers(),
                params={"user_id": user_id},
                timeout=20,
            )
            data.raise_for_status()
            body = data.json()
            status_md = f"Confirmed `{body['action_id']}` -> external id `{body['external_id']}`"
        except Exception as exc:
            status_md = f"API error: {exc}"
    else:
        status_md = "Enter an action id to confirm."
    conn, cal, unified, conflicts, audit = _productivity_snapshot(user_id)
    return status_md, conn, cal, unified, conflicts, audit


def _fetch_models() -> List[str]:
    try:
        response = requests.get(f"{_backend_url()}/models", headers=_auth_headers(), timeout=20)
        response.raise_for_status()
        data = response.json()
        models = [item["id"] for item in data.get("data", []) if item.get("id")]
        return models or [os.getenv("DEFAULT_MODEL", "gpt-oss:20b")]
    except Exception:
        return [os.getenv("DEFAULT_MODEL", "gpt-oss:20b")]


def _stream_sse_lines(response: requests.Response):
    for line in response.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        body = line[6:].strip()
        if body == "[DONE]":
            return
        try:
            yield json.loads(body)
        except json.JSONDecodeError:
            continue


def _messages_for_api(chat_history: List[Dict[str, str]], user_message: str) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for m in chat_history:
        role = m.get("role")
        content = m.get("content")
        if role in {"user", "assistant"} and isinstance(content, str):
            out.append({"role": role, "content": content})
    out.append({"role": "user", "content": user_message})
    return out


def _format_usage(data: Dict[str, Any]) -> str:
    usage = data.get("usage") or {}
    if not usage:
        return ""
    return (
        f"Prompt: {usage.get('prompt_tokens', 0)} | "
        f"Completion: {usage.get('completion_tokens', 0)} | "
        f"Total: {usage.get('total_tokens', 0)}"
    )


def _list_session_files(session_id: str) -> List[Dict[str, str]]:
    try:
        resp = requests.get(
            f"{_backend_url()}/sessions/{session_id}/files",
            headers=_auth_headers(),
            timeout=20,
        )
        resp.raise_for_status()
        files = resp.json().get("files", [])
        return [{"file_id": f["file_id"], "filename": f["filename"]} for f in files]
    except Exception:
        return []


def _files_markdown(files: List[Dict[str, str]]) -> str:
    if not files:
        return "No files attached to this session."
    lines = ["### Session Files"]
    for f in files:
        lines.append(f"- `{f['filename']}` (`{f['file_id'][:8]}`)")
    return "\n".join(lines)


def _upload_files(
    filepaths: List[str],
    session_id: str,
    attached_files: List[Dict[str, str]],
) -> Tuple[List[Dict[str, str]], str, gr.Dropdown]:
    attached_files = attached_files or []
    normalized_paths: List[str] = []
    if isinstance(filepaths, str):
        normalized_paths = [filepaths]
    elif isinstance(filepaths, list):
        normalized_paths = filepaths

    for path in normalized_paths:
        try:
            with open(path, "rb") as f:
                resp = requests.post(
                    f"{_backend_url()}/api/upload",
                    headers=_auth_headers(),
                    files={"file": (os.path.basename(path), f)},
                    data={"session_id": session_id},
                    timeout=120,
                )
            resp.raise_for_status()
            data = resp.json()
            attached_files.append({"file_id": data["file_id"], "filename": data["filename"]})
        except Exception:
            continue

    dedup = {f["file_id"]: f for f in attached_files}
    merged = list(dedup.values())
    options = [(f["filename"], f["file_id"]) for f in merged]
    return merged, _files_markdown(merged), gr.Dropdown(choices=options, value=[v for _, v in options], multiselect=True)


def _refresh_session_files(session_id: str) -> Tuple[List[Dict[str, str]], str, gr.Dropdown]:
    files = _list_session_files(session_id)
    options = [(f["filename"], f["file_id"]) for f in files]
    return files, _files_markdown(files), gr.Dropdown(choices=options, value=[v for _, v in options], multiselect=True)


def _delete_selected_files(
    session_id: str,
    selected_file_ids: List[str],
    attached_files: List[Dict[str, str]],
) -> Tuple[List[Dict[str, str]], str, gr.Dropdown]:
    attached_files = attached_files or []
    selected = set(selected_file_ids or [])
    for file_id in selected:
        try:
            requests.delete(
                f"{_backend_url()}/sessions/{session_id}/files/{file_id}",
                headers=_auth_headers(),
                timeout=20,
            )
        except Exception:
            pass
    remaining = [f for f in attached_files if f["file_id"] not in selected]
    options = [(f["filename"], f["file_id"]) for f in remaining]
    return remaining, _files_markdown(remaining), gr.Dropdown(choices=options, value=[v for _, v in options], multiselect=True)


def _new_session(
    session_histories: Dict[str, List[Dict[str, str]]],
    session_choices: List[str],
) -> Tuple[str, Dict[str, List[Dict[str, str]]], List[str], gr.Dropdown, List[Dict[str, str]], str, str, List[Dict[str, str]], gr.Dropdown]:
    session_id = uuid.uuid4().hex[:10]
    session_histories = dict(session_histories or {})
    session_histories[session_id] = []
    choices = [session_id, *(session_choices or [])]
    return (
        session_id,
        session_histories,
        choices,
        gr.Dropdown(choices=choices, value=session_id),
        [],
        "",
        "No files attached to this session.",
        [],
        gr.Dropdown(choices=[], value=[], multiselect=True),
    )


def _switch_session(
    session_id: str,
    session_histories: Dict[str, List[Dict[str, str]]],
) -> Tuple[List[Dict[str, str]], str, List[Dict[str, str]], gr.Dropdown]:
    session_histories = session_histories or {}
    chat = session_histories.get(session_id, [])
    files = _list_session_files(session_id)
    options = [(f["filename"], f["file_id"]) for f in files]
    return chat, "", files, gr.Dropdown(choices=options, value=[v for _, v in options], multiselect=True)


def _chat_send(
    message: str,
    chat_history: List[Dict[str, str]],
    session_id: str,
    model: str,
    temperature: float,
    max_tokens: int,
    stream: bool,
    selected_file_ids: List[str],
    session_histories: Dict[str, List[Dict[str, str]]],
) -> Generator[Tuple[List[Dict[str, str]], str, str, Dict[str, List[Dict[str, str]]]], None, None]:
    if not message.strip():
        yield chat_history, "", "", session_histories
        return

    chat_history = chat_history or []
    session_histories = dict(session_histories or {})

    working_history = chat_history + [{"role": "user", "content": message}, {"role": "assistant", "content": ""}]
    payload: Dict[str, Any] = {
        "model": model,
        "messages": _messages_for_api(chat_history, message),
        "temperature": temperature,
        "max_tokens": int(max_tokens),
        "stream": stream,
        "session_id": session_id,
        "file_ids": selected_file_ids or [],
    }

    if stream:
        assistant_text = ""
        yield working_history, "", "", session_histories
        try:
            with requests.post(
                f"{_backend_url()}/v1/chat/completions",
                headers={**_auth_headers(), "Content-Type": "application/json"},
                json=payload,
                stream=True,
                timeout=180,
            ) as response:
                response.raise_for_status()
                for packet in _stream_sse_lines(response):
                    if packet.get("error"):
                        assistant_text = f"Error: {packet.get('details') or packet.get('error')}"
                        working_history[-1]["content"] = assistant_text
                        yield working_history, "", "", session_histories
                        return
                    choices = packet.get("choices") or [{}]
                    token = (choices[0].get("delta") or {}).get("content", "")
                    if token:
                        assistant_text += token
                        working_history[-1]["content"] = assistant_text
                        yield working_history, "", "", session_histories
        except requests.RequestException as exc:
            working_history[-1]["content"] = f"Error: {exc}"
            yield working_history, "", "", session_histories
            return

        session_histories[session_id] = working_history
        yield working_history, "", "", session_histories
        return

    try:
        response = requests.post(
            f"{_backend_url()}/v1/chat/completions",
            headers={**_auth_headers(), "Content-Type": "application/json"},
            json=payload,
            timeout=120,
        )
        response.raise_for_status()
        data = response.json()
        reply = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "")
        usage_text = _format_usage(data)
    except requests.RequestException as exc:
        reply = f"Error: {exc}"
        usage_text = ""

    final_history = chat_history + [{"role": "user", "content": message}, {"role": "assistant", "content": reply}]
    session_histories[session_id] = final_history
    yield final_history, "", usage_text, session_histories


def create_gradio_app() -> gr.Blocks:
    models = _fetch_models()
    first_session = uuid.uuid4().hex[:10]

    with gr.Blocks(title="OCW Workspace", theme=gr.themes.Soft(), css=MODERN_WORKSPACE_CSS) as demo:
        session_histories = gr.State({first_session: []})
        session_choices = gr.State([first_session])
        active_session = gr.State(first_session)
        attached_files = gr.State([])

        gr.HTML(
            """
            <div class="ocw-topbar">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
                <div style="display:flex;align-items:center;gap:14px;">
                  <div style="font-weight:800;font-size:20px;color:#18212f;">OCW</div>
                  <div class="ocw-muted">Workspace ▾</div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                  <span class="ocw-muted ocw-small">Modern AI Workspace</span>
                  <span style="padding:6px 10px;border:1px solid #d8e0ea;border-radius:999px;background:#fff;">Profile</span>
                </div>
              </div>
            </div>
            """
        )

        with gr.Row(elem_classes=["ocw-shell"], equal_height=False):
            with gr.Column(scale=2, min_width=250, elem_classes=["ocw-sidebar"]):
                gr.Markdown("### + New Chat")
                new_chat_btn = gr.Button("Start Session", variant="secondary")
                session_dropdown = gr.Dropdown(choices=[first_session], value=first_session, label="Active Session")

                gr.Markdown("<div class='ocw-navlabel'>Recent Chats</div>")
                gr.Markdown("- Budget Summary\n- Client Sync Draft\n- API Debug")
                gr.Markdown("<div class='ocw-navlabel'>Pinned</div>")
                gr.Markdown("- Product Strategy")
                gr.Markdown("<div class='ocw-navlabel'>Prompt Library / Agents / Files / Admin</div>")

                with gr.Accordion("Files", open=False):
                    upload_files = gr.File(label="Attach files", file_count="multiple", type="filepath")
                    refresh_files_btn = gr.Button("Refresh Files", size="sm")
                    files_md = gr.Markdown("No files attached to this session.")
                    selected_files = gr.Dropdown(label="Use in context", choices=[], value=[], multiselect=True)
                    delete_selected_btn = gr.Button("Delete Selected Files", size="sm")

            with gr.Column(scale=8, min_width=760):
                gr.HTML(
                    f"""
                    <div style="display:flex;justify-content:space-between;align-items:center;margin:2px 2px 8px 2px;">
                      <div class="ocw-muted">Conversation-first workspace</div>
                      <div style="display:flex;gap:8px;align-items:center;">
                        <span style="padding:4px 10px;border-radius:999px;background:#fff;border:1px solid #d8e0ea;">Model: <b>{models[0]}</b></span>
                        <span style="padding:4px 10px;border-radius:999px;background:#f6fbff;border:1px solid #cfe0ff;">Enterprise-ready UI</span>
                      </div>
                    </div>
                    """
                )

                with gr.Column(elem_classes=["ocw-chatwrap"]):
                    chatbot = gr.Chatbot(type="messages", height=520, label="Conversation")
                    usage_md = gr.Markdown("")
                    advanced_status_md = gr.Markdown(
                        _estimate_context_and_cost([], "", models[0]),
                        elem_classes=["ocw-mono"],
                    )

                tool_chips_md = gr.Markdown("_No tools enabled_", elem_classes=["ocw-chiprow"])
                slash_help_md = gr.Markdown("")

                with gr.Column(elem_classes=["ocw-composer"]):
                    msg = gr.Textbox(
                        label=None,
                        placeholder="+  Write a message… (try /schedule, /summarize, /search)",
                        lines=3,
                    )

                    with gr.Row():
                        model = gr.Dropdown(label=None, choices=models, value=models[0], scale=3)
                        attach_hint = gr.Markdown("📎 Attach in sidebar Files panel", scale=2)
                        tools_toggle = gr.CheckboxGroup(label=None, choices=TOOL_OPTIONS, value=[], scale=4)
                        web_enabled = gr.Checkbox(label="🌐 Web", value=False, scale=1)

                    with gr.Row():
                        send_btn = gr.Button("Send", variant="primary", scale=1)
                        stop_btn = gr.Button("Stop", variant="stop", scale=1)
                        clear_btn = gr.Button("Clear", scale=1)
                        refresh_models_btn = gr.Button("Refresh Models", scale=1)
                        gr.Markdown("`⌘/Ctrl + Enter` to send", scale=2)

                with gr.Accordion("Advanced ▸", open=False, elem_classes=["ocw-drawer"]):
                    temperature = gr.Slider(label="Temperature", minimum=0.0, maximum=2.0, step=0.05, value=0.7)
                    max_tokens = gr.Number(label="Max Tokens", value=256, minimum=1, precision=0)
                    stream = gr.Checkbox(label="Streaming", value=False)
                    system_prompt = gr.Textbox(
                        label="System Prompt (UI only; backend passthrough not yet wired)",
                        value="",
                        lines=2,
                    )

                with gr.Accordion("⚙ Tools & Scheduling Drawer", open=False, elem_classes=["ocw-drawer"]):
                    with gr.Tab("Tools"):
                        gr.Markdown("### Tools")
                        gr.Markdown("Enable tools above the composer. Enabled tools appear as chips.")
                        gr.Markdown("Permissions and confirmations are enforced server-side for sensitive actions.")
                    with gr.Tab("Scheduling"):
                        with gr.Row():
                            p_user_id = gr.Textbox(label="User ID", value="demo-user", scale=2)
                            p_account_label = gr.Textbox(label="Account Label", value="Work Account", scale=2)
                            draft_provider = gr.Dropdown(label="Provider", choices=["google", "microsoft"], value="google", scale=1)
                        with gr.Row():
                            connect_gmail_btn = gr.Button("Connect Gmail", variant="secondary")
                            connect_outlook_btn = gr.Button("Connect Outlook", variant="secondary")
                            disconnect_gmail_btn = gr.Button("Disconnect Gmail")
                            disconnect_outlook_btn = gr.Button("Disconnect Outlook")
                            refresh_productivity_btn = gr.Button("Refresh Productivity View", variant="primary")

                        with gr.Row():
                            sched_duration = gr.Number(label="Duration (minutes)", value=30, minimum=5, precision=0)
                            sched_timezone = gr.Textbox(label="Timezone", value="UTC")
                            preferred_start = gr.Textbox(label="Preferred Start", value="13:00")
                            preferred_end = gr.Textbox(label="Preferred End", value="17:00")

                        suggest_btn = gr.Button("Find Suggested Times", variant="primary")
                        suggestions_md = gr.Markdown(
                            "Ask: `Find 30 mins tomorrow afternoon` to generate a structured scheduling card."
                        )

                        gr.Markdown("### Draft Meeting Invite")
                        with gr.Row():
                            draft_title = gr.Textbox(label="Title", value="Project Sync", scale=2)
                            draft_attendees = gr.Textbox(
                                label="Attendees (comma-separated)",
                                value="alice@example.com,bob@example.com",
                                scale=3,
                            )
                            draft_start = gr.Textbox(label="Proposed Start (ISO)", value="", scale=2)
                        draft_invite_btn = gr.Button("Draft Invite")
                        draft_status_md = gr.Markdown("")
                        draft_preview_json = gr.Code(label="Invite Preview", language="json", value="", elem_classes=["ocw-code"])

                        gr.Markdown("### Confirm Before Send")
                        with gr.Row():
                            action_id_input = gr.Textbox(label="Action ID", scale=3)
                            confirm_action_btn = gr.Button("Confirm Action", variant="stop", scale=1)
                        confirm_status_md = gr.Markdown("")

                    with gr.Tab("Connections / Unified Calendar / Audit"):
                        with gr.Row():
                            with gr.Column(scale=1):
                                calendar_id_input = gr.Textbox(label="Calendar ID")
                                calendar_include = gr.Checkbox(label="Included", value=True)
                                toggle_calendar_btn = gr.Button("Apply Calendar Toggle")
                            with gr.Column(scale=2):
                                connections_md = gr.Markdown("### Connections\n- No providers connected")
                                calendars_md = gr.Markdown("### Calendars\n- No calendars")
                                unified_md = gr.Markdown("### Unified Calendar\n- No events")
                                conflicts_md = gr.Markdown("### Conflicts\n- No conflicts detected")
                                audit_md = gr.Markdown("### Audit Logs\n- No audit entries")

        def _refresh_models_dropdown() -> gr.Dropdown:
            refreshed = _fetch_models()
            return gr.Dropdown(choices=refreshed, value=refreshed[0] if refreshed else None)

        refresh_models_btn.click(_refresh_models_dropdown, outputs=[model])

        new_chat_btn.click(
            _new_session,
            inputs=[session_histories, session_choices],
            outputs=[active_session, session_histories, session_choices, session_dropdown, chatbot, usage_md, files_md, attached_files, selected_files],
        )

        session_dropdown.change(
            _switch_session,
            inputs=[session_dropdown, session_histories],
            outputs=[chatbot, usage_md, attached_files, selected_files],
        ).then(lambda x: x, inputs=[session_dropdown], outputs=[active_session])

        upload_files.upload(
            _upload_files,
            inputs=[upload_files, active_session, attached_files],
            outputs=[attached_files, files_md, selected_files],
        )

        refresh_files_btn.click(
            _refresh_session_files,
            inputs=[active_session],
            outputs=[attached_files, files_md, selected_files],
        )

        delete_selected_btn.click(
            _delete_selected_files,
            inputs=[active_session, selected_files, attached_files],
            outputs=[attached_files, files_md, selected_files],
        )

        clear_btn.click(lambda sid, sh: ([], "", {**sh, sid: []}), inputs=[active_session, session_histories], outputs=[chatbot, usage_md, session_histories])

        send_event = send_btn.click(
            _chat_send,
            inputs=[msg, chatbot, active_session, model, temperature, max_tokens, stream, selected_files, session_histories],
            outputs=[chatbot, msg, usage_md, session_histories],
        )
        submit_event = msg.submit(
            _chat_send,
            inputs=[msg, chatbot, active_session, model, temperature, max_tokens, stream, selected_files, session_histories],
            outputs=[chatbot, msg, usage_md, session_histories],
        )

        stop_btn.click(lambda: None, None, None, cancels=[send_event, submit_event])

        msg.change(_slash_command_help, inputs=[msg], outputs=[slash_help_md])
        msg.change(_estimate_context_and_cost, inputs=[chatbot, msg, model], outputs=[advanced_status_md])
        model.change(_estimate_context_and_cost, inputs=[chatbot, msg, model], outputs=[advanced_status_md])
        tools_toggle.change(_tool_chip_markdown, inputs=[tools_toggle, web_enabled], outputs=[tool_chips_md])
        web_enabled.change(_tool_chip_markdown, inputs=[tools_toggle, web_enabled], outputs=[tool_chips_md])
        clear_btn.click(lambda: _estimate_context_and_cost([], "", models[0]), outputs=[advanced_status_md])
        clear_btn.click(lambda: "", outputs=[slash_help_md])

        refresh_productivity_btn.click(
            _productivity_snapshot,
            inputs=[p_user_id],
            outputs=[connections_md, calendars_md, unified_md, conflicts_md, audit_md],
        )

        connect_gmail_btn.click(
            lambda user_id, label: _connect_provider_and_refresh(user_id, "google", label),
            inputs=[p_user_id, p_account_label],
            outputs=[connections_md, calendars_md, unified_md, conflicts_md, audit_md],
        )
        connect_outlook_btn.click(
            lambda user_id, label: _connect_provider_and_refresh(user_id, "microsoft", label),
            inputs=[p_user_id, p_account_label],
            outputs=[connections_md, calendars_md, unified_md, conflicts_md, audit_md],
        )
        disconnect_gmail_btn.click(
            lambda user_id: _disconnect_provider_and_refresh(user_id, "google"),
            inputs=[p_user_id],
            outputs=[connections_md, calendars_md, unified_md, conflicts_md, audit_md],
        )
        disconnect_outlook_btn.click(
            lambda user_id: _disconnect_provider_and_refresh(user_id, "microsoft"),
            inputs=[p_user_id],
            outputs=[connections_md, calendars_md, unified_md, conflicts_md, audit_md],
        )
        toggle_calendar_btn.click(
            _toggle_calendar_and_refresh,
            inputs=[p_user_id, calendar_id_input, calendar_include],
            outputs=[connections_md, calendars_md, unified_md, conflicts_md, audit_md],
        )

        suggest_btn.click(
            _suggest_times_card,
            inputs=[p_user_id, sched_duration, sched_timezone, preferred_start, preferred_end],
            outputs=[suggestions_md],
        )

        draft_invite_btn.click(
            _draft_invite,
            inputs=[p_user_id, draft_provider, draft_title, draft_attendees, sched_duration, draft_start],
            outputs=[draft_status_md, draft_preview_json],
        )

        confirm_action_btn.click(
            _confirm_action_and_refresh,
            inputs=[p_user_id, action_id_input],
            outputs=[confirm_status_md, connections_md, calendars_md, unified_md, conflicts_md, audit_md],
        )

    return demo
