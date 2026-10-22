"""Verkaufsliste: cards from the collection the user wants to sell on Cardmarket.

Stored as JSON (``MTG_SALES_FILE``, default ``<home>/sales.json``, gitignored, in backups). One item per collection
entry put up for sale: the printing (name, set, number, language, foil, image), ``qty``, ``condition`` (Cardmarket's
codes, ``cardmarket.CONDITIONS``), ``price`` (EUR; ``price_custom`` once the user typed one, else it follows the price
rule), ``comment``, the Cardmarket ``product_id`` of that printing and ``status`` open › listed › sold.

Prices come from Cardmarket's daily price guide (``cardmarket.py``) for exactly that printing; the rule (setting
``sale_price``, ``RULES``) turns its trend or lowest price into the suggestion. Conclave never lists anything itself:
the desktop app's Cardmarket window (``desktop/src-tauri/src/cardmarket.rs``) only fills Cardmarket's own sell form,
the user checks it and clicks Cardmarket's button for every card, and the window reports the card back as listed.
„Verkauft“ takes the copies out of the collection (``sold``; ``unsold`` puts them back).
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

from . import cardmarket, carddb, collection, paths, scryfall, settings
from .http import HttpError
from .jsonstore import locked, read_json, write_json

SALES_FILE = Path(os.environ.get("MTG_SALES_FILE", paths.home() / "sales.json"))

# price rule -> (label, factor on the trend price; None = the printing's lowest listing)
RULES = {"trend": ("Trend", 1.0), "trend95": ("Trend − 5 %", 0.95), "trend90": ("Trend − 10 %", 0.90), "low": ("Ab-Preis", None)}
STATUSES = ("open", "listed", "sold")
MIN_PRICE = 0.02  # Cardmarket's smallest price
COMMENT_MAX = 200
LANG_NAMES = {"en": "Englisch", "de": "Deutsch", "fr": "Französisch", "it": "Italienisch", "es": "Spanisch", "pt": "Portugiesisch",
              "ja": "Japanisch", "ko": "Koreanisch", "ru": "Russisch", "zhs": "Chinesisch (vereinfacht)", "zht": "Chinesisch (traditionell)"}  # fmt: skip


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load() -> list[dict[str, Any]]:
    data = read_json(SALES_FILE, [])
    return data if isinstance(data, list) else []


def _write(items: list[dict[str, Any]]) -> None:
    write_json(SALES_FILE, items, indent=1)


def rule() -> str:
    r = settings.load().get("sale_price")
    return r if r in RULES else "trend"


def suggest(trend: float | None, low: float | None, how: str) -> float | None:
    """The price the rule asks for, rounded to cents (never below Cardmarket's minimum)."""
    base = (low or trend) if how == "low" else (trend or low)
    if base is None:
        return None
    return max(MIN_PRICE, round(base * (RULES.get(how, RULES["trend"])[1] or 1.0), 2))


def _same(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """A collection entry still holding the item's copies (entries get new ids when they merge)."""
    return (a["name"] == b["name"] and (a.get("scryfall_id") or "") == (b.get("scryfall_id") or "")
            and bool(a.get("foil")) == bool(b.get("foil")) and (a.get("lang") or "en") == (b.get("lang") or "en")
            and not b.get("proxy"))  # fmt: skip


def _entry_for(item: dict[str, Any], entries: list[dict[str, Any]]) -> dict[str, Any] | None:
    return next((e for e in entries if e["id"] == item.get("entry_id")), None) or next((e for e in entries if _same(item, e)), None)


async def _product_ids(entries: list[dict[str, Any]]) -> dict[str, int]:
    """Collection entry id -> the Cardmarket product of its printing: the local card DB by set + number, else Scryfall."""
    out: dict[str, int] = {}
    try:
        known = carddb.cardmarket_ids([(e.get("set") or "", e.get("collector_number") or "") for e in entries])
    except Exception:  # an old or damaged DB: ask Scryfall
        known = {}
    rest = []
    for e in entries:
        pid = known.get(((e.get("set") or "").lower(), str(e.get("collector_number") or "").lower()))
        if pid:
            out[e["id"]] = pid
        elif e.get("scryfall_id"):
            rest.append(e)
    if rest:
        try:
            found, _ = await scryfall.by_identifiers([{"id": e["scryfall_id"]} for e in rest])
        except HttpError:
            found = []
        for e, card in zip(rest, found):
            if card and card.get("cardmarket_id"):
                out[e["id"]] = int(card["cardmarket_id"])
    return out


async def _index() -> tuple[dict[str, Any], str | None]:
    try:
        idx = await cardmarket.index()
    except HttpError as exc:
        return {}, exc.friendly
    return idx, None if idx.get("ids") else "Die Preisliste von Cardmarket hatte ein unbekanntes Format."


async def add(entry_ids: list[str], *, qty: int | None = None, condition: str = "NM") -> dict[str, Any]:
    """Put collection entries on the list (``qty``: only that many copies, for a single entry). Proxies are skipped
    (Cardmarket forbids selling them), and so are entries already on the list."""
    condition = condition if condition in cardmarket.CONDITIONS else "NM"
    entries = [e for e in collection.load() if e["id"] in set(entry_ids)]
    on_list = load()
    skipped = []
    todo = []
    for e in entries:
        if e.get("proxy"):
            skipped.append({"name": e["name"], "reason": "Proxy"})
        elif any(i["status"] != "sold" and (i.get("entry_id") == e["id"] or _same(i, e)) for i in on_list):
            skipped.append({"name": e["name"], "reason": "schon auf der Liste"})
        else:
            todo.append(e)
    products = await _product_ids(todo) if todo else {}
    idx, error = await _index() if todo else ({}, None)
    how = rule()
    new = []
    for e in todo:
        pid = products.get(e["id"])
        pr = cardmarket.product_price(idx, pid, foil=bool(e.get("foil")))
        price = suggest(pr["trend"], pr["low"], how)
        if price is None and e.get("price_eur"):  # not in the guide: Scryfall's price for that printing
            price = max(MIN_PRICE, round(float(e["price_eur"]), 2))
        new.append({
            "id": uuid.uuid4().hex[:12], "entry_id": e["id"], "name": e["name"], "scryfall_id": e.get("scryfall_id"),
            "set": e.get("set"), "set_name": e.get("set_name"), "collector_number": e.get("collector_number"),
            "lang": e.get("lang") or "en", "foil": bool(e.get("foil")), "image": e.get("image"),
            "qty": max(1, min(int(qty or e["qty"]), int(e["qty"]))), "condition": condition,
            "price": price, "price_custom": False, "comment": "", "product_id": pid,
            "status": "open", "added": _now(), "listed_at": None, "sold_at": None,
        })  # fmt: skip
    if new:
        with locked(SALES_FILE):  # read after the (slow) lookups
            _write(load() + new)
    return {"added": len(new), "cards": sum(i["qty"] for i in new), "skipped": skipped, "error": error}


def _public(item: dict[str, Any], idx: dict[str, Any], entries: list[dict[str, Any]], how: str) -> dict[str, Any]:
    pr = cardmarket.product_price(idx, item.get("product_id"), foil=item.get("foil", False))
    entry = _entry_for(item, entries)
    pid = item.get("product_id")
    return {
        **item,
        "trend": pr["trend"], "low": pr["low"], "suggested": suggest(pr["trend"], pr["low"], how),
        "url": cardmarket.PRODUCT_URL.format(id=pid) if pid else None,
        "search_url": cardmarket.SEARCH_URL.format(q=quote_plus(item["name"].split(" // ")[0])),
        "lang_id": cardmarket.LANGUAGES.get(item.get("lang") or "en"), "lang_name": LANG_NAMES.get(item.get("lang") or "en", item.get("lang")),
        "condition_name": cardmarket.CONDITIONS.get(item.get("condition"), ""),
        "in_collection": entry["qty"] if entry else 0,
        "place_deck": (entry or {}).get("place_deck") or "", "place": (entry or {}).get("place") or "",
    }  # fmt: skip


async def view() -> dict[str, Any]:
    """The list with today's prices. Open items without a typed price follow the rule (and are saved with it)."""
    items = load()
    idx, error = await _index() if items else ({}, None)
    how = rule()
    entries = collection.load()
    out = [_public(i, idx, entries, how) for i in items]
    moved = {i["id"]: i["suggested"] for i in out if i["status"] == "open" and not i.get("price_custom") and i["suggested"] is not None and i["suggested"] != i.get("price")}
    if moved:
        with locked(SALES_FILE):
            stored = load()
            for i in stored:
                if i["id"] in moved and i["status"] == "open" and not i.get("price_custom"):
                    i["price"] = moved[i["id"]]
            _write(stored)
        for i in out:
            i["price"] = moved.get(i["id"], i["price"])
    order = {s: n for n, s in enumerate(STATUSES)}
    out.sort(key=lambda i: (order.get(i["status"], 9), i["name"].lower()))
    count = {s: sum(i["qty"] for i in out if i["status"] == s) for s in STATUSES}
    worth = {s: round(sum((i["price"] or 0) * i["qty"] for i in out if i["status"] == s), 2) for s in STATUSES}
    return {"items": out, "rule": how, "rules": [{"key": k, "label": v[0]} for k, v in RULES.items()],
            "conditions": [{"key": k, "label": v} for k, v in cardmarket.CONDITIONS.items()],
            "count": count, "value": worth, "price_date": idx.get("date"), "error": error}  # fmt: skip


def update(item_id: str, **fields: Any) -> dict[str, Any]:
    """Change qty / condition / price (None = back to the rule's price) / comment / status (open ⇄ listed)."""
    with locked(SALES_FILE):
        items = load()
        item = next((i for i in items if i["id"] == item_id), None)
        if item is None:
            raise KeyError(item_id)
        if "qty" in fields and fields["qty"] is not None:
            entry = _entry_for(item, collection.load())
            item["qty"] = max(1, min(int(fields["qty"]), int(entry["qty"]) if entry and item["status"] != "sold" else 9999))
        if fields.get("condition") in cardmarket.CONDITIONS:
            item["condition"] = fields["condition"]
        if "price" in fields:
            p = fields["price"]
            item["price"], item["price_custom"] = (max(MIN_PRICE, round(float(p), 2)), True) if p is not None else (item.get("price"), False)
        if fields.get("comment") is not None:
            item["comment"] = " ".join(str(fields["comment"]).split())[:COMMENT_MAX]
        if fields.get("status") in ("open", "listed") and item["status"] != "sold":
            item["status"] = fields["status"]
            item["listed_at"] = _now() if fields["status"] == "listed" else None
        _write(items)
    return item


def set_rule(how: str) -> str:
    if how not in RULES:
        raise ValueError("Unbekannte Preisregel")
    settings.update({"sale_price": how})
    return how


def remove(item_id: str) -> int:
    with locked(SALES_FILE):
        items = load()
        keep = [i for i in items if i["id"] != item_id]
        _write(keep)
    return len(items) - len(keep)


def clear_sold() -> int:
    with locked(SALES_FILE):
        items = load()
        keep = [i for i in items if i["status"] != "sold"]
        _write(keep)
    return len(items) - len(keep)


def sold(item_id: str) -> dict[str, Any]:
    """The card sold: its copies leave the collection (at most what the entry still has); ``unsold`` undoes it."""
    with locked(SALES_FILE):
        items = load()
        item = next((i for i in items if i["id"] == item_id), None)
        if item is None:
            raise KeyError(item_id)
        if item["status"] == "sold":
            return {"item": item, "removed": 0}
        entry = _entry_for(item, collection.load())
        removed = min(int(item["qty"]), int(entry["qty"])) if entry else 0
        if entry and removed:
            collection.update(entry["id"], qty=int(entry["qty"]) - removed)
        item.update(status="sold", sold_at=_now(), sold_entry={**entry, "qty": removed} if entry and removed else None)
        _write(items)
    return {"item": item, "removed": removed}


def unsold(item_id: str) -> dict[str, Any]:
    """„Rückgängig“ after „Verkauft“: the copies go back into the collection, the card is listed again."""
    with locked(SALES_FILE):
        items = load()
        item = next((i for i in items if i["id"] == item_id), None)
        if item is None:
            raise KeyError(item_id)
        if item["status"] != "sold":
            return item
        if item.get("sold_entry"):
            back = collection.restore_entry(item["sold_entry"])
            item["entry_id"] = back["id"]
        item.update(status="listed" if item.get("listed_at") else "open", sold_at=None, sold_entry=None)
        _write(items)
    return item


def tags(entries: list[dict[str, Any]] | None = None) -> dict[str, dict[str, Any]]:
    """Collection entry id -> {qty, status, price} of its open or listed sale (the „Verkauf“ tag in Meine Sammlung)."""
    entries = collection.load() if entries is None else entries
    out: dict[str, dict[str, Any]] = {}
    for i in load():
        if i["status"] == "sold":
            continue
        e = _entry_for(i, entries)
        if e:
            out[e["id"]] = {"id": i["id"], "qty": i["qty"], "status": i["status"], "price": i.get("price")}
    return out
