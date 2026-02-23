from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatCompletionRequest(BaseModel):
    model: str
    messages: List[ChatMessage]
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(default=None, ge=1)
    stream: bool = False
    session_id: Optional[str] = None
    file_ids: Optional[List[str]] = None


class ErrorResponse(BaseModel):
    error: str
    details: Optional[str] = None
    status_code: Optional[int] = None


class ModelItem(BaseModel):
    id: str
    object: str = "model"


class ModelsResponse(BaseModel):
    data: List[ModelItem]


class HealthResponse(BaseModel):
    status: str
    ollama_reachable: bool


class ChatCompletionChoice(BaseModel):
    index: int
    message: Dict[str, str]
    finish_reason: str


class Usage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class ChatCompletionResponse(BaseModel):
    id: str
    object: Literal["chat.completion"] = "chat.completion"
    created: int
    model: str
    choices: List[ChatCompletionChoice]
    usage: Usage


class UploadResponse(BaseModel):
    file_id: str
    filename: str
    status: str
    session_id: str
    chunks: int


class SessionFileItem(BaseModel):
    file_id: str
    filename: str
    created_at: int


class SessionFilesResponse(BaseModel):
    session_id: str
    files: List[SessionFileItem]


JSONDict = Dict[str, Any]
