from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.productivity_routes import router as productivity_router


app = FastAPI()
app.include_router(productivity_router)
client = TestClient(app)


def test_connect_list_unified_and_conflicts():
    user_id = "phase2-user"

    resp = client.post(
        "/v1/productivity/connections/connect",
        json={"user_id": user_id, "provider": "google", "account_label": "Personal Gmail"},
    )
    assert resp.status_code == 200
    assert len(resp.json()["connections"]) >= 1

    resp = client.get("/v1/productivity/calendars", params={"user_id": user_id})
    assert resp.status_code == 200
    calendars = resp.json()["calendars"]
    assert len(calendars) >= 1

    resp = client.get("/v1/productivity/calendar/unified", params={"user_id": user_id})
    assert resp.status_code == 200
    assert len(resp.json()["events"]) >= 1

    resp = client.get("/v1/productivity/calendar/conflicts", params={"user_id": user_id})
    assert resp.status_code == 200
    assert isinstance(resp.json()["conflicts"], list)


def test_draft_invite_requires_confirm_and_writes_audit_log():
    user_id = "audit-user"
    client.post(
        "/v1/productivity/connections/connect",
        json={"user_id": user_id, "provider": "microsoft", "account_label": "Work Outlook"},
    )

    resp = client.post(
        "/v1/productivity/calendar/draft_invite",
        json={
            "user_id": user_id,
            "provider": "microsoft",
            "title": "Roadmap Review",
            "agenda": "Discuss Q2 roadmap",
            "attendees": ["a@example.com"],
            "duration_minutes": 30,
            "timezone": "UTC",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "pending"
    assert body["confirm_required"] is True

    confirm = client.post(f"/v1/productivity/actions/{body['action_id']}/confirm", params={"user_id": user_id})
    assert confirm.status_code == 200
    assert confirm.json()["status"] == "confirmed"

    audits = client.get("/v1/productivity/audit-logs", params={"user_id": user_id}).json()["entries"]
    action_types = [a["action_type"] for a in audits]
    assert "calendar_invite" in action_types
    assert "confirm_calendar_invite" in action_types
