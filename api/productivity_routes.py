from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from api.productivity_engine import available_slots, detect_conflicts, rank_suggestions
from api.productivity_schemas import (
    AuditLogResponse,
    AvailabilityRequest,
    AvailabilityResponse,
    CalendarListResponse,
    CalendarToggleRequest,
    ConflictResponse,
    ConnectProviderRequest,
    ConnectionStatusResponse,
    ConfirmActionResponse,
    DisconnectProviderRequest,
    DraftActionResponse,
    DraftInviteRequest,
    DraftReplyRequest,
    SuggestionRequest,
    SuggestionResponse,
    ThreadSummaryRequest,
    ThreadSummaryResponse,
    UnifiedCalendarResponse,
)
from api.productivity_store import productivity_store

router = APIRouter(prefix="/v1/productivity", tags=["productivity"])


@router.get("/connections", response_model=ConnectionStatusResponse)
async def list_connections(user_id: str = Query(..., min_length=1)) -> ConnectionStatusResponse:
    return ConnectionStatusResponse(user_id=user_id, connections=productivity_store.list_connections(user_id))


@router.post("/connections/connect", response_model=ConnectionStatusResponse)
async def connect_provider(request: ConnectProviderRequest) -> ConnectionStatusResponse:
    productivity_store.connect_provider(request.user_id, request.provider, request.account_label)
    return ConnectionStatusResponse(user_id=request.user_id, connections=productivity_store.list_connections(request.user_id))


@router.post("/connections/disconnect", response_model=ConnectionStatusResponse)
async def disconnect_provider(request: DisconnectProviderRequest) -> ConnectionStatusResponse:
    productivity_store.disconnect_provider(request.user_id, request.provider, request.account_id)
    return ConnectionStatusResponse(user_id=request.user_id, connections=productivity_store.list_connections(request.user_id))


@router.get("/calendars", response_model=CalendarListResponse)
async def list_calendars(user_id: str = Query(..., min_length=1)) -> CalendarListResponse:
    return CalendarListResponse(user_id=user_id, calendars=productivity_store.list_calendars(user_id))


@router.post("/calendars/{calendar_id}/toggle", response_model=CalendarListResponse)
async def toggle_calendar(calendar_id: str, request: CalendarToggleRequest) -> CalendarListResponse:
    try:
        productivity_store.set_calendar_included(request.user_id, calendar_id, request.included)
    except KeyError as exc:
        if str(exc) == "'calendar_not_found'":
            raise HTTPException(status_code=404, detail="calendar_not_found") from exc
        raise
    return CalendarListResponse(user_id=request.user_id, calendars=productivity_store.list_calendars(request.user_id))


@router.get("/calendar/unified", response_model=UnifiedCalendarResponse)
async def unified_calendar(
    user_id: str = Query(..., min_length=1),
    timezone: str = Query(default="UTC"),
    start: Optional[str] = Query(default=None),
    end: Optional[str] = Query(default=None),
) -> UnifiedCalendarResponse:
    events = productivity_store.get_unified_events(user_id)
    if start:
        events = [e for e in events if e.end >= start]
    if end:
        events = [e for e in events if e.start <= end]
    return UnifiedCalendarResponse(user_id=user_id, timezone=timezone, events=events)


@router.get("/calendar/conflicts", response_model=ConflictResponse)
async def calendar_conflicts(user_id: str = Query(..., min_length=1)) -> ConflictResponse:
    events = productivity_store.get_unified_events(user_id)
    return ConflictResponse(user_id=user_id, conflicts=detect_conflicts(events))


@router.post("/calendar/availability", response_model=AvailabilityResponse)
async def calendar_availability(request: AvailabilityRequest) -> AvailabilityResponse:
    day = date.fromisoformat(request.date)
    events = productivity_store.get_unified_events(request.user_id)
    slots = available_slots(
        events=events,
        day=day,
        tz_name=request.timezone,
        duration_minutes=request.duration_minutes,
        buffer_minutes=request.buffer_minutes,
        working_hours_start=request.working_hours_start,
        working_hours_end=request.working_hours_end,
    )
    return AvailabilityResponse(
        user_id=request.user_id,
        timezone=request.timezone,
        duration_minutes=request.duration_minutes,
        slots=slots,
    )


@router.post("/calendar/suggestions", response_model=SuggestionResponse)
async def calendar_suggestions(request: SuggestionRequest) -> SuggestionResponse:
    day = date.fromisoformat(request.date)
    events = productivity_store.get_unified_events(request.user_id)
    slots = available_slots(
        events=events,
        day=day,
        tz_name=request.timezone,
        duration_minutes=request.duration_minutes,
        buffer_minutes=request.buffer_minutes,
        working_hours_start=request.working_hours_start,
        working_hours_end=request.working_hours_end,
    )
    suggestions = rank_suggestions(
        slots,
        min_count=request.min_suggestions,
        preferred_start=request.preferred_start,
        preferred_end=request.preferred_end,
    )
    return SuggestionResponse(user_id=request.user_id, timezone=request.timezone, suggestions=suggestions)


@router.post("/email/summarize_thread", response_model=ThreadSummaryResponse)
async def summarize_thread(request: ThreadSummaryRequest) -> ThreadSummaryResponse:
    ordered = sorted(request.messages, key=lambda m: m.sent_at)
    providers = sorted({m.provider for m in ordered})
    snippets = [f"[{m.provider}] {m.sender}: {m.body.strip()[:140]}" for m in ordered]
    summary_lines = [
        f"Merged {len(ordered)} messages across {', '.join(providers)}.",
        "Chronological summary:",
        *snippets[:8],
    ]
    return ThreadSummaryResponse(summary="\n".join(summary_lines), merged_count=len(ordered), providers=providers)


@router.post("/email/draft_reply", response_model=DraftActionResponse)
async def draft_reply(request: DraftReplyRequest) -> DraftActionResponse:
    body = (
        f"Subject: Re: {request.subject}\n\n"
        f"Hi,\n\n"
        f"Thanks for the update. Based on the thread summary, {request.thread_summary.strip()}\n\n"
        f"Best,\n"
    )
    action = productivity_store.create_pending_action(
        user_id=request.user_id,
        provider=request.provider,
        action_type="email_reply",
        preview={
            "thread_id": request.thread_id,
            "recipient": request.recipient,
            "subject": f"Re: {request.subject}",
            "body": body,
            "editable": True,
        },
    )
    return DraftActionResponse(
        action_id=action.action_id,
        action_type=action.action_type,
        provider=request.provider,
        preview=action.preview,
    )


@router.post("/calendar/draft_invite", response_model=DraftActionResponse)
async def draft_invite(request: DraftInviteRequest) -> DraftActionResponse:
    preview = {
        "title": request.title,
        "agenda": request.agenda,
        "attendees": request.attendees,
        "duration_minutes": request.duration_minutes,
        "timezone": request.timezone,
        "proposed_start": request.proposed_start,
        "send_enabled": False,
        "confirm_required": True,
    }
    action = productivity_store.create_pending_action(
        user_id=request.user_id,
        provider=request.provider,
        action_type="calendar_invite",
        preview=preview,
    )
    return DraftActionResponse(
        action_id=action.action_id,
        action_type=action.action_type,
        provider=request.provider,
        preview=action.preview,
    )


@router.post("/actions/{action_id}/confirm", response_model=ConfirmActionResponse)
async def confirm_action(action_id: str, user_id: str = Query(..., min_length=1)) -> ConfirmActionResponse:
    try:
        action = productivity_store.confirm_action(user_id=user_id, action_id=action_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="action_not_found") from exc
    return ConfirmActionResponse(
        action_id=action.action_id,
        action_type=action.action_type,
        provider=action.provider,  # type: ignore[arg-type]
        external_id=f"sim_{action.action_type}_{action.action_id[-6:]}",
    )


@router.get("/audit-logs", response_model=AuditLogResponse)
async def audit_logs(user_id: str = Query(..., min_length=1), limit: int = Query(default=50, ge=1, le=500)) -> AuditLogResponse:
    return AuditLogResponse(user_id=user_id, entries=productivity_store.audit_logs(user_id, limit=limit))
