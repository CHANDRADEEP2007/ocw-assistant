import asyncio
import json
import os
import time
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Dict, List

import httpx


def _as_bool(value: str, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class CircuitState:
    state: str = "CLOSED"
    failure_count: int = 0
    opened_at: float = 0.0


class OllamaClient:
    def __init__(self) -> None:
        self.base_url = os.getenv("OLLAMA_BASE_URL", "https://ollama.com").rstrip("/")
        self.api_key = os.getenv("OLLAMA_API_KEY", "").strip()
        self.api_style = os.getenv("OLLAMA_API_STYLE", "openai").strip().lower()
        self.timeout_sec = float(os.getenv("OLLAMA_TIMEOUT_SEC", "90"))
        self.verify_tls = _as_bool(os.getenv("OLLAMA_VERIFY_TLS", "true"), default=True)

        self.retry_attempts = int(os.getenv("OCW_RETRY_ATTEMPTS", "2"))
        self.retry_base_delay = float(os.getenv("OCW_RETRY_BASE_DELAY", "0.5"))
        self.breaker_threshold = int(os.getenv("OCW_BREAKER_THRESHOLD", "5"))
        self.breaker_cooldown_sec = int(os.getenv("OCW_BREAKER_COOLDOWN_SEC", "30"))

        self._circuit = CircuitState()

    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _allow_request(self) -> bool:
        if self._circuit.state == "OPEN":
            elapsed = time.time() - self._circuit.opened_at
            if elapsed >= self.breaker_cooldown_sec:
                self._circuit.state = "HALF_OPEN"
                return True
            return False
        return True

    def _record_success(self) -> None:
        self._circuit.state = "CLOSED"
        self._circuit.failure_count = 0
        self._circuit.opened_at = 0.0

    def _record_failure(self) -> None:
        if self._circuit.state == "HALF_OPEN":
            self._circuit.state = "OPEN"
            self._circuit.opened_at = time.time()
            return

        self._circuit.failure_count += 1
        if self._circuit.failure_count >= self.breaker_threshold:
            self._circuit.state = "OPEN"
            self._circuit.opened_at = time.time()

    async def _request_with_retry(self, method: str, url: str, **kwargs) -> httpx.Response:
        if not self._allow_request():
            raise RuntimeError("circuit_open")

        attempt = 0
        while True:
            try:
                async with httpx.AsyncClient(timeout=self.timeout_sec, verify=self.verify_tls) as client:
                    resp = await client.request(method, url, **kwargs)
                if resp.status_code >= 500 and attempt < self.retry_attempts:
                    delay = self.retry_base_delay * (2**attempt)
                    attempt += 1
                    await asyncio.sleep(delay)
                    continue
                resp.raise_for_status()
                self._record_success()
                return resp
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                if attempt < self.retry_attempts:
                    delay = self.retry_base_delay * (2**attempt)
                    attempt += 1
                    await asyncio.sleep(delay)
                    continue
                self._record_failure()
                raise exc
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code >= 500 and attempt < self.retry_attempts:
                    delay = self.retry_base_delay * (2**attempt)
                    attempt += 1
                    await asyncio.sleep(delay)
                    continue
                self._record_failure()
                raise exc

    async def list_models(self) -> List[str]:
        if self.api_style == "native":
            resp = await self._request_with_retry("GET", f"{self.base_url}/api/tags", headers=self._headers())
            data = resp.json()
            return [m.get("name", "") for m in data.get("models", []) if m.get("name")]

        resp = await self._request_with_retry("GET", f"{self.base_url}/api/tags", headers=self._headers())
        if resp.status_code == 404:
            resp = await self._request_with_retry("GET", f"{self.base_url}/v1/models", headers=self._headers())
            data = resp.json()
            return [m.get("id", "") for m in data.get("data", []) if m.get("id")]

        data = resp.json()
        return [m.get("name", "") for m in data.get("models", []) if m.get("name")]

    async def health(self) -> bool:
        try:
            models = await self.list_models()
            return isinstance(models, list)
        except Exception:
            return False

    async def chat_completion(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if bool(payload.get("stream", False)):
            raise ValueError("Use stream_chat_completion for stream requests")

        if self.api_style == "native":
            native_payload = {
                "model": payload["model"],
                "messages": payload["messages"],
                "stream": False,
                "options": {"temperature": payload.get("temperature", 0.7)},
            }
            if payload.get("max_tokens") is not None:
                native_payload["options"]["num_predict"] = payload["max_tokens"]
            resp = await self._request_with_retry(
                "POST", f"{self.base_url}/api/chat", headers=self._headers(), json=native_payload
            )
            return {"api_style": "native", "data": resp.json()}

        resp = await self._request_with_retry(
            "POST", f"{self.base_url}/v1/chat/completions", headers=self._headers(), json=payload
        )
        return {"api_style": "openai", "data": resp.json()}

    async def stream_chat_completion(self, payload: Dict[str, Any]) -> AsyncGenerator[Dict[str, Any], None]:
        if not self._allow_request():
            raise RuntimeError("circuit_open")

        if self.api_style == "native":
            native_payload = {
                "model": payload["model"],
                "messages": payload["messages"],
                "stream": True,
                "options": {"temperature": payload.get("temperature", 0.7)},
            }
            if payload.get("max_tokens") is not None:
                native_payload["options"]["num_predict"] = payload["max_tokens"]

            attempt = 0
            while True:
                try:
                    async with httpx.AsyncClient(timeout=self.timeout_sec, verify=self.verify_tls) as client:
                        async with client.stream(
                            "POST",
                            f"{self.base_url}/api/chat",
                            headers=self._headers(),
                            json=native_payload,
                        ) as resp:
                            resp.raise_for_status()
                            self._record_success()
                            async for line in resp.aiter_lines():
                                if not line:
                                    continue
                                try:
                                    yield {"api_style": "native", "data": json.loads(line)}
                                except json.JSONDecodeError:
                                    continue
                    return
                except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPStatusError) as exc:
                    should_retry = (
                        isinstance(exc, (httpx.TimeoutException, httpx.TransportError))
                        or (isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code >= 500)
                    )
                    if should_retry and attempt < self.retry_attempts:
                        delay = self.retry_base_delay * (2**attempt)
                        attempt += 1
                        await asyncio.sleep(delay)
                        continue
                    self._record_failure()
                    raise exc

        stream_payload = dict(payload)
        stream_payload["stream"] = True

        attempt = 0
        while True:
            try:
                async with httpx.AsyncClient(timeout=self.timeout_sec, verify=self.verify_tls) as client:
                    async with client.stream(
                        "POST",
                        f"{self.base_url}/v1/chat/completions",
                        headers=self._headers(),
                        json=stream_payload,
                    ) as resp:
                        resp.raise_for_status()
                        self._record_success()
                        async for line in resp.aiter_lines():
                            if not line or not line.startswith("data: "):
                                continue
                            body = line[6:].strip()
                            if body == "[DONE]":
                                yield {"api_style": "openai", "done": True}
                                continue
                            try:
                                yield {"api_style": "openai", "data": json.loads(body)}
                            except json.JSONDecodeError:
                                continue
                return
            except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPStatusError) as exc:
                should_retry = (
                    isinstance(exc, (httpx.TimeoutException, httpx.TransportError))
                    or (isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code >= 500)
                )
                if should_retry and attempt < self.retry_attempts:
                    delay = self.retry_base_delay * (2**attempt)
                    attempt += 1
                    await asyncio.sleep(delay)
                    continue
                self._record_failure()
                raise exc
