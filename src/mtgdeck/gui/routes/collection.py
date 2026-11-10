"""Routes of the user's collection (``collection.py``)."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ... import collection, selling
from fastapi import APIRouter

router = APIRouter()

class CollectionItem(BaseModel):
    name: str | None = None
    qty: int = Field(default=1, ge=1, le=9999)
    proxy: bool = False
    foil: bool = False
    lang: str | None = None
    set: str | None = None
    collector_number: str | None = None
    scryfall_id: str | None = None
    printing: dict[str, Any] | None = None  # a printing from /api/cards/prints (artwork picker)


class CollectionAdd(BaseModel):
    items: list[CollectionItem]
    place: str = Field(default="", max_length=200)  # where the cards are: free text or a deck's name
    place_deck: str = Field(default="", max_length=100)  # that deck's slug


class CollectionImport(BaseModel):
    text: str = Field(max_length=5_000_000)
    proxy: bool = False
    replace: bool = False


class EntryUpdate(BaseModel):
    qty: int | None = None
    proxy: bool | None = None
    foil: bool | None = None
    lang: str | None = None
    note: str | None = None
    printing: dict[str, Any] | None = None
    place: str | None = Field(default=None, max_length=200)
    place_deck: str | None = Field(default=None, max_length=100)


class CollectionBulk(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=50000)
    place: str | None = Field(default=None, max_length=200)
    place_deck: str | None = Field(default=None, max_length=100)
    proxy: bool | None = None
    foil: bool | None = None
    lang: str | None = Field(default=None, pattern=r"^[a-z]{2,3}$")
    delete: bool = False
    qty: int | None = Field(default=None, ge=1, le=100000)  # only that many copies of each entry


@router.get("/api/collection")
async def api_collection() -> dict[str, Any]:
    entries = collection.load()
    usage = collection.decks_by_card() if entries else {}
    return {"entries": entries, "summary": collection.summary(entries), "places": collection.places(entries),
            "decks": {name: [d["name"] for d in decks] for name, decks in usage.items()},
            "deck_slugs": {name: [d["slug"] for d in decks] for name, decks in usage.items()}, "sales": selling.tags(entries)}  # fmt: skip


@router.get("/api/collection/cards")
async def api_collection_cards() -> dict[str, Any]:
    """Card facts for the collection's filters (colours, types, commander, mana value, roles, text)."""
    return await collection.card_facts()


@router.post("/api/collection/bulk")
async def api_collection_bulk(req: CollectionBulk) -> dict[str, int]:
    """Change or delete several marked entries at once (Ort, Proxy/Original, Foil, Sprache, Löschen)."""
    return {"changed": collection.bulk_update(req.ids, **req.model_dump(exclude={"ids"}))}


@router.post("/api/collection")
async def api_collection_add(req: CollectionAdd) -> dict[str, Any]:
    return await collection.add([i.model_dump() for i in req.items], place=req.place, place_deck=req.place_deck)


@router.post("/api/collection/import/preview")
async def api_collection_import_preview(req: CollectionImport) -> dict[str, Any]:
    return await collection.preview_text(req.text, proxy=req.proxy)


@router.post("/api/collection/import")
async def api_collection_import(req: CollectionImport) -> dict[str, Any]:
    return await collection.import_text(req.text, proxy=req.proxy, replace=req.replace)


@router.patch("/api/collection/{entry_id}")
async def api_collection_update(entry_id: str, req: EntryUpdate) -> dict[str, Any]:
    try:
        entry = collection.update(entry_id, **req.model_dump(exclude_unset=True))
    except KeyError as exc:
        raise HTTPException(404, "Eintrag nicht gefunden") from exc
    return {"entry": entry}


@router.delete("/api/collection/{entry_id}")
async def api_collection_delete(entry_id: str) -> dict[str, int]:
    return {"deleted": collection.delete(entry_id)}


@router.delete("/api/collection")
async def api_collection_clear(confirm: bool = False) -> dict[str, int]:
    if not confirm:
        raise HTTPException(400, "Zum Leeren der ganzen Sammlung confirm=true mitschicken.")
    return {"deleted": collection.delete()}


@router.get("/api/collection/export")
async def api_collection_export() -> Response:
    return Response(collection.to_csv(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="sammlung.csv"'})  # fmt: skip
