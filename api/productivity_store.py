from __future__ import annotations

import base64
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from api.productivity_schemas import AuditLogEntry, CalendarConfig, ProviderConnection, UnifiedEvent


GOOGLE_SCOPES = ["gmail.readonly", "gmail.compose", "calendar.readonly"]
MICROSOFT_SCOPES = ["Mail.Read", "Mail.Send", "Calendars.Read"]


@dataclass
class PendingAction:
    action_id: str
    user_id: str
    provider: str
    action_type: str
    preview: Dict[str, object]
    status: str = "pending"


@dataclass
class UserState:
    connections: Dict[str, ProviderConnection] = field(default_factory=dict)
    calendars: Dict[str, CalendarConfig] = field(default_factory=dict)
    events: Dict[str, UnifiedEvent] = field(default_factory=dict)
    audit_logs: List[AuditLogEntry] = field(default_factory=list)
    pending_actions: Dict[str, PendingAction] = field(default_factory=dict)


class ProductivityStore:
    def __init__(self):
        self._users: Dict[str, UserState] = {}

    def _state(self, user_id: str) -> UserState:
        if user_id not in self._users:
            self._users[user_id] = UserState()
        return self._users[user_id]

    def _log(
        self,
        user_id: str,
        action_type: str,
        status: str,
        provider: Optional[str] = None,
        target_id: Optional[str] = None,
        message: Optional[str] = None,
    ) -> AuditLogEntry:
        entry = AuditLogEntry(
            id=f"log_{uuid.uuid4().hex[:10]}",
            user_id=user_id,
            timestamp=datetime.now(timezone.utc).isoformat(),
            provider=provider,  # type: ignore[arg-type]
            action_type=action_type,
            status=status,  # type: ignore[arg-type]
            target_id=target_id,
            message=message,
        )
        self._state(user_id).audit_logs.insert(0, entry)
        return entry

    def connect_provider(self, user_id: str, provider: str, account_label: str) -> ProviderConnection:
        state = self._state(user_id)
        account_id = f"{provider}_{uuid.uuid4().hex[:8]}"
        token_ref = base64.b64encode(f"{user_id}:{account_id}".encode("utf-8")).decode("utf-8")
        scopes = GOOGLE_SCOPES if provider == "google" else MICROSOFT_SCOPES
        conn = ProviderConnection(
            provider=provider,  # type: ignore[arg-type]
            account_id=account_id,
            account_label=account_label,
            scopes=scopes,
            encrypted_token_ref=token_ref,
            connected_at=datetime.now(timezone.utc).isoformat(),
        )
        state.connections[account_id] = conn
        self._seed_calendars_and_events(user_id=user_id, conn=conn)
        self._log(user_id, action_type="connect_provider", status="success", provider=provider, target_id=account_id)
        return conn

    def disconnect_provider(self, user_id: str, provider: str, account_id: Optional[str] = None) -> int:
        state = self._state(user_id)
        to_remove = [
            aid
            for aid, conn in state.connections.items()
            if conn.provider == provider and (account_id is None or aid == account_id)
        ]
        for aid in to_remove:
            del state.connections[aid]
            for cid in [cid for cid, cal in state.calendars.items() if cal.account_id == aid]:
                del state.calendars[cid]
                for eid in [eid for eid, ev in state.events.items() if ev.calendar_id == cid]:
                    del state.events[eid]
        self._log(
            user_id,
            action_type="disconnect_provider",
            status="success",
            provider=provider,
            target_id=account_id,
            message=f"removed={len(to_remove)}",
        )
        return len(to_remove)

    def list_connections(self, user_id: str) -> List[ProviderConnection]:
        return list(self._state(user_id).connections.values())

    def list_calendars(self, user_id: str) -> List[CalendarConfig]:
        return list(self._state(user_id).calendars.values())

    def set_calendar_included(self, user_id: str, calendar_id: str, included: bool) -> CalendarConfig:
        state = self._state(user_id)
        cal = state.calendars.get(calendar_id)
        if not cal:
            raise KeyError("calendar_not_found")
        updated = cal.model_copy(update={"included": included})
        state.calendars[calendar_id] = updated
        self._log(
            user_id,
            action_type="toggle_calendar",
            status="success",
            provider=updated.provider,
            target_id=calendar_id,
            message=f"included={included}",
        )
        return updated

    def get_unified_events(self, user_id: str) -> List[UnifiedEvent]:
        state = self._state(user_id)
        included_ids = {c.id for c in state.calendars.values() if c.included}
        events = [ev for ev in state.events.values() if ev.calendar_id in included_ids]
        return sorted(events, key=lambda e: e.start)

    def create_pending_action(self, user_id: str, provider: str, action_type: str, preview: Dict[str, object]) -> PendingAction:
        action = PendingAction(
            action_id=f"act_{uuid.uuid4().hex[:10]}",
            user_id=user_id,
            provider=provider,
            action_type=action_type,
            preview=preview,
        )
        self._state(user_id).pending_actions[action.action_id] = action
        self._log(
            user_id,
            action_type=action_type,
            status="pending",
            provider=provider,
            target_id=action.action_id,
            message="confirm_before_send",
        )
        return action

    def confirm_action(self, user_id: str, action_id: str) -> PendingAction:
        state = self._state(user_id)
        action = state.pending_actions.get(action_id)
        if not action or action.user_id != user_id:
            raise KeyError("action_not_found")
        action.status = "confirmed"
        self._log(
            user_id,
            action_type=f"confirm_{action.action_type}",
            status="confirmed",
            provider=action.provider,
            target_id=action_id,
            message="simulated_send",
        )
        return action

    def audit_logs(self, user_id: str, limit: int = 100) -> List[AuditLogEntry]:
        return self._state(user_id).audit_logs[:limit]

    def _seed_calendars_and_events(self, user_id: str, conn: ProviderConnection) -> None:
        state = self._state(user_id)
        provider_prefix = "gcal" if conn.provider == "google" else "mcal"
        c1 = CalendarConfig(
            id=f"{provider_prefix}_{uuid.uuid4().hex[:6]}",
            provider=conn.provider,
            account_id=conn.account_id,
            name=f"{conn.account_label} - Primary",
            included=True,
        )
        c2 = CalendarConfig(
            id=f"{provider_prefix}_{uuid.uuid4().hex[:6]}",
            provider=conn.provider,
            account_id=conn.account_id,
            name=f"{conn.account_label} - Personal",
            included=True,
        )
        state.calendars[c1.id] = c1
        state.calendars[c2.id] = c2

        now = datetime.now(timezone.utc)
        base_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
        offsets = [(10, 0, 30, "Standup", "confirmed", c1.id), (11, 0, 60, "Planning", "tentative", c2.id)]
        if conn.provider == "microsoft":
            offsets = [(10, 15, 45, "Client Sync", "confirmed", c1.id), (15, 0, 30, "Inbox Triage", "confirmed", c2.id)]
        for hour, minute, dur, title, status, cal_id in offsets:
            start = base_day + timedelta(hours=hour, minutes=minute)
            end = start + timedelta(minutes=dur)
            ev = UnifiedEvent(
                id=f"evt_{uuid.uuid4().hex[:8]}",
                provider=conn.provider,
                calendar_id=cal_id,
                title=title,
                start=start.isoformat(),
                end=end.isoformat(),
                status=status,  # type: ignore[arg-type]
                attendees=[],
                timezone="UTC",
                source_account_id=conn.account_id,
            )
            state.events[ev.id] = ev


productivity_store = ProductivityStore()
