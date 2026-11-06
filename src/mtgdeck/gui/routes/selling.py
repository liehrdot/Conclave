"""Routes of the sale list (``selling.py``, selling on Cardmarket)."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field

from ... import selling
from fastapi import APIRouter

router = APIRouter()

class SaleAdd(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=5000)  # collection entry ids
    qty: int | None = Field(default=None, ge=1, le=100000)  # only that many copies (one entry)
    condition: str = Field(default="NM", pattern=r"^(MT|NM|EX|GD|LP|PL|PO)$")


class SaleUpdate(BaseModel):
    qty: int | None = Field(default=None, ge=1, le=100000)
    condition: str | None = Field(default=None, pattern=r"^(MT|NM|EX|GD|LP|PL|PO)$")
    price: float | None = Field(default=None, ge=0.02, le=1_000_000)  # sent as null: back to the price rule
    comment: str | None = Field(default=None, max_length=selling.COMMENT_MAX)
    status: str | None = Field(default=None, pattern=r"^(open|listed)$")


class SaleRule(BaseModel):
    rule: str = Field(pattern=r"^(trend|trend95|trend90|low)$")


@router.get("/api/sales")
async def api_sales() -> dict[str, Any]:
    return await selling.view()


@router.post("/api/sales")
async def api_sales_add(req: SaleAdd) -> dict[str, Any]:
    """Put marked collection entries on the Verkaufsliste (prices from Cardmarket's price guide)."""
    return await selling.add(req.ids, qty=req.qty, condition=req.condition)


@router.put("/api/sales/rule")
async def api_sales_rule(req: SaleRule) -> dict[str, Any]:
    selling.set_rule(req.rule)
    return await selling.view()


@router.delete("/api/sales/sold")
async def api_sales_clear_sold() -> dict[str, int]:
    return {"deleted": selling.clear_sold()}


@router.patch("/api/sales/{item_id}")
async def api_sales_update(item_id: str, req: SaleUpdate) -> dict[str, Any]:
    try:
        return {"item": selling.update(item_id, **req.model_dump(exclude_unset=True))}
    except KeyError as exc:
        raise HTTPException(404, "Karte nicht auf der Verkaufsliste") from exc


@router.delete("/api/sales/{item_id}")
async def api_sales_remove(item_id: str) -> dict[str, int]:
    return {"deleted": selling.remove(item_id)}


@router.post("/api/sales/{item_id}/sold")
async def api_sales_sold(item_id: str) -> dict[str, Any]:
    """„Verkauft“: the copies leave the collection."""
    try:
        return selling.sold(item_id)
    except KeyError as exc:
        raise HTTPException(404, "Karte nicht auf der Verkaufsliste") from exc


@router.post("/api/sales/{item_id}/unsold")
async def api_sales_unsold(item_id: str) -> dict[str, Any]:
    try:
        return {"item": selling.unsold(item_id)}
    except KeyError as exc:
        raise HTTPException(404, "Karte nicht auf der Verkaufsliste") from exc
