"""Routes of the backups (``backup.py``) and the deck trash (``storage.delete`` and the rest of it)."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse

from ... import backup, storage
from fastapi import APIRouter
from .. import jobs
from .. import sync as gui_sync

router = APIRouter()

@router.get("/api/backups")
async def api_backups() -> dict[str, Any]:
    return {"backups": backup.backups(), "dir": str(backup.BACKUP_DIR), "keep_auto": backup.KEEP_AUTO}


@router.post("/api/backups")
async def api_backup_create() -> dict[str, Any]:
    return backup.create("manuell")


@router.get("/api/backups/{name}")
async def api_backup_download(name: str) -> FileResponse:
    path = backup.path_of(name)
    return FileResponse(path, media_type="application/zip", filename=f"mtgdeck-{name}")


@router.post("/api/backups/upload")
async def api_backup_upload(request: Request) -> dict[str, Any]:
    data = await request.body()
    if len(data) > 2_000_000_000:
        raise HTTPException(413, "Datei zu groß")
    return backup.upload(data)


@router.post("/api/backups/{name}/restore")
async def api_backup_restore(name: str) -> dict[str, Any]:
    if any(not j.done for j in jobs.JOBS.values()):
        raise HTTPException(409, "Es läuft gerade ein Auftrag – warte, bis er fertig ist, und stell dann wieder her.")
    if gui_sync.state["running"]:
        raise HTTPException(409, "Gerade läuft der Abgleich mit dem Sync-Server – bitte gleich noch einmal versuchen.")
    return backup.restore(name)


@router.get("/api/trash")
async def api_trash() -> list[dict[str, Any]]:
    return storage.trash()


@router.post("/api/trash/{trash_id}/restore")
async def api_trash_restore(trash_id: str) -> dict[str, Any]:
    return storage.restore_deleted(trash_id)


@router.delete("/api/trash/{trash_id}")
async def api_trash_purge(trash_id: str) -> dict[str, int]:
    return {"deleted": storage.purge_deleted(trash_id)}


@router.delete("/api/trash")
async def api_trash_purge_all() -> dict[str, int]:
    return {"deleted": storage.purge_deleted()}
