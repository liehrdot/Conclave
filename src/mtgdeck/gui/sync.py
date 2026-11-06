"""Syncing this PC with the own sync server (``sync/service.py``) from the GUI: the loop that syncs after a change,
on a timer and at start, the state the guard and backups read, and the ``/api/sync`` routes."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field

from .. import settings as settings_mod
from ..sync import service as sync_service
from . import desktop
from fastapi import APIRouter

log = logging.getLogger(__name__)
router = APIRouter()

SYNC_TICK = 5  # seconds between two looks at whether a sync is due
SYNC_DEBOUNCE = 15  # seconds of quiet after a local change before it is synced
PRESENCE_EVERY = 60  # "this PC is running" for the other devices
state: dict[str, Any] = {"dirty": 0.0, "running": False, "last_try": 0.0, "last_presence": 0.0, "online": None}
_lock: asyncio.Lock | None = None


def mark_dirty() -> None:
    state["dirty"] = time.time()


def _interval() -> int:
    try:
        return max(0, int(settings_mod.load().get("sync_interval") or 0))
    except (TypeError, ValueError):
        return 5


async def sync_now(reason: str) -> dict[str, Any]:
    """One sync at a time (a second caller waits and then syncs again); merged decks are checked afterwards."""
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    async with _lock:
        state["running"], state["last_try"] = True, time.time()
        try:
            entry = await asyncio.to_thread(sync_service.run, reason)
        finally:
            state["running"] = False
    if entry.get("ok"):
        state["online"] = True
        if sync_service.pending_revalidation():
            entry["revalidated"] = await sync_service.revalidate_pending()
        if entry.get("incoming"):
            more = entry.get("incoming_more") or 0
            desktop.notify("Neu von deinen anderen Geräten", ", ".join(entry["incoming"][:3]) + (f" … und {more} mehr" if more else ""))
    return entry


def _due(now: float) -> str | None:
    cfg = sync_service.config()
    minutes = _interval()
    if not cfg or cfg.get("revoked") or not minutes:
        return None
    last = state["last_try"]
    if not last:
        return "start"
    if state["dirty"] > last and now - state["dirty"] >= SYNC_DEBOUNCE:
        return "änderung"
    if now - last >= minutes * 60:
        return "intervall"
    return None


async def loop() -> None:
    """Background sync while the app runs: at the start, after local changes (debounced), every few minutes; plus a
    presence report every minute (the phone shows whether this PC is running)."""
    while True:
        await asyncio.sleep(SYNC_TICK)
        try:
            now = time.time()
            reason = _due(now)
            if reason:
                await sync_now(reason)
            cfg = sync_service.config()
            if cfg and not cfg.get("revoked") and now - state["last_presence"] >= PRESENCE_EVERY:
                state["last_presence"] = now
                info = {"app": "pc"}
                state["online"] = await asyncio.to_thread(sync_service.presence, info)
        except asyncio.CancelledError:
            raise
        except Exception:  # never let the loop die (a damaged file, a full disk …) – the status shows run errors
            log.exception("Sync-Schleife")


def view() -> dict[str, Any]:
    return {**sync_service.status(), "running": state["running"], "online": state["online"],
            "interval": _interval(), "pending_revalidation": sync_service.pending_revalidation()}


class SyncConnect(BaseModel):
    link: str = Field(default="", max_length=500)
    url: str = Field(default="", max_length=300)
    code: str = Field(default="", max_length=40)
    name: str = Field(default="", max_length=60)


@router.get("/api/sync")
async def api_sync() -> dict[str, Any]:
    return view()


@router.post("/api/sync/connect")
async def api_sync_connect(req: SyncConnect) -> dict[str, Any]:
    await asyncio.to_thread(sync_service.connect, req.link, url=req.url, code=req.code, name=req.name)
    state["last_presence"] = 0.0
    run = await sync_now("verbunden")
    return {**view(), "run": run}


@router.post("/api/sync/run")
async def api_sync_run() -> dict[str, Any]:
    if not sync_service.config():
        raise HTTPException(400, "Dieses Gerät ist mit keinem Sync-Server verbunden.")
    run = await sync_now("knopf")
    return {**view(), "run": run}


@router.post("/api/sync/disconnect")
async def api_sync_disconnect() -> dict[str, Any]:
    await asyncio.to_thread(sync_service.disconnect)
    state["online"] = None
    return view()


@router.get("/api/sync/devices")
async def api_sync_devices() -> dict[str, Any]:
    return {"devices": await asyncio.to_thread(sync_service.devices), "now": time.time()}


@router.delete("/api/sync/devices/{device_id}")
async def api_sync_revoke(device_id: str) -> dict[str, Any]:
    got = await asyncio.to_thread(sync_service.revoke, device_id)
    return {**got, **view()}


@router.post("/api/sync/pair")
async def api_sync_pair() -> dict[str, Any]:
    return await asyncio.to_thread(sync_service.pair_code)


@router.get("/api/sync/conflicts")
async def api_sync_conflicts() -> list[dict[str, Any]]:
    return sync_service.conflicts()


@router.delete("/api/sync/conflicts")
async def api_sync_conflicts_clear() -> dict[str, bool]:
    sync_service.clear_conflicts()
    return {"ok": True}
