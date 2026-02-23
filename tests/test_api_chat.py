from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import routes
from api.document_store import document_store


app = FastAPI()
app.include_router(routes.router)


def test_chat_completion_non_stream():
    async def fake_chat_completion(payload):
        return {
            "api_style": "openai",
            "data": {
                "id": "chatcmpl-test",
                "created": 1,
                "model": payload["model"],
                "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        }

    routes.client.chat_completion = fake_chat_completion

    client = TestClient(app)
    resp = client.post(
        "/v1/chat/completions",
        json={
            "model": "test-model",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": False,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["object"] == "chat.completion"
    assert body["choices"][0]["message"]["content"] == "ok"


def test_chat_uses_uploaded_document_context():
    doc = document_store.add_document(
        session_id="s-test",
        filename="facts.txt",
        content_type="text/plain",
        content=b"Project delta increased by 22 percent.",
    )

    captured = {}

    async def fake_chat_completion(payload):
        captured["messages"] = payload["messages"]
        return {
            "api_style": "openai",
            "data": {
                "id": "chatcmpl-test",
                "created": 1,
                "model": payload["model"],
                "choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        }

    routes.client.chat_completion = fake_chat_completion

    client = TestClient(app)
    resp = client.post(
        "/v1/chat/completions",
        json={
            "model": "test-model",
            "messages": [{"role": "user", "content": "what changed?"}],
            "stream": False,
            "session_id": "s-test",
            "file_ids": [doc.file_id],
        },
    )

    assert resp.status_code == 200
    assert captured["messages"][0]["role"] == "system"
    assert "uploaded document context" in captured["messages"][0]["content"]
