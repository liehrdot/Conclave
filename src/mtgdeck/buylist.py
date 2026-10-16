"""Einkaufsliste: what it costs to own a deck for real, at the cheapest printing of every card.

``build(deck)`` takes the deck's cards minus the real copies in the collection (proxies count as
missing unless ``replace_proxies=False``; basic lands are left out) and prices each card with
Cardmarket's daily price guide (``cardmarket.py``): the playable printing with the lowest trend and
its cheapest listing as ``low``. Set names and the playable check (no oversized, gold-bordered or
memorabilia printings) come from the local card DB, else Scryfall.
Without the price guide (offline, Cardmarket down) Scryfall's cheapest EUR price is the fallback.

The list text is plain "N Name" so it can go into a Cardmarket Wants list, whose Shopping Wizard
then finds the cheapest sellers including shipping – the figures here are only the estimate.
"""

from __future__ import annotations

from collections import Counter
from typing import Any
from urllib.parse import quote_plus

from . import cardmarket, carddb, collection, scryfall
from .cards import resolve
from .http import HttpError

LIVE_SET_LOOKUPS = 60  # Scryfall lookups for printings the local DB lacks (100 ms each)


def _need(deck: dict[str, Any]) -> Counter:
    need = Counter({c: 1 for c in deck.get("commanders", [])})
    for c in deck.get("cards", []):
        need[c["name"]] += int(c.get("qty", 1))
    return need


async def _pick(prints: list[dict[str, Any]], known: dict[int, dict[str, Any]], budget: list[int]) -> dict[str, Any] | None:
    """The cheapest printing you can play with: oversized, gold-bordered and memorabilia printings
    are skipped. A printing neither the local DB nor Scryfall knows is only used if nothing better is found."""
    unknown = None
    for tries, p in enumerate(prints):
        info = known.get(p["id"])
        if info is None and budget[0] > 0 and tries < 4:
            budget[0] -= 1
            try:
                card = await scryfall.by_cardmarket_id(p["id"])
            except HttpError:
                card = None
            if card:
                info = {"set": card.get("set"), "set_name": card.get("set_name"),
                        "collector_number": card.get("collector_number"), "playable": carddb.playable(card)}  # fmt: skip
                known[p["id"]] = info
        if info is None:
            unknown = unknown or p
            if budget[0] <= 0 or tries >= 4:
                break
            continue
        if info.get("playable", True):
            return {**p, **{k: v for k, v in info.items() if k != "playable"}}
    return unknown


async def build(deck: dict[str, Any], *, replace_proxies: bool = True) -> dict[str, Any]:
    need = _need(deck)
    owned = collection.owned_counts()
    rows = []
    for name, n in need.items():
        if name in collection.BASIC_LANDS:
            continue
        o = owned.get(name, {"real": 0, "proxy": 0})
        have = o["real"] + (0 if replace_proxies else o["proxy"])
        buy = max(n - have, 0)
        if buy:
            rows.append({"name": name, "qty": buy, "need": n, "real": min(o["real"], n), "proxy": min(o["proxy"], n)})

    error = None
    try:
        idx = await cardmarket.index()
    except HttpError as exc:
        idx, error = {}, exc.friendly
    if idx and not idx.get("cards"):
        error = "Die Preisliste von Cardmarket hatte ein unbekanntes Format."
    prints = {r["name"]: cardmarket.candidates(idx, r["name"]) if idx else [] for r in rows}
    try:
        known: dict[int, dict[str, Any]] = carddb.cardmarket_prints(sorted({p["id"] for ps in prints.values() for p in ps}))
    except Exception:  # an old or damaged DB only costs the set names
        known = {}
    budget = [LIVE_SET_LOOKUPS]
    picks = {}
    for name, ps in prints.items():
        picks[name] = await _pick(ps, known, budget) if ps else None

    fallback: dict[str, dict[str, Any]] = {}
    if any(p is None for p in picks.values()):
        try:
            fallback, _, _ = await resolve([n for n, p in picks.items() if p is None])
        except Exception:
            fallback = {}

    for r in rows:
        p = picks[r["name"]]
        r["search_url"] = cardmarket.SEARCH_URL.format(q=quote_plus(r["name"].split(" // ")[0]))
        if p:
            r.update(source="cardmarket", trend=p["trend"], low=p["low"], url=cardmarket.PRODUCT_URL.format(id=p["id"]),
                     set=p.get("set"), set_name=p.get("set_name"), collector_number=p.get("collector_number"))  # fmt: skip
        else:
            price = (fallback.get(r["name"]) or {}).get("price_eur")
            r.update(source="scryfall" if price else None, trend=float(price) if price else None, low=None, url=None)
        r["total_trend"] = round(r["trend"] * r["qty"], 2) if r["trend"] else None
        r["total_low"] = round((r["low"] or r["trend"] or 0) * r["qty"], 2) if r["trend"] or r["low"] else None
    rows.sort(key=lambda r: (-(r["trend"] or 0), r["name"]))
    return {
        "slug": deck.get("slug"),
        "name": deck.get("name"),
        "currency": "eur",
        "replace_proxies": replace_proxies,
        "collection_size": len(collection.load()),
        "items": rows,
        "cards": sum(r["qty"] for r in rows),
        "total_trend": round(sum(r["total_trend"] or 0 for r in rows), 2),
        "total_low": round(sum(r["total_low"] or 0 for r in rows), 2),
        "unpriced": [r["name"] for r in rows if not r["trend"]],
        "price_date": (idx or {}).get("date"),
        "error": error,
    }
