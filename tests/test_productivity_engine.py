from datetime import date

from api.productivity_engine import available_slots, detect_conflicts
from api.productivity_schemas import UnifiedEvent


def _event(eid: str, provider: str, title: str, start: str, end: str, status: str = "confirmed") -> UnifiedEvent:
    return UnifiedEvent(
        id=eid,
        provider=provider,  # type: ignore[arg-type]
        calendar_id=f"cal_{provider}",
        title=title,
        start=start,
        end=end,
        status=status,  # type: ignore[arg-type]
        attendees=[],
        timezone="UTC",
        source_account_id=f"acct_{provider}",
    )


def test_detects_hard_and_soft_conflicts():
    events = [
        _event("e1", "google", "Standup", "2026-02-23T10:00:00+00:00", "2026-02-23T10:30:00+00:00", "confirmed"),
        _event("e2", "microsoft", "Client Sync", "2026-02-23T10:15:00+00:00", "2026-02-23T11:00:00+00:00", "confirmed"),
        _event("e3", "google", "Tentative Hold", "2026-02-23T10:20:00+00:00", "2026-02-23T10:40:00+00:00", "tentative"),
    ]

    conflicts = detect_conflicts(events)
    kinds = [c.type for c in conflicts]

    assert "hard" in kinds
    assert "soft" in kinds
    assert any("Standup" in c.explanation for c in conflicts)


def test_available_slots_respects_busy_blocks_and_buffer():
    events = [
        _event("e1", "google", "A", "2026-02-23T10:00:00+00:00", "2026-02-23T10:30:00+00:00"),
        _event("e2", "microsoft", "B", "2026-02-23T13:00:00+00:00", "2026-02-23T14:00:00+00:00"),
    ]

    slots = available_slots(
        events=events,
        day=date(2026, 2, 23),
        tz_name="UTC",
        duration_minutes=30,
        buffer_minutes=10,
        working_hours_start="09:00",
        working_hours_end="17:00",
    )

    assert slots, "expected at least one slot"
    starts = [s.start for s in slots]
    assert all(not start.startswith("2026-02-23T10:0") for start in starts)
    assert any(start.startswith("2026-02-23T09:") for start in starts)
