"""Cardmarket's public price guide and product list (the official daily downloads, no API key).

Cardmarket publishes both files for every game on a public CDN; Magic is game 1. The price guide
is refreshed once a day and holds aggregates per product (one product = one printing): ``low``
(cheapest listing over all conditions and languages), ``trend`` and 1/7/30-day averages, each also
for foil. The product list maps a product to its English name and expansion id. Neither file has
set names or collector numbers; those come from Scryfall (``cardmarket_id`` on its card objects).

Live listings (seller X sells this copy right now) are not available without scraping the site,
which Cardmarket does not allow; the buy list is an estimate on the daily figures.
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any

from . import http

GUIDE_URL = "https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json"
PRODUCTS_URL = "https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_1.json"
GUIDE_TTL = 6 * 3600  # refreshed daily; check a few times a day
PRODUCTS_TTL = 3 * 24 * 3600  # changes only with new releases
PRODUCT_URL = "https://www.cardmarket.com/en/Magic/Products?idProduct={id}"
SEARCH_URL = "https://www.cardmarket.com/en/Magic/Products/Search?searchString={q}"
# the sell form's values: our language codes -> Cardmarket's language ids, conditions best first
LANGUAGES = {"en": 1, "fr": 2, "de": 3, "es": 4, "it": 5, "zhs": 6, "ja": 7, "pt": 8, "ru": 9, "ko": 10, "zht": 11}
CONDITIONS = {"MT": "Mint", "NM": "Near Mint", "EX": "Excellent", "GD": "Good", "LP": "Light Played", "PL": "Played", "PO": "Poor"}

_memo: dict[str, Any] = {}


def norm(name: str) -> str:
    """Cardmarket writes double-faced cards as „A / B“ and adventures/splits as „A // B“."""
    return " ".join(name.replace("//", "/").lower().split())


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def build_index(guide: Any, products: Any) -> dict[str, Any]:
    """Name (``norm``) -> the printings with prices. Defensive: unknown shapes give an empty index."""
    prices: dict[int, dict[str, float | None]] = {}
    for g in (guide or {}).get("priceGuides") or []:
        if not isinstance(g, dict) or "idProduct" not in g:
            continue
        prices[g["idProduct"]] = {
            "low": _num(g.get("low")), "trend": _num(g.get("trend")),
            "low_foil": _num(g.get("low-foil")), "trend_foil": _num(g.get("trend-foil")),
        }  # fmt: skip
    by_name: dict[str, list[dict[str, Any]]] = {}
    for p in (products or {}).get("products") or []:
        if not isinstance(p, dict) or not p.get("name") or p.get("idProduct") not in prices:
            continue
        pr = prices[p["idProduct"]]
        if not any(pr.values()):
            continue
        entry = {"id": p["idProduct"], "expansion": p.get("idExpansion"), **pr}
        key = norm(p["name"])
        by_name.setdefault(key, []).append(entry)
        if "/" in key:  # also findable by the front face
            by_name.setdefault(key.split("/")[0].strip(), []).append(entry)
    return {"date": _iso((guide or {}).get("createdAt")), "cards": by_name, "ids": prices}


def _iso(stamp: Any) -> str | None:
    """Cardmarket writes „2026-10-16T02:42:33+0200“; browsers want the offset with a colon."""
    try:
        return datetime.strptime(str(stamp), "%Y-%m-%dT%H:%M:%S%z").isoformat()
    except ValueError:
        return None


async def index() -> dict[str, Any]:
    """The price index, kept in memory for a while (the raw files sit in the HTTP disk cache)."""
    if _memo.get("index") and time.monotonic() - _memo.get("at", 0) < 3600:
        return _memo["index"]
    guide = await http.get_json(GUIDE_URL, ttl=GUIDE_TTL)
    products = await http.get_json(PRODUCTS_URL, ttl=PRODUCTS_TTL)
    idx = build_index(guide, products)
    _memo.update(index=idx, at=time.monotonic())
    return idx


def _price(p: dict[str, Any], kind: str) -> float | None:
    """Non-foil if listed, else foil (some printings only exist as foil)."""
    return p.get(kind) or p.get(f"{kind}_foil")


def product_price(idx: dict[str, Any], product_id: int | None, *, foil: bool = False) -> dict[str, float | None]:
    """``{trend, low}`` of one printing (foil figures for a foil, else the other kind when one is missing)."""
    p = (idx.get("ids") or {}).get(product_id) if product_id else None
    if not p:
        return {"trend": None, "low": None}
    a, b = ("_foil", "") if foil else ("", "_foil")
    return {k: p.get(k + a) or p.get(k + b) for k in ("trend", "low")}


def candidates(idx: dict[str, Any], name: str) -> list[dict[str, Any]]:
    """The card's printings, cheapest trend first (trend is the realistic price for a decent copy;
    ``low`` alone is often a damaged or foreign single copy). ``low`` is that printing's cheapest listing."""
    cards = idx.get("cards") or {}
    key = norm(name)
    out = []
    for p in cards.get(key) or cards.get(key.split("/")[0].strip()) or []:
        trend, low = _price(p, "trend"), _price(p, "low")
        if trend is None and low is None:
            continue
        out.append({"id": p["id"], "expansion": p.get("expansion"), "trend": trend if trend is not None else low, "low": low})
    out.sort(key=lambda p: (p["trend"], p["low"] or 0))
    return out
