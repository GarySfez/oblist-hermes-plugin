"""Authenticated proxy for The Oblist inline action cards."""

import asyncio
from contextvars import ContextVar
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
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
_VISION_PAYLOAD_REF_RE = re.compile(
    r"^vision-ui:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_VISION_STABLE_REF_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,499}$"
)
_VISION_HOST_PROFILES = {"default", "global", "lyse", "philippine"}
_VISION_ATTACHMENT_REF_LIMIT = 12
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
_PLUGIN_VERSION = "0.5.0"
_RELEASE_EPOCH = "hermes-intelligence-v2"
_MANAGED_PLUGIN_REPOSITORY = "GarySfez/oblist-hermes-plugin"
_MANAGED_PLUGIN_NAME = "oblist-action-cards"
_MANAGED_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
_MANAGED_PLUGIN_PROFILE_NAMES = ("global", "lyse", "philippine")
_MANAGED_PLUGIN_COMMIT_RE = re.compile(r"^[a-f0-9]{40}$")
_MANAGED_PLUGIN_REVISION_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_MANAGED_PLUGIN_UPDATE_LOCK = asyncio.Lock()
_MANAGED_PLUGIN_WATCH_TASK: asyncio.Task | None = None
_REQUEST_OPERATOR_SCOPE: ContextVar[str] = ContextVar(
    "oblist_operator_scope",
    default="global",
)
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
    "vision_payload": "/v1/vision-payloads/{payload_ref}",
    "attachment_links": "/v1/attachments/links",
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
        _REQUEST_OPERATOR_SCOPE.set(requested or "global")
        return requested
    operator = _OPERATOR_BY_EMAIL.get(email)
    if not operator:
        raise HTTPException(status_code=403, detail="Operator access denied")
    if requested and requested != operator:
        raise HTTPException(status_code=403, detail="Cross-profile access denied")
    _REQUEST_OPERATOR_SCOPE.set(operator)
    return operator


def _require_oblist_operator(request: Request) -> str:
    email = _session_email(request)
    if email not in _ADMIN_EMAILS and email not in _OPERATOR_BY_EMAIL:
        raise HTTPException(status_code=403, detail="Operator access denied")
    operator = (
        "global"
        if email in _ADMIN_EMAILS
        else _OPERATOR_BY_EMAIL[email]
    )
    _REQUEST_OPERATOR_SCOPE.set(operator)
    return operator


def _profile_action_token(operator: str) -> str:
    if operator in {"lyse", "philippine"}:
        explicit = os.environ.get(
            f"OBLIST_{operator.upper()}_ACTION_CARD_TOKEN",
            "",
        ).strip()
        if explicit:
            return explicit
        home_root = _MANAGED_PLUGIN_ROOT.parent.parent
        profiles_root = (
            home_root.parent
            if home_root.name in _MANAGED_PLUGIN_PROFILE_NAMES
            and home_root.parent.name == "profiles"
            else home_root / "profiles"
        )
        profile_env = profiles_root / operator / ".env"
        if profile_env.is_file():
            for raw_line in profile_env.read_text(
                encoding="utf-8",
            ).splitlines():
                key, separator, value = raw_line.partition("=")
                if (
                    separator
                    and key.strip() == "OBLIST_ACTION_MCP_TOKEN"
                    and value.strip()
                ):
                    return value.strip()
        raise RuntimeError(
            f"No scoped action-card token is configured for {operator}"
        )
    return (
        os.environ.get("OBLIST_ACTION_CARD_REVIEW_TOKEN", "")
        or os.environ.get("MCP_OBLIST_ACTIONS_API_KEY", "")
    ).strip()


def _request_ai_ops(path: str, method: str = "GET", body: dict | None = None) -> dict:
    base_url = os.environ.get(
        "OBLIST_MEMORY_API_URL",
        "https://ai-ops-memory-api-production.up.railway.app",
    ).rstrip("/")
    token = _profile_action_token(_REQUEST_OPERATOR_SCOPE.get())
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


def _managed_plugin_homes() -> tuple[Path, ...]:
    configured_home = Path(
        os.environ.get(
            "HERMES_HOME",
            str(_MANAGED_PLUGIN_ROOT.parent.parent),
        )
    ).expanduser().resolve()
    candidates = [
        configured_home,
        *[
            configured_home / "profiles" / profile
            for profile in _MANAGED_PLUGIN_PROFILE_NAMES
        ],
        _MANAGED_PLUGIN_ROOT.parent.parent.resolve(),
    ]
    homes: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        home = candidate.resolve()
        plugin_root = home / "plugins" / _MANAGED_PLUGIN_NAME
        if home in seen or not plugin_root.is_dir():
            continue
        seen.add(home)
        homes.append(home)
    return tuple(homes)


def _managed_plugin_home_label(home: Path) -> str:
    configured_home = Path(
        os.environ.get(
            "HERMES_HOME",
            str(_MANAGED_PLUGIN_ROOT.parent.parent),
        )
    ).expanduser().resolve()
    if home == configured_home:
        return "default"
    try:
        relative = home.relative_to(configured_home / "profiles")
    except ValueError:
        return home.name
    return relative.parts[0] if len(relative.parts) == 1 else home.name


def _managed_plugin_root(home: Path) -> Path:
    return home / "plugins" / _MANAGED_PLUGIN_NAME


def _managed_git_config_path() -> Path:
    configured_home = Path(
        os.environ.get(
            "HERMES_HOME",
            str(_MANAGED_PLUGIN_ROOT.parent.parent),
        )
    ).expanduser().resolve()
    return configured_home / ".oblist-managed-gitconfig"


def _ensure_managed_git_safe_directories(homes: tuple[Path, ...]) -> Path:
    config_path = _managed_git_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    safe_directories = [
        str(_managed_plugin_root(home).resolve())
        for home in homes
    ]
    payload = "[safe]\n" + "".join(
        f"\tdirectory = {directory}\n"
        for directory in safe_directories
    )
    temporary = config_path.with_suffix(".tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(config_path)
    return config_path


def _managed_plugin_commit_at(plugin_root: Path) -> str | None:
    try:
        head = (
            plugin_root / ".git" / "HEAD"
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
            plugin_root / ".git" / ref
        ).read_text(encoding="utf-8").strip().lower()
    except OSError:
        return None
    return commit if _MANAGED_PLUGIN_COMMIT_RE.fullmatch(commit) else None


def _managed_plugin_commits() -> dict[str, str | None]:
    return {
        _managed_plugin_home_label(home): _managed_plugin_commit_at(
            _managed_plugin_root(home)
        )
        for home in _managed_plugin_homes()
    }


def _current_managed_plugin_commit() -> str | None:
    commits = tuple(_managed_plugin_commits().values())
    if (
        not commits
        or commits[0] is None
        or any(commit != commits[0] for commit in commits[1:])
    ):
        return None
    return commits[0]


def _managed_plugin_release(current_revision: str | None = None) -> dict:
    current_commit = _current_managed_plugin_commit()
    query_values: dict[str, str] = {}
    if current_commit:
        query_values["currentCommit"] = current_commit
    if (
        isinstance(current_revision, str)
        and _MANAGED_PLUGIN_REVISION_RE.fullmatch(current_revision)
    ):
        query_values["currentRevision"] = current_revision
    query = urllib.parse.urlencode(query_values)
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
        "installedCommits": _managed_plugin_commits(),
        "currentRevision": current_revision,
        "updateAvailable": (
            payload.get("updateAvailable") is True
        ),
        "applyAllowed": (
            payload.get("available") is True
            and target_commit is not None
            and payload.get("applyAllowed") is True
        ),
    }


def _hermes_cli() -> str:
    sibling = Path(sys.executable).with_name("hermes")
    if sibling.is_file():
        return str(sibling)
    executable = shutil.which("hermes")
    if not executable:
        raise RuntimeError("Hermes CLI is unavailable")
    return executable


def _run_managed_plugin_install(home: Path, target_commit: str) -> None:
    try:
        result = subprocess.run(
            [
                _hermes_cli(),
                "plugins",
                "install",
                _MANAGED_PLUGIN_REPOSITORY,
                "--ref",
                target_commit,
                "--force",
                "--yes-deps",
                "--enable",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(home),
            env={
                **os.environ,
                "HERMES_HOME": str(home),
                "GIT_CONFIG_GLOBAL": str(_managed_git_config_path()),
            },
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Managed plugin update timed out") from error
    except OSError as error:
        raise RuntimeError("Managed plugin update could not start") from error
    if result.returncode != 0:
        raise RuntimeError("Managed plugin update failed")
    if (
        _managed_plugin_commit_at(_managed_plugin_root(home))
        != target_commit
    ):
        raise RuntimeError("Managed plugin update verification failed")


def _install_managed_plugin(target_commit: str) -> list[str]:
    if not _MANAGED_PLUGIN_COMMIT_RE.fullmatch(target_commit):
        raise RuntimeError("Managed plugin release commit is invalid")
    homes = _managed_plugin_homes()
    if not homes:
        raise RuntimeError("Managed plugin installation is unavailable")
    _ensure_managed_git_safe_directories(homes)
    installed_commits = _managed_plugin_commits()
    if (
        len(installed_commits) == len(homes)
        and all(
            commit == target_commit
            for commit in installed_commits.values()
        )
    ):
        return list(installed_commits)
    previous_commits = {
        home: _managed_plugin_commit_at(_managed_plugin_root(home))
        for home in homes
    }
    updated: list[Path] = []
    try:
        for home in homes:
            updated.append(home)
            _run_managed_plugin_install(home, target_commit)
    except Exception as install_error:
        rollback_failed = False
        for home in reversed(updated):
            previous_commit = previous_commits.get(home)
            if not previous_commit:
                rollback_failed = True
                continue
            try:
                _run_managed_plugin_install(home, previous_commit)
            except Exception:
                rollback_failed = True
        if rollback_failed:
            raise RuntimeError(
                "Managed plugin update failed and rollback was incomplete"
            ) from install_error
        raise RuntimeError(
            "Managed plugin update failed and was rolled back"
        ) from install_error
    installed_commits = _managed_plugin_commits()
    if (
        len(installed_commits) != len(homes)
        or any(
            commit != target_commit
            for commit in installed_commits.values()
        )
    ):
        raise RuntimeError("Managed plugin profiles are not aligned")
    return list(installed_commits)


async def _apply_managed_plugin_release(
    expected_commit: str | None = None,
    current_revision: str | None = None,
) -> dict:
    async with _MANAGED_PLUGIN_UPDATE_LOCK:
        release = await asyncio.to_thread(
            _managed_plugin_release,
            current_revision,
        )
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
        installed_profiles = await asyncio.to_thread(
            _install_managed_plugin,
            target_commit,
        )
    return {
        "ok": True,
        "installedCommit": target_commit,
        "installedProfiles": installed_profiles,
        "releaseLabel": release.get("releaseLabel"),
        "reloaded": False,
        "restarting": False,
        "desktopInstallRequired": True,
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


def _validated_vision_ref(
    value: object,
    field_name: str,
    pattern: re.Pattern,
) -> str:
    if (
        not isinstance(value, str)
        or value != value.strip()
        or ".." in value
        or value.lower().startswith(
            ("http:", "https:", "data:", "file:", "javascript:")
        )
        or not pattern.fullmatch(value)
    ):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {field_name}",
        )
    return value


def _validated_vision_query(request: Request) -> str:
    query = request.query_params
    keys = set(query.keys())
    if (
        "caseRef" not in keys
        or not keys.issubset({"caseRef", "profile"})
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid vision payload query",
        )
    getlist = getattr(query, "getlist", None)
    if callable(getlist) and any(
        len(getlist(key)) != 1 for key in keys
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid vision payload query",
        )
    profile = query.get("profile")
    if (
        profile is not None
        and profile not in _VISION_HOST_PROFILES
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid vision payload query",
        )
    return _validated_vision_ref(
        query.get("caseRef"),
        "case reference",
        _VISION_STABLE_REF_RE,
    )


def _validated_attachment_link_request(body: object) -> dict:
    if not isinstance(body, dict) or set(body) != {
        "payloadRef",
        "caseRef",
        "attachmentRefs",
    }:
        raise HTTPException(
            status_code=400,
            detail="Invalid attachment link request",
        )
    payload_ref = _validated_vision_ref(
        body.get("payloadRef"),
        "vision payload reference",
        _VISION_PAYLOAD_REF_RE,
    )
    case_ref = _validated_vision_ref(
        body.get("caseRef"),
        "case reference",
        _VISION_STABLE_REF_RE,
    )
    attachment_refs = body.get("attachmentRefs")
    if (
        not isinstance(attachment_refs, list)
        or not 1 <= len(attachment_refs) <= _VISION_ATTACHMENT_REF_LIMIT
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid attachment references",
        )
    validated_refs = [
        _validated_vision_ref(
            attachment_ref,
            "attachment reference",
            _VISION_STABLE_REF_RE,
        )
        for attachment_ref in attachment_refs
    ]
    if len(set(validated_refs)) != len(validated_refs):
        raise HTTPException(
            status_code=400,
            detail="Duplicate attachment references",
        )
    return {
        "payloadRef": payload_ref,
        "caseRef": case_ref,
        "attachmentRefs": validated_refs,
    }


async def _request_vision_ai_ops(
    path: str,
    method: str = "GET",
    body: dict | None = None,
) -> dict:
    try:
        return await asyncio.to_thread(
            _request_ai_ops,
            path,
            method,
            body,
        )
    except HTTPException as error:
        if error.status_code == 400:
            detail = "Invalid visual context request"
        elif error.status_code == 404:
            detail = "Visual context not found or expired"
        elif error.status_code == 429:
            detail = "Visual context temporarily unavailable"
        else:
            raise HTTPException(
                status_code=502,
                detail="Visual context service unavailable",
            ) from error
        raise HTTPException(
            status_code=error.status_code,
            detail=detail,
        ) from error
    except Exception as error:
        raise HTTPException(
            status_code=503,
            detail="Visual context service unavailable",
        ) from error


@router.get("/v1/vision-payloads/{payload_ref}")
async def get_vision_payload(
    payload_ref: str,
    request: Request,
):
    _require_oblist_operator(request)
    payload_ref = _validated_vision_ref(
        payload_ref,
        "vision payload reference",
        _VISION_PAYLOAD_REF_RE,
    )
    case_ref = _validated_vision_query(request)
    encoded_payload_ref = urllib.parse.quote(payload_ref, safe="")
    query = urllib.parse.urlencode({"caseRef": case_ref})
    return await _request_vision_ai_ops(
        f"{_api_path('vision_payload', payload_ref=encoded_payload_ref)}"
        f"?{query}"
    )


@router.post("/v1/attachments/links")
async def refresh_attachment_links(
    body: dict,
    request: Request,
):
    _require_oblist_operator(request)
    payload = _validated_attachment_link_request(body)
    return await _request_vision_ai_ops(
        _api_path("attachment_links"),
        "POST",
        payload,
    )


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
    current_revision = request.query_params.get("currentRevision")
    if current_revision is not None and not _MANAGED_PLUGIN_REVISION_RE.fullmatch(
        current_revision
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid plugin revision",
        )
    try:
        return await asyncio.to_thread(
            _managed_plugin_release,
            current_revision,
        )
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
    current_revision = body.get("currentRevision")
    if (
        current_revision is not None
        and (
            not isinstance(current_revision, str)
            or not _MANAGED_PLUGIN_REVISION_RE.fullmatch(current_revision)
        )
    ):
        raise HTTPException(status_code=400, detail="Invalid plugin revision")
    if _MANAGED_PLUGIN_UPDATE_LOCK.locked():
        raise HTTPException(
            status_code=409,
            detail="Une mise à jour est déjà en cours.",
        )
    try:
        return await _apply_managed_plugin_release(
            expected_commit,
            current_revision,
        )
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
