"""Card search by description: the paired sync server asks Claude (``sync/cardsearch.py``), Scryfall answers here."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field

from ... import scryfall
from ...http import HttpError
from ...sync import service as sync_service
from ...sync.remote import RemoteError
from fastapi import APIRouter

router = APIRouter()

class DescribeIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    colors: list[str] = Field(default_factory=list, max_length=6)
    types: list[str] = Field(default_factory=list, max_length=8)


class AiSetupIn(BaseModel):
    key: str | None = Field(default=None, max_length=400)
    model: str | None = Field(default=None, max_length=100)


_NOT_PAIRED = "Die Suche mit KI läuft über deinen Sync-Server – verbinde ihn zuerst unter Einstellungen → Sync."


async def _ai_call(fn: Callable[..., Any], *args: Any) -> Any:
    try:
        return await asyncio.to_thread(fn, *args)
    except ValueError:
        raise HTTPException(409, _NOT_PAIRED) from None
    except RemoteError as exc:
        if exc.status == 404:
            raise HTTPException(502, "Dein Sync-Server kennt die Suche mit KI noch nicht – er holt sich das Update von selbst.") from None
        raise HTTPException(exc.status if exc.status in (400, 402, 409, 429, 503, 504) else 502, str(exc)) from None


async def _query_page(q: str, page: int) -> dict[str, Any]:
    try:
        got = await scryfall.search_page(q, page=page, order="edhrec", unique="cards")
    except HttpError as exc:
        if exc.status == 400:
            raise HTTPException(400, "Scryfall versteht diese Suche nicht – Suche anpassen oder anders beschreiben.") from None
        raise
    cards = [{k: c.get(k) for k in ("name", "type_line", "mana_cost", "image", "price_eur", "price_usd")}
             for c in (scryfall.compact(raw, with_text=False) for raw in got["cards"])]  # fmt: skip
    return {"total": got["total"], "cards": cards, "has_more": got["has_more"]}


@router.post("/api/cards/describe")
async def api_cards_describe(req: DescribeIn) -> dict[str, Any]:
    """A description → Scryfall query (via the sync server) → the first result page; the broader query if none."""
    found = await _ai_call(sync_service.describe_cards, req.text, req.colors, req.types)
    used = found.get("query") or ""
    result = await _query_page(used, 1) if used else {"total": 0, "cards": [], "has_more": False}
    if not result["cards"] and found.get("broader"):
        used = found["broader"]
        result = await _query_page(used, 1)
    return {**found, "used": used, **result}


@router.get("/api/cards/query")
async def api_cards_query(q: str, page: int = 1) -> dict[str, Any]:
    """One page of a Scryfall query (an edited query, or "more")."""
    q = " ".join(q.split())[:500]
    if not q:
        raise HTTPException(400, "Die Suche ist leer.")
    return await _query_page(q, max(1, page))


@router.get("/api/cards/describe/setup")
async def api_ai_setup_get() -> dict[str, Any]:
    return await _ai_call(sync_service.ai)


@router.put("/api/cards/describe/setup")
async def api_ai_setup_put(req: AiSetupIn) -> dict[str, Any]:
    return await _ai_call(sync_service.ai, req.model_dump(exclude_none=True))
