"""The desktop shell's routes (Tauri): its long poll, update state, commands and the release feed. What is queued for
the shell lives in ``gui/desktop.py``."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

from ... import paths
from ... import settings as settings_mod
from ...http import HttpError
from .. import desktop, jobs, releases
from fastapi import APIRouter
from .. import sync as gui_sync

router = APIRouter()

class DesktopPoll(BaseModel):
    since: int = Field(0, ge=0)
    visible: bool = True
    autostart: bool | None = None
    version: str | None = None
    update: dict[str, Any] | None = None  # the shell's update state: state, rev, current, version, notes, progress, downloaded, total, speed, error, failed_step
    features: list[str] | None = None  # what this shell can do, e.g. "moxfield" (opens moxfield.com links in its own window)
    wait: float = Field(0, ge=0, le=60)  # long poll: hold the answer up to this many seconds until a notice or command comes up


class DesktopCommand(BaseModel):
    type: Literal["autostart", "open_data", "open_log", "check_update", "install_update", "install_version"]
    value: bool | str | None = None  # install_version: the version to go to (also an older one)


def _ago(ts: Any) -> str:
    from datetime import datetime

    try:
        t = float(ts) if isinstance(ts, (int, float)) else datetime.fromisoformat(str(ts)).timestamp()
    except (TypeError, ValueError):
        return "zuletzt unbekannt"
    s = max(0, int(time.time() - t))
    if s < 90:
        return "gerade eben"
    if s < 3600:
        return f"vor {s // 60} Min."
    if s < 86400:
        return f"vor {s // 3600} Std."
    return f"vor {s // 86400} Tagen"


def _desktop_tooltip() -> str:
    """What the tray icon shows on hover: the app's name and the state that matters."""
    lines = [paths.APP_NAME]
    running = sum(1 for j in jobs.JOBS.values() if not j.done)
    if running:
        lines.append("Ein Auftrag läuft" if running == 1 else f"{running} Aufträge laufen")
    sv = gui_sync.view()
    if sv.get("connected"):
        if sv.get("revoked"):
            lines.append("Sync: Gerät am Server abgemeldet")
        elif sv.get("running"):
            lines.append("Sync: läuft …")
        elif sv.get("online") is False:
            lines.append("Sync: Server nicht erreichbar")
        elif sv.get("last_ok"):
            lines.append(f"Sync: {_ago(sv['last_ok'])}")
        else:
            lines.append("Sync: noch kein Abgleich")
    return "\n".join(lines)


@router.get("/api/desktop")
async def api_desktop() -> dict[str, Any]:
    cfg = settings_mod.load()
    return {"shell": desktop.shell(), "notify": bool(cfg.get("desktop_notify", True)), "preview": bool(cfg.get("desktop_preview", False))}


@router.post("/api/desktop/poll")
async def api_desktop_poll(req: DesktopPoll) -> dict[str, Any]:
    info = req.model_dump(exclude_none=True)
    if req.wait > 0:
        answer = await asyncio.to_thread(desktop.poll, info, req.since, req.wait)
    else:
        answer = desktop.poll(info, req.since)
    return {**answer, "tooltip": _desktop_tooltip()}


@router.post("/api/desktop/update")
async def api_desktop_update(update: dict[str, Any]) -> dict[str, Any]:
    """The shell's update state while it downloads and installs (pushed a few times a second)."""
    desktop.report_update(update)
    return {"ok": True}


@router.post("/api/desktop/command")
async def api_desktop_command(req: DesktopCommand) -> dict[str, Any]:
    if not desktop.present():
        raise HTTPException(409, "Die Desktop-App läuft gerade nicht – diese Einstellung gibt es nur dort.")
    if req.type == "install_version" and not isinstance(req.value, str):
        raise HTTPException(422, "Welche Version? Sie fehlt.")
    return desktop.command(req.type, req.value)


@router.get("/api/desktop/releases")
async def api_desktop_releases() -> dict[str, Any]:
    """The versions the settings page offers to install (also older ones); previews only with the setting on."""
    preview = bool(settings_mod.load().get("desktop_preview", False))
    return {"preview": preview, "releases": await releases.available(preview)}


@router.get("/api/desktop/feed")
async def api_desktop_feed(version: str | None = None) -> dict[str, Any]:
    """For the shell: which latest.json to check (stable, the newest preview, or one picked version)."""
    try:
        return await asyncio.wait_for(releases.feed(version), 4)  # the shell waits 5 s for an answer
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except (HttpError, asyncio.TimeoutError) as e:
        if version:
            raise HTTPException(502, getattr(e, "friendly", "GitHub antwortet gerade nicht.")) from e
        return {"feed": releases.STABLE_FEED, "preview": False}  # offline: the stable check fails on its own
