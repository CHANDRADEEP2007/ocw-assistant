from __future__ import annotations

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field

Provider = Literal["google", "microsoft"]
EventStatus = Literal["confirmed", "tentative"]


class ProviderConnection(BaseModel):
    provider: Provider
    account_id: str
    account_label: str
    connected: bool = True
    scopes: List[str] = Field(default_factory=list)
    encrypted_token_ref: str
    connected_at: str


class CalendarConfig(BaseModel):
    id: str
    provider: Provider
    account_id: str
    name: str
    included: bool = True
    color: Optional[str] = None


class UnifiedEvent(BaseModel):
    id: str
    provider: Provider
    calendar_id: str
    title: str
    start: str
    end: str
    status: EventStatus = "confirmed"
    attendees: List[str] = Field(default_factory=list)
    timezone: str
    source_account_id: str


class AuditLogEntry(BaseModel):
    id: str
    user_id: str
    timestamp: str
    provider: Optional[Provider] = None
    action_type: str
    status: Literal["success", "failure", "pending", "confirmed"]
    target_id: Optional[str] = None
    message: Optional[str] = None


class ConnectProviderRequest(BaseModel):
    user_id: str = Field(min_length=1)
    provider: Provider
    account_label: str = Field(min_length=1)


class DisconnectProviderRequest(BaseModel):
    user_id: str = Field(min_length=1)
    provider: Provider
    account_id: Optional[str] = None


class ConnectionStatusResponse(BaseModel):
    user_id: str
    connections: List[ProviderConnection]


class CalendarListResponse(BaseModel):
    user_id: str
    calendars: List[CalendarConfig]


class CalendarToggleRequest(BaseModel):
    user_id: str
    included: bool


class UnifiedCalendarResponse(BaseModel):
    user_id: str
    timezone: str
    events: List[UnifiedEvent]
    partial_results: bool = False
    failed_providers: List[str] = Field(default_factory=list)


class ConflictItem(BaseModel):
    type: Literal["hard", "soft"]
    event_ids: List[str]
    provider_labels: List[str]
    start: str
    end: str
    explanation: str


class ConflictResponse(BaseModel):
    user_id: str
    conflicts: List[ConflictItem]


class AvailabilityRequest(BaseModel):
    user_id: str
    date: str
    timezone: str = "UTC"
    duration_minutes: int = Field(default=30, ge=5, le=600)
    buffer_minutes: int = Field(default=10, ge=0, le=180)
    working_hours_start: str = Field(default="09:00")
    working_hours_end: str = Field(default="17:00")


class TimeSlot(BaseModel):
    start: str
    end: str
    score: float = 0.0
    reason: Optional[str] = None


class AvailabilityResponse(BaseModel):
    user_id: str
    timezone: str
    duration_minutes: int
    slots: List[TimeSlot]


class SuggestionRequest(AvailabilityRequest):
    min_suggestions: int = Field(default=3, ge=1, le=10)
    preferred_start: Optional[str] = None
    preferred_end: Optional[str] = None


class SuggestionResponse(BaseModel):
    user_id: str
    timezone: str
    suggestions: List[TimeSlot]


class ThreadMessage(BaseModel):
    provider: Provider
    thread_id: str
    sender: str
    sent_at: str
    subject: Optional[str] = None
    body: str


class ThreadSummaryRequest(BaseModel):
    user_id: str
    messages: List[ThreadMessage]


class ThreadSummaryResponse(BaseModel):
    summary: str
    merged_count: int
    providers: List[str]


class DraftReplyRequest(BaseModel):
    user_id: str
    provider: Provider
    thread_id: str
    recipient: str
    subject: str
    thread_summary: str
    tone: str = "professional"


class DraftInviteRequest(BaseModel):
    user_id: str
    provider: Provider
    title: str
    agenda: str
    attendees: List[str]
    duration_minutes: int = Field(default=30, ge=5, le=480)
    timezone: str = "UTC"
    proposed_start: Optional[str] = None


class DraftActionResponse(BaseModel):
    action_id: str
    action_type: str
    provider: Provider
    status: Literal["pending"] = "pending"
    preview: Dict[str, object]
    confirm_required: bool = True


class ConfirmActionResponse(BaseModel):
    action_id: str
    action_type: str
    status: Literal["confirmed"] = "confirmed"
    provider: Provider
    external_id: str


class AuditLogResponse(BaseModel):
    user_id: str
    entries: List[AuditLogEntry]
