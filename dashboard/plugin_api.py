"""Authenticated proxy for The Oblist inline action cards."""

import asyncio
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _actor_ref(request: Request) -> str:
    session = getattr(request.state, "session", None)
    user_id = str(getattr(session, "user_id", "") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Authenticated user required")
    return user_id[:300]


def _request_ai_ops(path: str, method: str = "GET", body: dict | None = None) -> dict:
    base_url = os.environ.get(
        "OBLIST_MEMORY_API_URL",
        "http://ai-ops-memory-api.railway.internal:8787",
    ).rstrip("/")
    token = os.environ.get("OBLIST_ACTION_CARD_REVIEW_TOKEN", "")
    if not token:
        raise RuntimeError("OBLIST_ACTION_CARD_REVIEW_TOKEN is not configured")
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
async def get_action(action_id: str):
    action_id = _validated_id(action_id)
    return await asyncio.to_thread(
        _request_ai_ops,
        f"/v1/action-cards/{action_id}",
    )


@router.get("/overview")
async def get_overview(request: Request):
    operator = _validated_operator(request.query_params.get("operator", ""))
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
    operator = _validated_operator(request.query_params.get("operator", ""))
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


@router.post("/notifications/{notification_id}/outcome")
async def mark_notification(
    notification_id: str,
    body: dict,
    request: Request,
):
    notification_id = _validated_id(notification_id)
    operator = _validated_operator(request.query_params.get("operator", ""))
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


@router.post("/actions/{action_id}/edit")
async def edit_action(action_id: str, body: dict, request: Request):
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
