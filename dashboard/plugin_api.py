"""Authenticated proxy for The Oblist inline action cards."""

import asyncio
import json
import os
from pathlib import Path
import re
import signal
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

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
_PREFLIGHT_CACHE: dict[
    tuple[str, str, str],
    tuple[float, int, bool],
] = {}
_PLUGIN_VERSION = "0.4.0"
_RELEASE_EPOCH = "hermes-intelligence-v2"
_MANAGED_PLUGIN_REPOSITORY = "GarySfez/oblist-hermes-plugin"
_MANAGED_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
_MANAGED_PLUGIN_COMMIT_RE = re.compile(r"^[a-f0-9]{40}$")
_MANAGED_PLUGIN_UPDATE_LOCK = asyncio.Lock()
_MANAGED_PLUGIN_WATCH_TASK: asyncio.Task | None = None
_AI_OPS_API_PATHS = {
    "runtime_handshake": "/v1/release/handshake",
    "plugin_release": "/v1/plugin-release",
    "action": "/v1/action-cards/{action_id}",
    "action_edit": "/v1/action-cards/{action_id}/edit",
    "action_decision": "/v1/action-cards/{action_id}/decision",
    "action_execute": "/v1/action-cards/{action_id}/execute",
    "action_outcome": "/v1/action-cards/{action_id}/outcome",
    "overview": "/v1/cs-overview",
    "notifications": "/v1/desktop-notifications",
    "notification_inbox": "/v1/desktop-notification-inbox",
    "notification_outcome": (
        "/v1/desktop-notifications/{notification_id}/outcome"
    ),
    "notification_read": (
        "/v1/desktop-notifications/{notification_id}/read"
    ),
    "workflow_claim": "/v1/case-watches/{workflow_id}/claim",
    "workflow_confirm_assignment": (
        "/v1/case-watches/{workflow_id}/claim/confirm"
    ),
    "workflow_release": (
        "/v1/case-watches/{workflow_id}/claim/release"
    ),
    "workflow_closure": "/v1/case-watches/{workflow_id}/closure",
}
_RELEASE_CONTRACT_PATH = Path(__file__).with_name("release_contract.json")


class ManagedPluginReleaseUnavailableError(RuntimeError):
    pass


def _api_path(name: str, **values: str) -> str:
    return _AI_OPS_API_PATHS[name].format(**values)


def _runtime_handshake_path() -> str:
    return _api_path("runtime_handshake")


def _release_contract() -> dict:
    try:
        contract = json.loads(_RELEASE_CONTRACT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("Plugin release contract is unavailable") from error
    required = {
        "releaseVersion",
        "contractVersion",
        "schemaVersion",
        "memoryApiVersion",
        "workerVersion",
        "pluginVersion",
        "manifestDigestEnv",
    }
    if (
        not isinstance(contract, dict)
        or not required.issubset(contract)
        or any(not isinstance(contract[key], str) for key in required)
    ):
        raise RuntimeError("Plugin release contract is invalid")
    digest = contract.get("manifestDigest")
    if digest is not None and (
        not isinstance(digest, str)
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest)
    ):
        raise RuntimeError("Plugin manifest digest is invalid")
    if contract.get("manifestDigestEnv") != "OBLIST_HERMES_MANIFEST_DIGEST":
        raise RuntimeError("Plugin manifest digest source is invalid")
    configured_digest = os.environ.get(
        "OBLIST_HERMES_MANIFEST_DIGEST",
        "",
    ).strip()
    if configured_digest:
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", configured_digest):
            raise RuntimeError(
                "Configured plugin manifest digest is invalid"
            )
        contract = {
            **contract,
            "manifestDigest": configured_digest,
        }
    return contract


def _release_headers(contract: dict, release_epoch: int | None = None) -> dict:
    headers = {
        "X-Hermes-Release-Version": contract["releaseVersion"],
        "X-Hermes-Contract-Version": contract["contractVersion"],
        "X-Hermes-Schema-Version": contract["schemaVersion"],
        "X-Hermes-Memory-Api-Version": contract["memoryApiVersion"],
        "X-Hermes-Worker-Version": contract["workerVersion"],
        "X-Hermes-Plugin-Version": contract["pluginVersion"],
    }
    if isinstance(contract.get("manifestDigest"), str):
        headers["X-Hermes-Manifest-Digest"] = contract["manifestDigest"]
    if release_epoch is not None:
        headers["X-Hermes-Release-Epoch"] = str(release_epoch)
    return headers


def _release_preflight(
    base_url: str,
    token: str,
    contract: dict,
) -> tuple[int, bool]:
    request = urllib.request.Request(
        f"{base_url}/v1/release/handshake",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            **_release_headers(contract),
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise RuntimeError(
            f"Release handshake rejected with {error.code}"
        ) from error
    except Exception as error:
        raise RuntimeError("Release handshake is unavailable") from error
    epoch = payload.get("releaseEpoch") if isinstance(payload, dict) else None
    if not isinstance(epoch, int) or epoch < 0:
        raise RuntimeError("Release handshake returned an invalid epoch")
    return epoch, payload.get("preflightCompatible") is True


def _cached_release_preflight(
    base_url: str,
    token: str,
    contract: dict,
    force: bool = False,
) -> tuple[int, bool]:
    contract_key = "|".join(
        str(contract.get(key, ""))
        for key in (
            "releaseVersion",
            "contractVersion",
            "schemaVersion",
            "memoryApiVersion",
            "workerVersion",
            "pluginVersion",
            "manifestDigest",
        )
    )
    key = (base_url, token, contract_key)
    cached = _PREFLIGHT_CACHE.get(key)
    if not force and cached and cached[0] > time.monotonic():
        return cached[1], cached[2]
    epoch, compatible = _release_preflight(
        base_url,
        token,
        contract,
    )
    _PREFLIGHT_CACHE[key] = (
        time.monotonic() + 10,
        epoch,
        compatible,
    )
    return epoch, compatible


def _verify_release_response(
    response,
    contract: dict,
    release_epoch: int,
    preflight_compatible: bool,
) -> None:
    if response.headers.get("x-hermes-release-epoch") != str(release_epoch):
        raise RuntimeError("AI Ops release epoch changed during request")
    if not preflight_compatible:
        if response.headers.get("x-hermes-runtime-mode") != "OFF":
            raise RuntimeError("AI Ops did not fail closed on contract mismatch")
        return
    expected = {
        "x-hermes-release-version": contract["releaseVersion"],
        "x-hermes-contract-version": contract["contractVersion"],
        "x-hermes-schema-version": contract["schemaVersion"],
        "x-hermes-memory-api-version": contract["memoryApiVersion"],
        "x-hermes-worker-version": contract["workerVersion"],
        "x-hermes-plugin-version": contract["pluginVersion"],
    }
    for header, value in expected.items():
        if response.headers.get(header) != value:
            raise RuntimeError("AI Ops release handshake changed during request")
    if (
        response.headers.get("x-hermes-configured-mode") == "LIVE"
        and response.headers.get("x-hermes-handshake-compatible") != "true"
    ):
        raise RuntimeError("AI Ops refused the plugin release handshake")


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
    contract = _release_contract()
    force_preflight = (
        path.endswith("/execute")
        or path.endswith("/claim/confirm")
    )
    release_epoch, preflight_compatible = _cached_release_preflight(
        base_url,
        token,
        contract,
        force_preflight,
    )
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            **_release_headers(contract, release_epoch),
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            try:
                _verify_release_response(
                    response,
                    contract,
                    release_epoch,
                    preflight_compatible,
                )
            except RuntimeError:
                _PREFLIGHT_CACHE.clear()
                raise
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


def _normalized_runtime(payload: dict) -> dict:
    mode = payload.get("configuredMode")
    if mode not in {"OFF", "SHADOW", "LIVE"}:
        mode = payload.get("effectiveMode")
    if mode not in {"OFF", "SHADOW", "LIVE"}:
        mode = "OFF"
    versions = payload.get("versions")
    if not isinstance(versions, dict):
        versions = {}
    compatible = (
        payload.get("preflightCompatible") is True
        and versions.get("releaseVersion") == _RELEASE_EPOCH
        and versions.get("pluginVersion") == _PLUGIN_VERSION
    )
    control_epoch = payload.get("releaseEpoch")
    return {
        "mode": mode,
        "releaseEpoch": _RELEASE_EPOCH if compatible else None,
        "controlEpoch": (
            control_epoch
            if isinstance(control_epoch, int) and control_epoch >= 0
            else None
        ),
        "compatible": compatible,
        "pluginVersion": _PLUGIN_VERSION,
        "fallback": "V1",
    }


def _v1_runtime_fallback() -> dict:
    return {
        "mode": "OFF",
        "releaseEpoch": None,
        "compatible": False,
        "pluginVersion": _PLUGIN_VERSION,
        "fallback": "V1",
    }


def _fetch_runtime() -> dict:
    return _normalized_runtime(_request_ai_ops(_runtime_handshake_path()))


def _require_live_runtime() -> dict:
    try:
        runtime = _fetch_runtime()
    except Exception as error:
        raise HTTPException(
            status_code=409,
            detail=(
                "Le suivi avancé est temporairement indisponible. "
                "Aucune action n’a été effectuée."
            ),
        ) from error
    if (
        runtime["mode"] != "LIVE"
        or not runtime["compatible"]
        or runtime["releaseEpoch"] != _RELEASE_EPOCH
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "Le suivi avancé n’est pas disponible dans cette version. "
                "Aucune action n’a été effectuée."
            ),
        )
    return runtime


def _current_managed_plugin_commit() -> str | None:
    try:
        head = (
            _MANAGED_PLUGIN_ROOT / ".git" / "HEAD"
        ).read_text(encoding="utf-8").strip().lower()
    except OSError:
        return None
    if _MANAGED_PLUGIN_COMMIT_RE.fullmatch(head):
        return head
    if not head.startswith("ref: "):
        return None
    ref = head[5:].strip()
    if not ref or ".." in ref or ref.startswith("/"):
        return None
    try:
        commit = (
            _MANAGED_PLUGIN_ROOT / ".git" / ref
        ).read_text(encoding="utf-8").strip().lower()
    except OSError:
        return None
    return commit if _MANAGED_PLUGIN_COMMIT_RE.fullmatch(commit) else None


def _managed_plugin_release() -> dict:
    current_commit = _current_managed_plugin_commit()
    query = urllib.parse.urlencode(
        {"currentCommit": current_commit}
        if current_commit
        else {}
    )
    path = _api_path("plugin_release")
    payload = _request_ai_ops(f"{path}?{query}" if query else path)
    if (
        not isinstance(payload, dict)
        or payload.get("channelVersion") != 1
        or payload.get("repository") != _MANAGED_PLUGIN_REPOSITORY
        or payload.get("policy") not in {"OFF", "NOTIFY", "AUTO"}
    ):
        raise RuntimeError("Managed plugin release is invalid")
    target_commit = payload.get("targetCommit")
    if target_commit is not None and (
        not isinstance(target_commit, str)
        or not _MANAGED_PLUGIN_COMMIT_RE.fullmatch(target_commit)
    ):
        raise RuntimeError("Managed plugin release commit is invalid")
    return {
        **payload,
        "currentCommit": current_commit,
        "updateAvailable": (
            target_commit is not None
            and current_commit != target_commit
        ),
        "applyAllowed": (
            payload.get("available") is True
            and target_commit is not None
            and current_commit != target_commit
        ),
    }


async def _install_managed_plugin(target_commit: str) -> None:
    if not _MANAGED_PLUGIN_COMMIT_RE.fullmatch(target_commit):
        raise RuntimeError("Managed plugin release commit is invalid")
    from hermes_cli.plugins_cmd import dashboard_install_plugin
    from hermes_cli.web_routers.dashboard_ui import (
        _plugin_action,
        _plugin_mutation,
    )

    result = await _plugin_mutation(
        lambda: _plugin_action(
            dashboard_install_plugin(
                _MANAGED_PLUGIN_REPOSITORY,
                force=True,
                enable=True,
                ref=target_commit,
                assume_deps_consent=True,
            ),
            "Managed plugin update failed.",
            rescan=True,
        )
    )
    if result.get("ok") is not True:
        raise RuntimeError("Managed plugin update failed")
    if _current_managed_plugin_commit() != target_commit:
        raise RuntimeError("Managed plugin update verification failed")


def _schedule_dashboard_restart() -> None:
    def restart() -> None:
        os.kill(os.getpid(), signal.SIGTERM)

    timer = threading.Timer(1.5, restart)
    timer.daemon = True
    timer.start()


async def _apply_managed_plugin_release(
    expected_commit: str | None = None,
) -> dict:
    async with _MANAGED_PLUGIN_UPDATE_LOCK:
        release = await asyncio.to_thread(_managed_plugin_release)
        target_commit = release.get("targetCommit")
        if (
            release.get("applyAllowed") is not True
            or not isinstance(target_commit, str)
            or (
                expected_commit is not None
                and target_commit != expected_commit
            )
        ):
            raise ManagedPluginReleaseUnavailableError(
                "Managed plugin release is no longer available"
            )
        await _install_managed_plugin(target_commit)
    _schedule_dashboard_restart()
    return {
        "ok": True,
        "installedCommit": target_commit,
        "releaseLabel": release.get("releaseLabel"),
        "restarting": True,
    }


async def _managed_plugin_watch_loop() -> None:
    await asyncio.sleep(15)
    while True:
        try:
            release = await asyncio.to_thread(_managed_plugin_release)
            if (
                release.get("automatic") is True
                and release.get("applyAllowed") is True
            ):
                await _apply_managed_plugin_release()
                return
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            raise
        except Exception:
            await asyncio.sleep(300)


@router.on_event("startup")
async def start_managed_plugin_watcher() -> None:
    global _MANAGED_PLUGIN_WATCH_TASK
    if (
        _MANAGED_PLUGIN_WATCH_TASK is None
        or _MANAGED_PLUGIN_WATCH_TASK.done()
    ):
        _MANAGED_PLUGIN_WATCH_TASK = asyncio.create_task(
            _managed_plugin_watch_loop(),
            name="oblist-managed-plugin-release",
        )


@router.on_event("shutdown")
async def stop_managed_plugin_watcher() -> None:
    global _MANAGED_PLUGIN_WATCH_TASK
    if _MANAGED_PLUGIN_WATCH_TASK is not None:
        task = _MANAGED_PLUGIN_WATCH_TASK
        task.cancel()
        _MANAGED_PLUGIN_WATCH_TASK = None
        try:
            await task
        except asyncio.CancelledError:
            pass


def _workflow_action_payload(
    body: dict,
    request: Request,
    operator: str,
) -> dict:
    expected_version = body.get("expectedVersion")
    if expected_version is not None and (
        isinstance(expected_version, bool)
        or not isinstance(expected_version, int)
        or expected_version < 1
    ):
        raise HTTPException(status_code=400, detail="Invalid workflow version")
    reservation_ref = body.get("reservationRef")
    if reservation_ref is not None and not isinstance(reservation_ref, str):
        raise HTTPException(status_code=400, detail="Invalid reservation")
    return {
        "actorRef": _actor_ref(request),
        **({"operatorRef": operator} if operator else {}),
        **(
            {"expectedWorkflowCycle": expected_version}
            if expected_version is not None
            else {}
        ),
        **(
            {"claimToken": reservation_ref[:300]}
            if reservation_ref
            else {}
        ),
    }


def _validated_id(action_id: str) -> str:
    if not _UUID_RE.fullmatch(action_id):
        raise HTTPException(status_code=400, detail="Invalid action card ID")
    return action_id


def _validated_operator(value: str) -> str:
    if value not in {"", "lyse", "philippine"}:
        raise HTTPException(status_code=400, detail="Invalid operator")
    return value


@router.get("/runtime")
async def get_runtime(request: Request):
    _require_oblist_operator(request)
    try:
        runtime = await asyncio.to_thread(_fetch_runtime)
    except Exception:
        runtime = _v1_runtime_fallback()
    return {
        **runtime,
        "checkedAt": int(time.time() * 1000),
    }


@router.get("/plugin-release")
async def get_plugin_release(request: Request):
    _require_oblist_operator(request)
    try:
        return await asyncio.to_thread(_managed_plugin_release)
    except Exception as error:
        raise HTTPException(
            status_code=503,
            detail="La vérification des mises à jour est indisponible.",
        ) from error


@router.post("/plugin-release/apply")
async def apply_plugin_release(body: dict, request: Request):
    _require_oblist_operator(request)
    expected_commit = body.get("expectedCommit")
    if (
        not isinstance(expected_commit, str)
        or not _MANAGED_PLUGIN_COMMIT_RE.fullmatch(expected_commit)
    ):
        raise HTTPException(status_code=400, detail="Invalid plugin release")
    if _MANAGED_PLUGIN_UPDATE_LOCK.locked():
        raise HTTPException(
            status_code=409,
            detail="Une mise à jour est déjà en cours.",
        )
    try:
        return await _apply_managed_plugin_release(expected_commit)
    except ManagedPluginReleaseUnavailableError as error:
        raise HTTPException(
            status_code=409,
            detail=(
                "Cette mise à jour n’est plus disponible. "
                "Actualisez Accueil CS."
            ),
        ) from error
    except RuntimeError as error:
        raise HTTPException(
            status_code=503,
            detail=(
                "La mise à jour n’a pas pu être installée. "
                "La version actuelle reste active."
            ),
        ) from error
    except Exception as error:
        raise HTTPException(
            status_code=503,
            detail=(
                "La mise à jour n’a pas pu être installée. "
                "La version actuelle reste active."
            ),
        ) from error


@router.get("/actions/{action_id}")
async def get_action(action_id: str, request: Request):
    _require_oblist_operator(request)
    action_id = _validated_id(action_id)
    return await asyncio.to_thread(
        _request_ai_ops,
        _api_path("action", action_id=action_id),
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
        f"{_api_path('overview')}?{query}",
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
            "leaseOwner": f"desktop:{operator or 'gary'}:{uuid.uuid4()}",
        }
    )
    result = await asyncio.to_thread(
        _request_ai_ops,
        f"{_api_path('notifications')}?{query}",
    )
    if isinstance(result, dict):
        result["operatorRef"] = operator or None
    return result


@router.get("/notification-inbox")
async def get_notification_inbox(request: Request):
    operator = _authorized_operator(
        request,
        request.query_params.get("operator", ""),
    )
    search = request.query_params.get("query", "").strip()[:200]
    view = request.query_params.get("view", "TO_PROCESS")
    if view not in {"TO_PROCESS", "WAITING", "RESOLVED", "ALL"}:
        view = "TO_PROCESS"
    priority = request.query_params.get("priority", "ALL")
    if priority not in {"ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW"}:
        priority = "ALL"
    source = request.query_params.get("source", "ALL")
    if source not in {"ALL", "INTERCOM", "AUTOMATIC"}:
        source = "ALL"
    sort = request.query_params.get("sort", "ACTION")
    if sort not in {"ACTION", "NEWEST", "OLDEST"}:
        sort = "ACTION"
    query = urllib.parse.urlencode(
        {
            **({"operatorRef": operator} if operator else {}),
            **({"query": search} if search else {}),
            "view": view,
            "priority": priority,
            "source": source,
            "sort": sort,
            "limit": "100",
        }
    )
    result = await asyncio.to_thread(
        _request_ai_ops,
        f"{_api_path('notification_inbox')}?{query}",
    )
    if isinstance(result, dict):
        result["operatorRef"] = operator or None
    return result


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
    delivery_token = body.get("deliveryToken")
    if not isinstance(delivery_token, str) or not _UUID_RE.fullmatch(
        delivery_token
    ):
        raise HTTPException(status_code=400, detail="Invalid delivery token")
    payload = {
        "outcome": outcome,
        "deliveryToken": delivery_token,
        **({"operatorRef": operator} if operator else {}),
    }
    if isinstance(body.get("errorCode"), str):
        payload["errorCode"] = body["errorCode"][:100]
    return await asyncio.to_thread(
        _request_ai_ops,
        _api_path(
            "notification_outcome",
            notification_id=notification_id,
        ),
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
        _api_path(
            "notification_read",
            notification_id=notification_id,
        ),
        "POST",
        payload,
    )


@router.post("/workflows/{workflow_id}/claim")
async def claim_workflow(workflow_id: str, body: dict, request: Request):
    workflow_id = _validated_id(workflow_id)
    operator = _authorized_operator(
        request,
        request.query_params.get("operator", ""),
    )
    workflow_payload = _workflow_action_payload(
        body,
        request,
        operator,
    )
    payload = {
        "operatorRef": operator,
        **(
            {
                "expectedWorkflowCycle": (
                    workflow_payload["expectedWorkflowCycle"]
                )
            }
            if "expectedWorkflowCycle" in workflow_payload
            else {}
        ),
    }
    await asyncio.to_thread(_require_live_runtime)
    return await asyncio.to_thread(
        _request_ai_ops,
        _api_path("workflow_claim", workflow_id=workflow_id),
        "POST",
        payload,
    )


@router.post("/workflows/{workflow_id}/release")
async def release_workflow_claim(
    workflow_id: str,
    body: dict,
    request: Request,
):
    workflow_id = _validated_id(workflow_id)
    operator = _authorized_operator(
        request,
        request.query_params.get("operator", ""),
    )
    workflow_payload = _workflow_action_payload(
        body,
        request,
        operator,
    )
    claim_token = workflow_payload.get("claimToken")
    if (
        not isinstance(claim_token, str)
        or not _UUID_RE.fullmatch(claim_token)
    ):
        raise HTTPException(status_code=400, detail="Invalid reservation")
    payload = {
        "operatorRef": operator,
        "claimToken": claim_token,
    }
    await asyncio.to_thread(_require_live_runtime)
    return await asyncio.to_thread(
        _request_ai_ops,
        _api_path("workflow_release", workflow_id=workflow_id),
        "POST",
        payload,
    )


@router.post("/workflows/{workflow_id}/confirm-assignment")
async def confirm_workflow_assignment(
    workflow_id: str,
    body: dict,
    request: Request,
):
    workflow_id = _validated_id(workflow_id)
    operator = _authorized_operator(
        request,
        request.query_params.get("operator", ""),
    )
    workflow_payload = _workflow_action_payload(
        body,
        request,
        operator,
    )
    claim_token = workflow_payload.get("claimToken")
    if (
        not isinstance(claim_token, str)
        or not _UUID_RE.fullmatch(claim_token)
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid reservation",
        )
    payload = {
        "operatorRef": operator,
        "actorRef": workflow_payload["actorRef"],
        "claimToken": claim_token,
    }
    await asyncio.to_thread(_require_live_runtime)
    return await asyncio.to_thread(
        _request_ai_ops,
        _api_path(
            "workflow_confirm_assignment",
            workflow_id=workflow_id,
        ),
        "POST",
        payload,
    )


@router.post("/workflows/{workflow_id}/closure")
async def decide_workflow_closure(
    workflow_id: str,
    body: dict,
    request: Request,
):
    workflow_id = _validated_id(workflow_id)
    operator = _authorized_operator(
        request,
        request.query_params.get("operator", ""),
    )
    decision = body.get("decision")
    if decision not in {"CLOSE", "CONTINUE"}:
        raise HTTPException(status_code=400, detail="Invalid closure decision")
    workflow_payload = _workflow_action_payload(
        body,
        request,
        operator,
    )
    payload = {
        "actorRef": workflow_payload["actorRef"],
        "expectedWorkflowCycle": workflow_payload.get(
            "expectedWorkflowCycle"
        ),
        "decision": decision,
    }
    if isinstance(body.get("outcome"), str):
        payload["outcome"] = body["outcome"][:4000]
    if isinstance(body.get("nextCheckAt"), str):
        payload["nextCheckAt"] = body["nextCheckAt"]
    await asyncio.to_thread(_require_live_runtime)
    return await asyncio.to_thread(
        _request_ai_ops,
        _api_path("workflow_closure", workflow_id=workflow_id),
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
    if isinstance(body.get("reason"), str):
        payload["reason"] = body["reason"][:500]
    return await asyncio.to_thread(
        _request_ai_ops,
        _api_path("action_edit", action_id=action_id),
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
        _api_path("action_decision", action_id=action_id),
        "POST",
        payload,
    )


@router.post("/actions/{action_id}/outcome")
async def record_action_outcome(
    action_id: str,
    body: dict,
    request: Request,
):
    _require_oblist_operator(request)
    action_id = _validated_id(action_id)
    payload = {
        "expectedVersion": body.get("expectedVersion"),
        "actorRef": _actor_ref(request),
        "episodeId": body.get("episodeId"),
        "outcome": body.get("outcome"),
        "attributable": body.get("attributable"),
    }
    for key in (
        "attributionAmbiguous",
        "precedentRevisionId",
        "reason",
    ):
        if key in body:
            payload[key] = body[key]
    return await asyncio.to_thread(
        _request_ai_ops,
        _api_path("action_outcome", action_id=action_id),
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
    if isinstance(body.get("breakGlass"), dict):
        if _session_email(request) not in _ADMIN_EMAILS:
            raise HTTPException(
                status_code=403,
                detail="Break-glass is restricted to Gary",
            )
        payload["breakGlass"] = body["breakGlass"]
    return await asyncio.to_thread(
        _request_ai_ops,
        _api_path("action_execute", action_id=action_id),
        "POST",
        payload,
    )
