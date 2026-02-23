from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Iterable, List, Sequence, Tuple
from zoneinfo import ZoneInfo

from api.productivity_schemas import ConflictItem, TimeSlot, UnifiedEvent


@dataclass(frozen=True)
class Interval:
    start: datetime
    end: datetime


def _parse_dt(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _to_utc_interval(event: UnifiedEvent, buffer_minutes: int = 0) -> Interval:
    start = _parse_dt(event.start).astimezone(timezone.utc)
    end = _parse_dt(event.end).astimezone(timezone.utc)
    if buffer_minutes:
        delta = timedelta(minutes=buffer_minutes)
        start -= delta
        end += delta
    return Interval(start=start, end=end)


def merge_intervals(intervals: Iterable[Interval]) -> List[Interval]:
    ordered = sorted(intervals, key=lambda i: (i.start, i.end))
    if not ordered:
        return []
    merged = [ordered[0]]
    for current in ordered[1:]:
        last = merged[-1]
        if current.start <= last.end:
            if current.end > last.end:
                merged[-1] = Interval(start=last.start, end=current.end)
            continue
        merged.append(current)
    return merged


def detect_conflicts(events: Sequence[UnifiedEvent]) -> List[ConflictItem]:
    ordered = sorted(events, key=lambda e: (_parse_dt(e.start), _parse_dt(e.end)))
    conflicts: List[ConflictItem] = []

    for i, left in enumerate(ordered):
        left_start = _parse_dt(left.start)
        left_end = _parse_dt(left.end)
        for right in ordered[i + 1 :]:
            right_start = _parse_dt(right.start)
            right_end = _parse_dt(right.end)
            if right_start >= left_end:
                break
            overlap_start = max(left_start, right_start)
            overlap_end = min(left_end, right_end)
            if overlap_start >= overlap_end:
                continue

            hard = left.status == "confirmed" and right.status == "confirmed"
            ctype = "hard" if hard else "soft"
            conflicts.append(
                ConflictItem(
                    type=ctype,
                    event_ids=[left.id, right.id],
                    provider_labels=[left.provider, right.provider],
                    start=overlap_start.astimezone(timezone.utc).isoformat(),
                    end=overlap_end.astimezone(timezone.utc).isoformat(),
                    explanation=(
                        f"{ctype.title()} conflict between '{left.title}' ({left.provider}) and "
                        f"'{right.title}' ({right.provider})"
                    ),
                )
            )
    return conflicts


def _working_window(target_date: date, tz_name: str, start_hhmm: str, end_hhmm: str) -> Interval:
    tz = ZoneInfo(tz_name)
    sh, sm = [int(x) for x in start_hhmm.split(":", 1)]
    eh, em = [int(x) for x in end_hhmm.split(":", 1)]
    start_local = datetime.combine(target_date, time(sh, sm), tzinfo=tz)
    end_local = datetime.combine(target_date, time(eh, em), tzinfo=tz)
    if end_local <= start_local:
        end_local = end_local + timedelta(days=1)
    return Interval(start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc))


def available_slots(
    events: Sequence[UnifiedEvent],
    day: date,
    tz_name: str,
    duration_minutes: int,
    buffer_minutes: int,
    working_hours_start: str,
    working_hours_end: str,
) -> List[TimeSlot]:
    window = _working_window(day, tz_name, working_hours_start, working_hours_end)
    busy = []
    for event in events:
        interval = _to_utc_interval(event, buffer_minutes=buffer_minutes)
        if interval.end <= window.start or interval.start >= window.end:
            continue
        start = max(interval.start, window.start)
        end = min(interval.end, window.end)
        if start < end:
            busy.append(Interval(start=start, end=end))

    merged_busy = merge_intervals(busy)
    free: List[Interval] = []
    cursor = window.start
    for interval in merged_busy:
        if cursor < interval.start:
            free.append(Interval(start=cursor, end=interval.start))
        cursor = max(cursor, interval.end)
    if cursor < window.end:
        free.append(Interval(start=cursor, end=window.end))

    min_delta = timedelta(minutes=duration_minutes)
    result: List[TimeSlot] = []
    tz = ZoneInfo(tz_name)

    for free_interval in free:
        if (free_interval.end - free_interval.start) < min_delta:
            continue

        total_span = (free_interval.end - free_interval.start)
        start = free_interval.start
        end = start + min_delta
        gap_minutes = total_span.total_seconds() / 60
        score = round(min(1.0, gap_minutes / max(duration_minutes * 3, 1)), 3)
        reason = "Well-spaced slot" if score >= 0.75 else "Available slot"
        result.append(
            TimeSlot(
                start=start.astimezone(tz).isoformat(),
                end=end.astimezone(tz).isoformat(),
                score=score,
                reason=reason,
            )
        )
    return result


def rank_suggestions(
    slots: Sequence[TimeSlot],
    min_count: int,
    preferred_start: str | None = None,
    preferred_end: str | None = None,
) -> List[TimeSlot]:
    def in_preferred(slot: TimeSlot) -> bool:
        if not preferred_start or not preferred_end:
            return True
        slot_dt = _parse_dt(slot.start)
        sh, sm = [int(x) for x in preferred_start.split(":", 1)]
        eh, em = [int(x) for x in preferred_end.split(":", 1)]
        minutes = slot_dt.hour * 60 + slot_dt.minute
        return (sh * 60 + sm) <= minutes <= (eh * 60 + em)

    ranked: List[Tuple[int, float, TimeSlot]] = []
    for slot in slots:
        pref_bonus = 1 if in_preferred(slot) else 0
        ranked.append((pref_bonus, slot.score, slot))

    ranked.sort(key=lambda item: (item[0], item[1], item[2].start), reverse=True)
    return [item[2] for item in ranked[:min_count]]
