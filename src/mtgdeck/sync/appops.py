"""Operations from the phone app ("Am Tisch") on the synced documents – written exactly as the desktop app would:
game entries like ``games.add``, opponent decks and their linking like ``opponents.link_game``.

An operation is ``{"id", "type", "payload", "at"}``; ``apply(op, docs)`` takes the documents it needs
(``paths(op)``) and returns the changed ones. Pure: the sync server reads and writes the store around it, and
remembers applied ids, so an operation sent twice (the phone retries after a lost answer) changes nothing.

Types: ``game.add`` · ``game.delete`` · ``opponent.add`` · ``opponent.update`` · ``opponent.note`` ·
``opponent.note_delete`` · ``opponent.delete`` · ``deck.new`` · ``deck.edit`` · ``deck.flags`` · ``deck.pin_order`` · ``collection.add`` · ``collection.update``.

Decks built on the phone or tablet are saved like ``storage.save`` does it: a new version with a history entry and a
full snapshot (``decks/.versions/<slug>/vNNNN.json``, returned by ``apply`` next to the deck). Card data never reaches
the server, so the check (legality, bracket, price) is left to the PC: the deck gets ``needs_revalidation`` and the
desktop app checks it after its next sync (``service.revalidate_pending``).

Cards scanned or picked on the phone go into ``collection.json`` like ``collection.add`` does it: one entry per printing,
an entry that matches name, printing, proxy, foil and language only gets more copies (``collection._key``).
"""

from __future__ import annotations

import copy
import re
import uuid
from typing import Any

from .. import maybe as maybe_list
from ..games import HOW, ISSUES, RESULTS, clean_places
from ..opponents import MAX_NOTES, TAGS
from ..storage import FLAGS, PIN_RANK, _metrics, diff, level_text
from .files import snapshot_path

OPPONENTS = "decks/.opponents.json"
COLLECTION = "collection.json"
SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,80}")
ID_RE = re.compile(r"[A-Za-z0-9_-]{1,40}")
ISO_RE = re.compile(r"\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)?")
TYPES = ("game.add", "game.delete", "opponent.add", "opponent.update", "opponent.note", "opponent.note_delete", "opponent.delete",
         "deck.new", "deck.edit", "deck.flags", "deck.pin_order", "collection.add", "collection.update")  # fmt: skip
ROUND_KINDS = ("life", "cmd", "poison", "turn", "note", "out")  # entries in a game's round log (Conclave Table; formerly the phone's Runden-Helfer)
ROUND_EVENTS_MAX = 400
CATEGORIES = ("Ramp", "Draw", "Removal", "Board Wipe", "Counterspell", "Tutor", "Protection", "Synergy", "Win Condition", "Utility", "Land")
DECK_CARDS_MAX = 250  # distinct cards in one deck (a Commander deck has at most 99)
EDIT_MAX = 200  # changes in one deck.edit
PIN_ORDER_MAX = 100  # decks in one deck.pin_order
COLLECTION_MAX = 50000  # entries in the collection
LANGS = ("en", "de", "fr", "it", "es", "pt", "ja", "ko", "ru", "zhs", "zht", "ph")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
SET_RE = re.compile(r"[a-z0-9]{2,8}")
NUMBER_RE = re.compile(r"[\w★†\-]{1,12}")
PRICE_RE = re.compile(r"\d{1,6}(\.\d{1,2})?")
IMAGE_PREFIX = "https://cards.scryfall.io/"


class OpError(ValueError):
    """The operation cannot be applied; the message is for the user (German)."""


def _deck_slug(payload: dict[str, Any], key: str = "deck") -> str:
    slug = str(payload.get(key) or "")
    if not SLUG_RE.fullmatch(slug):
        raise OpError("Unbekanntes Deck")
    return slug


def _id(value: Any, what: str) -> str:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise OpError(f"Ungültige Kennung: {what}")
    return value


def paths(op: dict[str, Any]) -> list[str]:
    """The documents an operation reads or writes."""
    t, p = op.get("type"), op.get("payload") or {}
    if t not in TYPES:
        raise OpError(f"Unbekannte Aktion: {t}")
    if t == "game.add":
        slug = _deck_slug(p.get("game") or {})
        return [f"decks/{slug}.json", f"decks/.games/{slug}.json", OPPONENTS]
    if t == "game.delete":
        return [f"decks/.games/{_deck_slug(p)}.json"]
    if t == "deck.new":
        return [f"decks/{_deck_slug(p.get('deck') or {}, 'slug')}.json"]
    if t in ("deck.edit", "deck.flags"):
        return [f"decks/{_deck_slug(p)}.json"]
    if t == "deck.pin_order":
        slugs = p.get("slugs")
        if not isinstance(slugs, list) or not 0 < len(slugs) <= PIN_ORDER_MAX:
            raise OpError("Ungültige Daten")
        return [f"decks/{s}.json" for s in dict.fromkeys(_deck_slug({"deck": s}) for s in slugs)]
    if t.startswith("collection."):
        return [COLLECTION]
    return [OPPONENTS]


def _text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _opponents(doc: Any) -> dict[str, Any]:
    items = (doc or {}).get("opponents") if isinstance(doc, dict) else None
    return {"opponents": [o for o in items or [] if isinstance(o, dict) and o.get("id")]}


def _new_opponent(fields: dict[str, Any], at: str) -> dict[str, Any]:
    commanders = [_text(c, 120) for c in fields.get("commanders") or [] if _text(c, 120)][:2]
    if not commanders:
        raise OpError("Bitte den Commander des Gegners angeben.")
    colors = fields.get("colors") or ""
    return {
        "id": _id(fields.get("id") or uuid.uuid4().hex[:8], "Gegner"), "commanders": commanders,
        "label": _text(fields.get("label"), 80), "player": _text(fields.get("player"), 80), "bracket": None, "table_rule": None,
        "tags": [t for t in dict.fromkeys(fields.get("tags") or []) if t in TAGS], "notes": [],
        "color_identity": [c for c in "WUBRG" if c in str(colors)], "image": fields.get("image") or None,
        "created": at, "updated": at,
    }  # fmt: skip


def _note(text: str, at: str, note_id: str, game_id: str | None = None, deck_slug: str | None = None) -> dict[str, Any]:
    return {"id": note_id, "text": text[:1000], "at": at, "game_id": game_id, "deck_slug": deck_slug}


def _match(items: list[dict[str, Any]], slot: dict[str, Any]) -> dict[str, Any] | None:
    """Like ``opponents.link_game``: by id, else the newest opponent deck led by this commander."""
    if slot.get("id"):
        o = next((x for x in items if x["id"] == slot["id"]), None)
        if o is not None:
            return o
    name = _text(slot.get("commander"), 120).lower()
    hits = [x for x in items if name and name in {n.lower() for n in x.get("commanders") or []}]
    return max(hits, key=lambda x: x.get("updated") or "") if hits else None


def _int(value: Any, lo: int, hi: int) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and lo <= value <= hi else None


def _iso(value: Any) -> str | None:
    return value if isinstance(value, str) and ISO_RE.fullmatch(value) else None


def _round(value: Any) -> dict[str, Any] | None:
    """A game's round log (from Conclave Table, formerly the phone's Runden-Helfer), cleaned: the user's life at the start and end, poison, turns,
    commander damage per opposing commander and the changes turn by turn (``ROUND_EVENTS_MAX`` at most)."""
    if not isinstance(value, dict) or _int(value.get("start_life"), 1, 999) is None:
        return None
    events = []
    for e in value.get("events") or []:
        if not isinstance(e, dict) or e.get("kind") not in ROUND_KINDS or _int(e.get("turn"), 1, 999) is None or not _iso(e.get("at")):
            continue
        item: dict[str, Any] = {"turn": e["turn"], "kind": e["kind"], "delta": _int(e.get("delta"), -999, 999) or 0, "at": e["at"]}
        if _int(e.get("life"), -9999, 9999) is not None:
            item["life"] = e["life"]
        if _text(e.get("from"), 120):
            item["from"] = _text(e.get("from"), 120)
        if e["kind"] == "note":
            item["text"] = _text(e.get("text"), 500)
        events.append(item)
    cmd = [{"name": _text(c.get("name"), 120), "dmg": _int(c.get("dmg"), 0, 999) or 0}
           for c in value.get("cmd") or [] if isinstance(c, dict) and _text(c.get("name"), 120)][:10]  # fmt: skip
    return {
        "start_life": value["start_life"], "life": _int(value.get("life"), -9999, 9999), "poison": _int(value.get("poison"), 0, 999) or 0,
        "turns": _int(value.get("turns"), 1, 999) or 1, "started": _iso(value.get("started")), "ended": _iso(value.get("ended")),
        "cmd": cmd, "events": events[-ROUND_EVENTS_MAX:],
    }  # fmt: skip


def _card_name(value: Any) -> str:
    name = _text(value, 160)
    if not name:
        raise OpError("Kartenname fehlt")
    return name


def _qty(value: Any) -> int:
    qty = _int(value, 0, 99)
    if qty is None:
        raise OpError("Ungültige Anzahl")
    return qty


def _category(value: Any) -> str | None:
    return value if value in CATEGORIES else None


def _save_version(deck: dict[str, Any], old: dict[str, Any] | None, note: str, at: str) -> dict[str, Any]:
    """Like ``storage.save`` for a content change: next version, history entry, snapshot; ``{path: doc}``."""
    deck["version"] = int((old or {}).get("version") or 0) + 1
    deck["created"] = (old or {}).get("created") or at
    deck["updated"] = at
    deck["needs_revalidation"] = True
    change = diff(old, deck) if old else {"added": [], "removed": []}
    deck["history"] = list((old or {}).get("history") or []) + [
        {"version": deck["version"], "at": at, "note": note, **change, "from": level_text(old) if old else None,
         "to": level_text(deck), **_metrics(deck)}  # fmt: skip
    ]
    snap = {k: v for k, v in deck.items() if k != "history"}
    return {f"decks/{deck['slug']}.json": deck, snapshot_path(deck["slug"], deck["version"]): snap}


def _deck_new(p: dict[str, Any], docs: dict[str, Any], at: str) -> dict[str, Any]:
    d = p.get("deck") or {}
    slug = _deck_slug(d, "slug")
    commanders = [_text(c, 160) for c in d.get("commanders") or [] if _text(c, 160)][:2]
    if not commanders:
        raise OpError("Wähle den Commander des Decks.")
    if docs.get(f"decks/{slug}.json") is not None:
        raise OpError("Ein Deck mit diesem Namen gibt es schon – bitte anders nennen.")
    deck = {
        "name": _text(d.get("name"), 120) or " + ".join(commanders), "slug": slug, "commanders": commanders,
        "bracket": _int(d.get("bracket"), 1, 5) or 3, "description": "", "strategy": "", "budget": None, "proxy": False,
        "power_profile": None, "currency": "eur", "notes": "", "cards": [], "validation": None,
    }  # fmt: skip
    return _save_version(deck, None, "Leer angelegt (Am Tisch)", at)


def _change_note(added: list[str], removed: list[str], changed: list[str], note: str) -> str:
    parts = ["+ " + ", ".join(added)] if added else []
    parts += ["− " + ", ".join(removed)] if removed else []
    parts += [", ".join(changed)] if changed else []
    auto = "Am Tisch: " + "; ".join(parts)
    return f"{note} ({auto})" if note else auto


def _deck_edit(p: dict[str, Any], docs: dict[str, Any], at: str) -> dict[str, Any]:
    """Like ``deckedit.edit_deck``: ``add`` [{name, qty, category}] (quantities add up), ``remove`` [names],
    ``set_qty`` {name: qty} (0 removes), ``set_category`` {name: category}, ``maybe_add`` [{name, category}] onto the
    maybe list (a deck card moves there), ``maybe_remove`` [names] off it (``maybe.change``). Applied to the server's
    current deck, so changes made on the PC meanwhile stay. Nothing changed → nothing is written."""
    slug = _deck_slug(p)
    old = docs.get(f"decks/{slug}.json")
    if not isinstance(old, dict):
        raise OpError("Dieses Deck gibt es nicht mehr – am PC gelöscht?")
    adds, removes = p.get("add") or [], p.get("remove") or []
    set_qty, set_cat = p.get("set_qty") or {}, p.get("set_category") or {}
    maybe_adds, maybe_removes = p.get("maybe_add") or [], p.get("maybe_remove") or []
    if not all(isinstance(x, list) for x in (adds, removes, maybe_adds, maybe_removes)) or not all(isinstance(x, dict) for x in (set_qty, set_cat)):
        raise OpError("Ungültige Daten")
    if len(adds) + len(removes) + len(set_qty) + len(set_cat) + len(maybe_adds) + len(maybe_removes) > EDIT_MAX:
        raise OpError("Zu viele Änderungen auf einmal")
    deck = copy.deepcopy(old)
    cards: dict[str, dict[str, Any]] = {c["name"]: c for c in deck.get("cards") or [] if isinstance(c, dict) and c.get("name")}
    commanders = set(deck.get("commanders") or [])
    added: list[str] = []
    removed: list[str] = []
    changed: list[str] = []
    for a in adds:
        name, qty = _card_name((a or {}).get("name")), max(1, _qty((a or {}).get("qty", 1)))
        if name in commanders:
            raise OpError(f"{name} ist der Commander des Decks.")
        if name in cards:
            cards[name]["qty"] = min(99, int(cards[name].get("qty") or 1) + qty)
        else:
            cards[name] = {"name": name, "qty": qty, "category": _category((a or {}).get("category")) or "Synergy"}
        added.append(f"{qty}× {name}" if qty > 1 else name)
    for name in removes:
        if cards.pop(_card_name(name), None) is not None:
            removed.append(name)
    for name, qty in set_qty.items():
        qty = _qty(qty)
        if name not in cards:
            continue
        before = int(cards[name].get("qty") or 1)
        if qty == 0:
            cards.pop(name)
            removed.append(name)
        elif qty != before:
            cards[name]["qty"] = qty
            changed.append(f"{name} {before}→{qty}")
    for name, cat in set_cat.items():
        cat = _category(cat)
        if name in cards and cat and cards[name].get("category") != cat:
            cards[name]["category"] = cat
            changed.append(f"{name} → {cat}")
    maybe = maybe_list.entries(deck)
    before = dict(maybe)
    try:
        maybe_note = maybe_list.change(
            cards, maybe, commanders=commanders, remove=[_card_name(n) for n in maybe_removes],
            add=[{"name": _card_name((a or {}).get("name")), "category": _category((a or {}).get("category"))} for a in maybe_adds],
        )  # fmt: skip
    except ValueError as exc:
        raise OpError(str(exc)) from exc
    changed += ["; ".join(maybe_note)] if maybe_note else []
    if not (added or removed or changed or maybe != before):
        return {}
    if len(cards) > DECK_CARDS_MAX:
        raise OpError("Das sind zu viele Karten für ein Deck.")
    maybe_list.store(deck, maybe)
    deck["cards"] = sorted(cards.values(), key=lambda c: c["name"])
    return _save_version(deck, old, _change_note(added, removed, changed, _text(p.get("note"), 200)), at)


def _deck_flags(p: dict[str, Any], docs: dict[str, Any]) -> dict[str, Any]:
    """Like ``storage.set_flags``: ``pinned`` / ``shelved`` (bools) set or cleared in the file, no new version."""
    slug = _deck_slug(p)
    old = docs.get(f"decks/{slug}.json")
    if not isinstance(old, dict):
        raise OpError("Dieses Deck gibt es nicht mehr – am PC gelöscht?")
    flags = {k: p[k] for k in FLAGS if k in p}
    if not flags or not all(isinstance(v, bool) for v in flags.values()):
        raise OpError("Ungültige Daten")
    deck = dict(old)
    for key, on in flags.items():
        if on:
            deck[key] = True
        else:
            deck.pop(key, None)
    if not deck.get("pinned"):
        deck.pop(PIN_RANK, None)
    return {} if deck == old else {f"decks/{slug}.json": deck}


def _pin_order(op: dict[str, Any], docs: dict[str, Any]) -> dict[str, Any]:
    """Like ``storage.set_pin_order``: the pinned decks get their place in ``slugs`` as ``pin_rank``."""
    out = {}
    for rank, path in enumerate(paths(op)):
        deck = docs.get(path)
        if isinstance(deck, dict) and deck.get("pinned") and deck.get(PIN_RANK) != rank:
            out[path] = {**deck, PIN_RANK: rank}
    return out


def _coll_key(e: dict[str, Any]) -> tuple[Any, ...]:  # like collection._key (that module needs the network stack)
    return (str(e.get("name") or "").lower(), e.get("scryfall_id") or "", bool(e.get("proxy")), bool(e.get("foil")), e.get("lang") or "en",
            e.get("place_deck") or "", "" if e.get("place_deck") else str(e.get("place") or "").strip().lower())  # fmt: skip


PLACE_DECK_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,80}")


def _place(place: Any, place_deck: Any) -> tuple[str, str]:  # like collection.clean_place
    text = " ".join(str(place or "").split())[:80] if isinstance(place, str) else ""
    return text, _match_str(place_deck, PLACE_DECK_RE) or ""


def _coll_items(doc: Any) -> list[Any]:
    return list(doc) if isinstance(doc, list) else []


def _match_str(value: Any, pattern: re.Pattern[str]) -> str | None:
    value = str(value).strip() if isinstance(value, (str, int, float)) and not isinstance(value, bool) else ""
    return value if value and pattern.fullmatch(value) else None


def _image(value: Any) -> str | None:
    return value if isinstance(value, str) and value.startswith(IMAGE_PREFIX) and len(value) < 300 else None


def _collection_add(p: dict[str, Any], docs: dict[str, Any], at: str) -> dict[str, Any]:
    """``entry`` {name, qty, proxy, foil, lang, scryfall_id, set, set_name, collector_number, image, image_back, price_eur,
    price_usd, place, place_deck}: more copies of the matching entry, else a new one. A negative ``qty`` takes copies away again (undo)."""
    e = p.get("entry")
    if not isinstance(e, dict):
        raise OpError("Ungültige Daten")
    qty = _int(e.get("qty"), -99, 99)
    if not qty:
        raise OpError("Ungültige Anzahl")
    entry = {
        "name": _card_name(e.get("name")), "qty": qty, "proxy": e.get("proxy") is True, "foil": e.get("foil") is True,
        "lang": e.get("lang") if e.get("lang") in LANGS else "en", "scryfall_id": _match_str(e.get("scryfall_id"), UUID_RE),
        "set": _match_str(str(e.get("set") or "").lower(), SET_RE), "set_name": _text(e.get("set_name"), 120) or None,
        "collector_number": _match_str(e.get("collector_number"), NUMBER_RE), "image": _image(e.get("image")),
        "image_back": _image(e.get("image_back")), "price_eur": _match_str(e.get("price_eur"), PRICE_RE),
        "price_usd": _match_str(e.get("price_usd"), PRICE_RE),
    }  # fmt: skip
    entry["place"], entry["place_deck"] = _place(e.get("place"), e.get("place_deck"))
    items = _coll_items(docs.get(COLLECTION))
    key = _coll_key(entry)
    hit = next((x for x in items if isinstance(x, dict) and x.get("name") and _coll_key(x) == key), None)
    if hit is not None:
        hit["qty"] = min(9999, int(hit.get("qty") or 0) + qty)
        if hit["qty"] <= 0:
            items.remove(hit)
        return {COLLECTION: items}
    if qty < 0:
        return {}  # nothing left to take away
    if len(items) >= COLLECTION_MAX:
        raise OpError("Die Sammlung ist voll.")
    ids = {x.get("id") for x in items if isinstance(x, dict)}
    entry_id = e.get("id") if isinstance(e.get("id"), str) and ID_RE.fullmatch(e["id"]) and e["id"] not in ids else uuid.uuid4().hex[:12]
    items.append({"id": entry_id, **entry, "note": "", "added": at})
    return {COLLECTION: items}


def _collection_update(p: dict[str, Any], docs: dict[str, Any]) -> dict[str, Any]:
    """Like ``collection.update``: ``id`` plus ``qty`` (0 deletes), ``proxy``, ``foil``, ``lang``, ``place`` +
    ``place_deck`` (where the cards are); then entries that now
    describe the same thing are merged."""
    items = _coll_items(docs.get(COLLECTION))
    entry = next((x for x in items if isinstance(x, dict) and x.get("id") == p.get("id")), None)
    if entry is None:
        if p.get("qty") == 0:
            return {}  # gone already
        raise OpError("Diese Karte ist nicht mehr in deiner Sammlung – am PC geändert?")
    before = dict(entry)
    if "qty" in p:
        qty = _int(p.get("qty"), 0, 9999)
        if qty is None:
            raise OpError("Ungültige Anzahl")
        entry["qty"] = qty
    for key in ("proxy", "foil"):
        if key in p:
            entry[key] = p[key] is True
    if "lang" in p:
        entry["lang"] = p["lang"] if p["lang"] in LANGS else "en"
    if "place" in p or "place_deck" in p:
        entry["place"], entry["place_deck"] = _place(p.get("place", entry.get("place")), p.get("place_deck", entry.get("place_deck")))
    if entry == before:
        return {}
    out: list[Any] = []
    seen: dict[tuple[Any, ...], dict[str, Any]] = {}
    for x in items:
        if not (isinstance(x, dict) and x.get("name")):
            out.append(x)
            continue
        k = _coll_key(x)
        if k in seen:
            seen[k]["qty"] = int(seen[k].get("qty") or 0) + int(x.get("qty") or 0)
            continue
        seen[k] = x
        out.append(x)
    return {COLLECTION: [x for x in out if not isinstance(x, dict) or not x.get("name") or int(x.get("qty") or 0) > 0]}


def apply(op: dict[str, Any], docs: dict[str, Any]) -> dict[str, Any]:
    """Apply ``op`` to ``docs`` (``{path: value or None}`` for ``paths(op)``); returns ``{path: new value}`` – for the
    deck operations also the new version's snapshot, a path ``paths(op)`` does not list."""
    t, p, at = op["type"], op.get("payload") or {}, str(op.get("at") or "")
    if not ISO_RE.fullmatch(at):
        raise OpError("Ungültiger Zeitpunkt")
    if t == "deck.new":
        return _deck_new(p, docs, at)
    if t == "deck.edit":
        return _deck_edit(p, docs, at)
    if t == "deck.flags":
        return _deck_flags(p, docs)
    if t == "deck.pin_order":
        return _pin_order(op, docs)
    if t == "collection.add":
        return _collection_add(p, docs, at)
    if t == "collection.update":
        return _collection_update(p, docs)
    out: dict[str, Any] = {}
    if t == "game.add":
        g = p.get("game") or {}
        slug = _deck_slug(g)
        deck = docs.get(f"decks/{slug}.json")
        if not isinstance(deck, dict):
            raise OpError("Dieses Deck gibt es nicht mehr – am PC gelöscht?")
        game_id = _id(g.get("id"), "Partie")
        games = [x for x in docs.get(f"decks/.games/{slug}.json") or [] if isinstance(x, dict)]
        if any(x.get("id") == game_id for x in games):
            return out  # already there (sent twice)
        result = g.get("result")
        if result not in RESULTS:
            raise OpError("Ergebnis fehlt")
        issues = [i for i in dict.fromkeys(g.get("issues") or []) if i in ISSUES]
        turn = g.get("turn")
        turn = int(turn) if isinstance(turn, int) and 1 <= turn <= 60 else None
        opp_doc = _opponents(docs.get(OPPONENTS))
        items = opp_doc["opponents"]
        names: list[str] = []
        ids: list[str | None] = []
        slot_places: list[Any] = []  # each opponent's finishing place, same order as names
        changed = False
        for slot in (p.get("opponents") or [])[:5]:
            if not isinstance(slot, dict):
                continue
            o = _match(items, slot)
            if o is None and _text(slot.get("commander"), 120):
                o = _new_opponent({"id": slot.get("new_id"), "commanders": [slot.get("commander")], "colors": slot.get("colors"),
                                   "image": slot.get("image")}, at)  # fmt: skip
                items.append(o)
            if o is None:
                continue
            note = _text(slot.get("note"), 1000)
            if note:
                o["notes"] = ((o.get("notes") or []) + [_note(note, at, uuid.uuid4().hex[:8], game_id, slug)])[-MAX_NOTES:]
            o["updated"] = at
            changed = True
            names.append(_text(slot.get("commander"), 120) or o["commanders"][0])
            ids.append(o["id"])
            slot_places.append(slot.get("place"))
        played = g.get("played") if isinstance(g.get("played"), str) and ISO_RE.fullmatch(g["played"]) else at  # undo of a delete keeps the date
        entry: dict[str, Any] = {
            "id": game_id, "played": played, "result": result, "opponents": names, "turn": turn, "issues": issues,
            "mvp": _text(g.get("mvp"), 120) or None, "note": _text(g.get("note"), 2000), "version": deck.get("version"),
        }  # fmt: skip
        if any(ids):
            entry["opponent_ids"] = ids
        if g.get("how") in HOW:
            entry["how"] = g["how"]
        started = g.get("started")
        if started == "me" or (isinstance(started, int) and 0 <= started < len(names)):
            entry["started"] = started
        place, opp_places = clean_places(g.get("place"), slot_places, len(names))
        if place:
            entry["place"] = place
        if opp_places:
            entry["opponent_places"] = opp_places
        round_log = _round(g.get("round"))
        if round_log:
            entry["round"] = round_log
        out[f"decks/.games/{slug}.json"] = games + [entry]
        if changed:
            out[OPPONENTS] = opp_doc
        return out
    if t == "game.delete":
        path = f"decks/.games/{_deck_slug(p)}.json"
        games = [x for x in docs.get(path) or [] if isinstance(x, dict)]
        keep = [x for x in games if x.get("id") != p.get("id")]
        if len(keep) != len(games):
            out[path] = keep
        return out

    opp_doc = _opponents(docs.get(OPPONENTS))
    items = opp_doc["opponents"]
    if t == "opponent.add":
        o = _new_opponent(p.get("opponent") or {}, at)
        if any(x["id"] == o["id"] for x in items):
            return out
        note = _text(p.get("note"), 1000)
        if note:
            o["notes"] = [_note(note, at, _id(p.get("note_id") or uuid.uuid4().hex[:8], "Notiz"))]
        items.append(o)
        out[OPPONENTS] = opp_doc
        return out
    o = next((x for x in items if x["id"] == p.get("id")), None)
    if o is None:
        if t in ("opponent.delete", "opponent.note_delete"):
            return out  # gone already
        raise OpError("Dieses Gegnerdeck gibt es nicht mehr")
    if t == "opponent.update":  # games stay linked by id, so the record survives a new name or commander
        if "commanders" in p:
            commanders = [_text(c, 120) for c in p.get("commanders") or [] if _text(c, 120)][:2]
            if not commanders:
                raise OpError("Bitte den Commander des Gegners angeben.")
            if commanders != o.get("commanders"):
                o["commanders"] = commanders
                o["color_identity"] = [c for c in "WUBRG" if c in str(p.get("colors") or "")]
                o["image"] = p.get("image") or None
        if "tags" in p:
            o["tags"] = [x for x in dict.fromkeys(p.get("tags") or []) if x in TAGS]
        for key in ("player", "label"):
            if key in p:
                o[key] = _text(p.get(key), 80)
        if "bracket" in p:
            o["bracket"] = _int(p.get("bracket"), 1, 5)
        o["updated"] = at
    elif t == "opponent.note":
        note_id = _id(p.get("note_id"), "Notiz")
        text = _text(p.get("text"), 1000)
        if not text or any(n.get("id") == note_id for n in o.get("notes") or []):
            return out
        o["notes"] = ((o.get("notes") or []) + [_note(text, at, note_id)])[-MAX_NOTES:]
        o["updated"] = at
    elif t == "opponent.note_delete":
        before = len(o.get("notes") or [])
        o["notes"] = [n for n in o.get("notes") or [] if n.get("id") != p.get("note_id")]
        if len(o["notes"]) == before:
            return out
    elif t == "opponent.delete":
        opp_doc["opponents"] = [x for x in items if x["id"] != o["id"]]
    out[OPPONENTS] = opp_doc
    return out


def apply_copy(op: dict[str, Any], docs: dict[str, Any]) -> dict[str, Any]:
    """``apply`` on a deep copy (callers keep their originals)."""
    return apply(op, copy.deepcopy(docs))
