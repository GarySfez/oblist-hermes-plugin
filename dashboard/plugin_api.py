"""Authenticated proxy for The Oblist inline action cards."""

import asyncio
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_ADMIN_EMAILS = {"garysfez@oblist.com"}
_OPERATOR_BY_EMAIL = {
    "lyse@oblist.com": "lyse",
    "philippine@oblist.com": "philippine",
}
_IDENTITY_CACHE: dict[str, tuple[float, str]] = {}


def _configured_identity_map() -> dict[str, str]:
    raw = os.environ.get("OBLIST_HERMES_IDENTITY_MAP", "")
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {
        str(user_id).strip(): str(email).strip().lower()
        for user_id, email in parsed.items()
        if str(user_id).strip() and str(email).strip()
    }


def _actor_ref(request: Request) -> str:
    session = getattr(request.state, "session", None)
    user_id = str(getattr(session, "user_id", "") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Authenticated user required")
    return user_id[:300]


def _session_email(request: Request) -> str:
    session = getattr(request.state, "session", None)
    email = str(getattr(session, "email", "") or "").strip().lower()
    if email:
        return email
    user_id = str(getattr(session, "user_id", "") or "").strip()
    cached = _IDENTITY_CACHE.get(user_id)
    if cached and cached[0] > time.time():
        return cached[1]
    configured_email = _configured_identity_map().get(user_id)
    if configured_email:
        _IDENTITY_CACHE[user_id] = (
            time.time() + 300,
            configured_email,
        )
        return configured_email
    access_token = str(getattr(session, "access_token", "") or "").strip()
    if not access_token:
        raise HTTPException(status_code=401, detail="Authenticated email required")
    portal_url = os.environ.get(
        "HERMES_DASHBOARD_PORTAL_URL",
        "https://portal.nousresearch.com",
    ).rstrip("/")
    account_request = urllib.request.Request(
        f"{portal_url}/api/oauth/account",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(account_request, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as error:
        raise HTTPException(
            status_code=503,
            detail="Authenticated identity unavailable",
        ) from error
    user = payload.get("user") if isinstance(payload, dict) else None
    email = (
        str(user.get("email") or "").strip().lower()
        if isinstance(user, dict)
        else ""
    )
    if not email:
        raise HTTPException(status_code=403, detail="Account email unavailable")
    _IDENTITY_CACHE[user_id] = (time.time() + 300, email)
    return email


def _authorized_operator(request: Request, requested: str) -> str:
    requested = _validated_operator(requested)
    email = _session_email(request)
    if email in _ADMIN_EMAILS:
        return requested
    operator = _OPERATOR_BY_EMAIL.get(email)
    if not operator:
        raise HTTPException(status_code=403, detail="Operator access denied")
    if requested and requested != operator:
        raise HTTPException(status_code=403, detail="Cross-profile access denied")
    return operator


def _require_oblist_operator(request: Request) -> None:
    email = _session_email(request)
    if email not in _ADMIN_EMAILS and email not in _OPERATOR_BY_EMAIL:
        raise HTTPException(status_code=403, detail="Operator access denied")


def _request_ai_ops(path: str, method: str = "GET", body: dict | None = None) -> dict:
    base_url = os.environ.get(
        "OBLIST_MEMORY_API_URL",
        "https://ai-ops-memory-api-production.up.railway.app",
    ).rstrip("/")
    token = (
        os.environ.get("OBLIST_ACTION_CARD_REVIEW_TOKEN", "")
        or os.environ.get("MCP_OBLIST_ACTIONS_API_KEY", "")
    )
    if not token:
        raise RuntimeError("No action-card gateway token is configured")
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = "Action Card Gateway rejected the request"
        try:
            payload = json.loads(error.read().decode("utf-8"))
            if isinstance(payload, dict) and isinstance(payload.get("error"), str):
                detail = payload["error"]
        except Exception:
            pass
        raise HTTPException(status_code=error.code, detail=detail) from error


def _validated_id(action_id: str) -> str:
    if not _UUID_RE.fullmatch(action_id):
        raise HTTPException(status_code=400, detail="Invalid action card ID")
    return action_id


def _validated_operator(value: str) -> str:
    if value not in {"", "lyse", "philippine"}:
        raise HTTPException(status_code=400, detail="Invalid operator")
    return value


@router.get("/actions/{action_id}")
async def get_action(action_id: str, request: Request):
    _require_oblist_operator(request)
    action_id = _validated_id(action_id)
    return await asyncio.to_thread(
        _request_ai_ops,
        f"/v1/action-cards/{action_id}",
    )


@router.get("/overview")
async def get_overview(request: Request):
    operator = _authorized_operator(
        request,
        request.query_params.get("operator", ""),
    )
    view = request.query_params.get("view", "")
    allowed_views = {
        "",
        "MY_INBOX",
        "TEAM_SUPPORT",
        "ESCALATION_RISK",
        "FRUSTRATED_PRIORITY",
        "ETA_REQUEST",
        "SHIPPING_QUOTE",
    }
    if view not in allowed_views:
        raise HTTPException(status_code=400, detail="Invalid view")
    query = urllib.parse.urlencode(
        {
            **({"operatorRef": operator} if operator else {}),
            **({"viewKey": view} if view else {}),
            "limit": "40",
        }
    )
    return await asyncio.to_thread(
        _request_ai_ops,
        f"/v1/cs-overview?{query}",
    )


@router.get("/notifications")
async def get_notifications(request: Request):
    operator = _authorized_operator(
        request,
        request.query_params.get("operator", ""),
    )
    query = urllib.parse.urlencode(
        {
            **({"operatorRef": operator} if operator else {}),
            "limit": "3",
        }
    )
    return await asyncio.to_thread(
        _request_ai_ops,
        f"/v1/desktop-notifications?{query}",
    )


@router.get("/notification-inbox")
async def get_notification_inbox(request: Request):
    operator = _authorized_operator(
        request,
        request.query_params.get("operator", ""),
    )
    query = urllib.parse.urlencode(
        {
            **({"operatorRef": operator} if operator else {}),
            "limit": "50",
        }
    )
    return await asyncio.to_thread(
        _request_ai_ops,
        f"/v1/desktop-notification-inbox?{query}",
    )


@router.post("/notifications/{notification_id}/outcome")
async def mark_notification(
    notification_id: str,
    body: dict,
    request: Request,
):
    notification_id = _validated_id(notification_id)
    operator = _authorized_operator(
        request,
        request.query_params.get("operator", ""),
    )
    outcome = body.get("outcome")
    if outcome not in {"DELIVERED", "RETRY"}:
        raise HTTPException(status_code=400, detail="Invalid outcome")
    payload = {
        "outcome": outcome,
        **({"operatorRef": operator} if operator else {}),
    }
    if isinstance(body.get("errorCode"), str):
        payload["errorCode"] = body["errorCode"][:100]
    return await asyncio.to_thread(
        _request_ai_ops,
        f"/v1/desktop-notifications/{notification_id}/outcome",
        "POST",
        payload,
    )


@router.post("/notifications/{notification_id}/read")
async def mark_notification_read(
    notification_id: str,
    request: Request,
):
    notification_id = _validated_id(notification_id)
    operator = _authorized_operator(
        request,
        request.query_params.get("operator", ""),
    )
    payload = {
        "actorRef": _actor_ref(request),
        **({"operatorRef": operator} if operator else {}),
    }
    return await asyncio.to_thread(
        _request_ai_ops,
        f"/v1/desktop-notifications/{notification_id}/read",
        "POST",
        payload,
    )


@router.post("/actions/{action_id}/edit")
async def edit_action(action_id: str, body: dict, request: Request):
    _require_oblist_operator(request)
    action_id = _validated_id(action_id)
    payload = {
        "expectedVersion": body.get("expectedVersion"),
        "subject": body.get("subject"),
        "body": body.get("body"),
        "actorRef": _actor_ref(request),
    }
    if "infoRequest" in body:
        payload["infoRequest"] = body["infoRequest"]
    return await asyncio.to_thread(
        _request_ai_ops,
        f"/v1/action-cards/{action_id}/edit",
        "POST",
        payload,
    )


@router.post("/actions/{action_id}/decision")
async def decide_action(action_id: str, body: dict, request: Request):
    _require_oblist_operator(request)
    action_id = _validated_id(action_id)
    payload = {
        "expectedVersion": body.get("expectedVersion"),
        "decision": body.get("decision"),
        "actorRef": _actor_ref(request),
    }
    if isinstance(body.get("reason"), str):
        payload["reason"] = body["reason"][:2000]
    if isinstance(body.get("externalRef"), str):
        payload["externalRef"] = body["externalRef"][:500]
    return await asyncio.to_thread(
        _request_ai_ops,
        f"/v1/action-cards/{action_id}/decision",
        "POST",
        payload,
    )


@router.post("/actions/{action_id}/execute")
async def execute_action(action_id: str, body: dict, request: Request):
    _require_oblist_operator(request)
    action_id = _validated_id(action_id)
    payload = {
        "expectedVersion": body.get("expectedVersion"),
        "actorRef": _actor_ref(request),
    }
    return await asyncio.to_thread(
        _request_ai_ops,
        f"/v1/action-cards/{action_id}/execute",
        "POST",
        payload,
    )
