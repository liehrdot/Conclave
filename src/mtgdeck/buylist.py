"""Einkaufsliste: what it costs to own a deck for real, at the cheapest printing of every card.

``build(deck)`` takes the deck's cards minus the real copies in the collection that no other deck
uses (proxies count as missing unless ``replace_proxies=False``; ``use_collection=False`` lists the
whole deck; basic lands are left out) and prices each card with
Cardmarket's daily price guide (``cardmarket.py``): the playable printing with the lowest trend and
its cheapest listing as ``low``. Set names and the playable check (no oversized, gold-bordered or
memorabilia printings) come from the local card DB, else Scryfall.
Without the price guide (offline, Cardmarket down) Scryfall's cheapest EUR price is the fallback.
Each row also says where copies already are (``places``: per collection place or deck), so the dialog
can compare the list with „Bulk“, a binder or other decks. A deck that only lists a card you have no copy of
(``decks[].planned``) does not hold it: the dialog shows it as „nur geplant“ and keeps it under „An keinem davon“.

The list text is plain "N Name" so it can go into a Cardmarket Wants list, whose Shopping Wizard
then finds the cheapest sellers including shipping – the figures here are only the estimate.
"""

from __future__ import annotations

from collections import Counter
from typing import Any
from urllib.parse import quote_plus

from . import cardmarket, carddb, collection, scryfall, storage
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


def _other_decks(usage: dict[str, list[dict[str, Any]]], slug: str | None) -> list[dict[str, Any]]:
    """Every other deck (slug, name) for the dialog's comparison, in the order the app lists them."""
    names = {d["slug"]: d["name"] for ds in usage.values() for d in ds}
    out = []
    for meta in storage.list_decks():
        s = meta.get("slug")
        if s and s != slug and not meta.get("damaged"):
            out.append({"slug": s, "name": names.get(s) or meta.get("name") or s, "shelved": bool(meta.get("shelved"))})
    return out


def place_key(e: dict[str, Any]) -> str:
    """„deck:<slug>“ for copies placed in a deck, „ort:<text>“ for a free-text place (Bulk, a binder …), else ""."""
    if e.get("place_deck"):
        return f"deck:{e['place_deck']}"
    text = " ".join(str(e.get("place") or "").split()).lower()
    return f"ort:{text}" if text else ""


def _copies_by_place(entries: list[dict[str, Any]]) -> dict[str, dict[str, dict[str, int]]]:
    """Card name (and front face) -> place key -> {"real": n, "proxy": m}."""
    out: dict[str, dict[str, dict[str, int]]] = {}
    for e in entries:
        key = place_key(e)
        if not key:
            continue
        for name in {e["name"], e["name"].split(" // ")[0]}:
            slot = out.setdefault(name, {}).setdefault(key, {"real": 0, "proxy": 0})
            slot["proxy" if e.get("proxy") else "real"] += int(e.get("qty") or 0)
    return out


def _places(entries: list[dict[str, Any]], decks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What the dialog can compare with: the free-text places of the collection (most cards first),
    then the other decks (their decklists plus copies placed there)."""
    out = [{"key": place_key(p), "label": p["place"], "kind": "place"}
           for p in collection.places(entries) if not p["place_deck"] and p["place"].strip()]  # fmt: skip
    return out + [{"key": f"deck:{d['slug']}", "label": d["name"], "kind": "deck", "slug": d["slug"], "shelved": d.get("shelved", False)}
                  for d in decks]  # fmt: skip


async def build(deck: dict[str, Any], *, use_collection: bool = True, replace_proxies: bool = True) -> dict[str, Any]:
    """``use_collection``: copies in the collection only count when no other deck uses them (a card
    sleeved up in another deck still has to be bought, unless that deck is shelved: then it is listed in
    ``from_shelved`` to take out instead). Off = the whole deck goes on the list."""
    need = _need(deck)
    entries = collection.load()
    every = collection.owned_counts(entries)
    owned = every if use_collection else {}
    usage = collection.decks_by_card()  # also for comparing with other decks and places in the dialog
    by_place = _copies_by_place(entries)
    rows = []
    from_shelved: list[dict[str, Any]] = []  # cards to take out of shelved decks instead of buying them
    for name, n in need.items():
        if name in collection.BASIC_LANDS:
            continue
        o = owned.get(name, {"real": 0, "proxy": 0})
        others = [d for d in usage.get(name, []) if d["slug"] != deck.get("slug")]
        played = [d for d in others if not d.get("shelved")]  # a shelved deck's copies may be taken out
        have = o["real"] + (0 if replace_proxies else o["proxy"])
        free = max(have - sum(d["qty"] for d in others), 0)
        buy = max(n - max(have - sum(d["qty"] for d in played), 0), 0)
        if (taken := n - buy - min(free, n)) > 0:
            from_shelved.append({"name": name, "qty": taken, "decks": [d["name"] for d in others if d.get("shelved")]})
        if buy:
            rows.append({"name": name, "qty": buy, "need": n, "real": o["real"], "proxy": o["proxy"],
                         "in_decks": [d["name"] for d in played] if have else [],
                         # planned = the deck only lists the card, you have no copy of it anywhere
                         "decks": [{"slug": d["slug"], "qty": d["qty"], "planned": not any(every.get(name, {}).values())} for d in others],
                         "places": {k: v for k, v in by_place.get(name, {}).items() if k != f"deck:{deck.get('slug')}"}})  # fmt: skip

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
    other_decks = _other_decks(usage, deck.get("slug"))
    return {
        "slug": deck.get("slug"),
        "name": deck.get("name"),
        "currency": "eur",
        "use_collection": use_collection,
        "other_decks": other_decks,
        "places": _places(entries, other_decks),
        "replace_proxies": replace_proxies,
        "collection_size": len(entries),
        "items": rows,
        "from_shelved": sorted(from_shelved, key=lambda r: r["name"]),
        "cards": sum(r["qty"] for r in rows),
        "total_trend": round(sum(r["total_trend"] or 0 for r in rows), 2),
        "total_low": round(sum(r["total_low"] or 0 for r in rows), 2),
        "unpriced": [r["name"] for r in rows if not r["trend"]],
        "price_date": (idx or {}).get("date"),
        "error": error,
    }
