import json
import time
import uuid
from typing import AsyncGenerator, Dict, List, Optional

import httpx
from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile, status
from fastapi.responses import JSONResponse, StreamingResponse

from api.document_store import document_store
from api.ollama_client import OllamaClient
from api.schemas import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ErrorResponse,
    HealthResponse,
    ModelsResponse,
    SessionFilesResponse,
    UploadResponse,
)

router = APIRouter()
client = OllamaClient()


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _require_auth(authorization: Optional[str]) -> None:
    import os

    expected = os.getenv("OCW_API_TOKEN", "").strip()
    if not expected:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    if token != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")


def _error_json(error: str, status_code: int, details: Optional[str] = None) -> JSONResponse:
    body = ErrorResponse(error=error, details=details, status_code=status_code).model_dump(exclude_none=True)
    return JSONResponse(status_code=status_code, content=body)


def _inject_document_context(messages: List[Dict[str, str]], session_id: Optional[str], file_ids: Optional[List[str]]) -> List[Dict[str, str]]:
    if not session_id:
        return messages

    last_user = ""
    for item in reversed(messages):
        if item.get("role") == "user":
            last_user = item.get("content", "")
            break

    context = document_store.build_context(session_id=session_id, file_ids=file_ids, query=last_user)
    if not context:
        return messages

    system_context = {
        "role": "system",
        "content": (
            "Use the following uploaded document context when answering. "
            "If the answer is not in the context, say so clearly.\n\n"
            f"{context}"
        ),
    }
    return [system_context, *messages]


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    ok = await client.health()
    return HealthResponse(status="ok", ollama_reachable=ok)


@router.get("/models", response_model=ModelsResponse)
async def list_models(authorization: Optional[str] = Header(default=None)) -> ModelsResponse:
    _require_auth(authorization)
    try:
        model_names = await client.list_models()
        return ModelsResponse(data=[{"id": m, "object": "model"} for m in model_names])
    except RuntimeError as exc:
        if str(exc) == "circuit_open":
            return ModelsResponse(data=[])
        raise
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail=f"upstream_timeout: {exc}") from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"upstream_error: {exc.response.status_code}") from exc


@router.post("/api/upload", response_model=UploadResponse)
async def upload_document(
    file: UploadFile = File(...),
    session_id: str = Form(...),
    authorization: Optional[str] = Header(default=None),
):
    _require_auth(authorization)

    try:
        content = await file.read()
        stored = document_store.add_document(
            session_id=session_id,
            filename=file.filename or "uploaded_file",
            content_type=file.content_type or "application/octet-stream",
            content=content,
        )
    except ValueError as exc:
        code = str(exc)
        if code == "unsupported_file_type":
            return _error_json("unsupported_file_type", 400)
        if code == "file_too_large":
            return _error_json("file_too_large", 400)
        if code == "empty_document":
            return _error_json("empty_document", 400)
        return _error_json("upload_failed", 400, code)
    except Exception as exc:
        return _error_json("upload_failed", 500, str(exc))

    return UploadResponse(
        file_id=stored.file_id,
        filename=stored.filename,
        status="processed",
        session_id=stored.session_id,
        chunks=len(stored.chunks),
    )


@router.get("/sessions/{session_id}/files", response_model=SessionFilesResponse)
async def list_session_files(session_id: str, authorization: Optional[str] = Header(default=None)) -> SessionFilesResponse:
    _require_auth(authorization)
    docs = document_store.list_session_documents(session_id)
    return SessionFilesResponse(
        session_id=session_id,
        files=[
            {
                "file_id": doc.file_id,
                "filename": doc.filename,
                "created_at": int(doc.created_at),
            }
            for doc in docs
        ],
    )


@router.delete("/sessions/{session_id}/files/{file_id}")
async def remove_session_file(session_id: str, file_id: str, authorization: Optional[str] = Header(default=None)):
    _require_auth(authorization)
    removed = document_store.remove_document(session_id=session_id, file_id=file_id)
    if not removed:
        return _error_json("file_not_found", 404)
    return {"ok": True}


@router.post("/v1/chat/completions", response_model=ChatCompletionResponse, responses={401: {"model": ErrorResponse}})
async def chat_completions(
    request: ChatCompletionRequest,
    raw_request: Request,
    authorization: Optional[str] = Header(default=None),
):
    _require_auth(authorization)

    mapped_messages = _inject_document_context(
        messages=[m.model_dump() for m in request.messages],
        session_id=request.session_id,
        file_ids=request.file_ids,
    )

    payload: Dict[str, object] = {
        "model": request.model,
        "messages": mapped_messages,
        "temperature": request.temperature,
        "stream": request.stream,
    }
    if request.max_tokens is not None:
        payload["max_tokens"] = request.max_tokens

    if request.stream:
        completion_id = f"chatcmpl-{uuid.uuid4().hex[:10]}"
        created = int(time.time())

        async def event_stream() -> AsyncGenerator[str, None]:
            try:
                async for packet in client.stream_chat_completion(payload):
                    if packet.get("done"):
                        yield "data: [DONE]\n\n"
                        return

                    if packet.get("api_style") == "native":
                        data = packet.get("data", {})
                        text = (data.get("message") or {}).get("content", "")
                        finish = "stop" if data.get("done", False) else None
                        if text:
                            chunk = {
                                "id": completion_id,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": request.model,
                                "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
                            }
                            yield f"data: {json.dumps(chunk)}\n\n"
                        if finish:
                            final_chunk = {
                                "id": completion_id,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": request.model,
                                "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                            }
                            yield f"data: {json.dumps(final_chunk)}\n\n"
                            yield "data: [DONE]\n\n"
                            return
                        continue

                    data = packet.get("data", {})
                    choice = (data.get("choices") or [{}])[0]
                    delta = choice.get("delta") or {}
                    content = delta.get("content") or ""
                    finish_reason = choice.get("finish_reason")
                    chunk = {
                        "id": data.get("id", completion_id),
                        "object": "chat.completion.chunk",
                        "created": data.get("created", created),
                        "model": data.get("model", request.model),
                        "choices": [{"index": 0, "delta": ({"content": content} if content else {}), "finish_reason": finish_reason}],
                    }
                    yield f"data: {json.dumps(chunk)}\n\n"
                    if finish_reason:
                        yield "data: [DONE]\n\n"
                        return
            except RuntimeError as exc:
                if str(exc) == "circuit_open":
                    error_payload = {
                        "error": "service_unavailable",
                        "details": "Ollama is temporarily unavailable. Please try again later.",
                        "status_code": 503,
                    }
                    yield f"data: {json.dumps(error_payload)}\n\n"
                    return
                raise
            except httpx.TimeoutException as exc:
                error_payload = {"error": "upstream_timeout", "details": str(exc), "status_code": 504}
                yield f"data: {json.dumps(error_payload)}\n\n"
            except httpx.HTTPStatusError as exc:
                status_code = exc.response.status_code
                if status_code == 400:
                    err = "unknown_model"
                elif status_code in (401, 403):
                    err = "unauthorized"
                else:
                    err = "upstream_error"
                error_payload = {"error": err, "details": str(exc), "status_code": status_code}
                yield f"data: {json.dumps(error_payload)}\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    try:
        upstream = await client.chat_completion(payload)
    except RuntimeError as exc:
        if str(exc) == "circuit_open":
            return _error_json("service_unavailable", 503, "Ollama is temporarily unavailable. Please try again later.")
        return _error_json("upstream_error", 502, str(exc))
    except httpx.TimeoutException as exc:
        return _error_json("upstream_timeout", 504, str(exc))
    except httpx.HTTPStatusError as exc:
        status_code = exc.response.status_code
        if status_code == 400:
            return _error_json("unknown_model", 400)
        if status_code in (401, 403):
            return _error_json("unauthorized", 401)
        return _error_json("upstream_error", 502, f"upstream_status={status_code}")

    api_style = upstream.get("api_style")
    data = upstream.get("data", {})

    if api_style == "native":
        text = ((data.get("message") or {}).get("content") or "").strip()
        prompt_tokens = _estimate_tokens("\n".join(m.content for m in request.messages))
        completion_tokens = _estimate_tokens(text)
        response_body = {
            "id": f"chatcmpl-{uuid.uuid4().hex[:10]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": request.model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
        }
        return JSONResponse(response_body)

    choices = data.get("choices") or [{}]
    message = (choices[0].get("message") or {})
    content = (message.get("content") or "").strip() or "(No response text returned by model.)"

    usage = data.get("usage") or {}
    if not usage:
        prompt_tokens = _estimate_tokens("\n".join(m.content for m in request.messages))
        completion_tokens = _estimate_tokens(content)
        usage = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        }

    response_body = {
        "id": data.get("id", f"chatcmpl-{uuid.uuid4().hex[:10]}"),
        "object": "chat.completion",
        "created": data.get("created", int(time.time())),
        "model": data.get("model", request.model),
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": choices[0].get("finish_reason") or "stop"}],
        "usage": usage,
    }
    return JSONResponse(response_body)
