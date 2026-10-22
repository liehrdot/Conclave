"""Read model for the phone app ("Am Tisch"): one compact JSON built from the synced documents.

``snapshot(docs)`` takes ``{logical path: parsed document}`` (decks, game logs, opponents, the collection) and returns
what the phone shows: decks with Rule 0, card list (names + categories; card data comes from Scryfall on the phone) and
record, opponents with their record against the user, all games (newest first), the collection (one row per printing,
without notes; the artwork follows from the Scryfall id) and the quick-pick lists. Pure – no files, no
network – so the sync server can build it from its store and tests from plain dicts.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

from .. import rule0, speed
from ..games import HOW, ISSUES, RESULTS
from ..opponents import TAGS, record as opponent_record, title as opponent_title
from ..storage import level_text, list_rank
from .files import DECK_RE

GAMES_RE = re.compile(r"decks/\.games/([^/.][^/]*)\.json")
OPPONENTS_PATH = "decks/.opponents.json"
COLLECTION_PATH = "collection.json"
COLLECTION_KEYS = ("id", "name", "qty", "proxy", "foil", "lang", "set", "set_name", "collector_number", "scryfall_id", "price_eur", "place", "place_deck")
GAMES_MAX = 400
NOTES_MAX = 30
VERSION = 1


def _record(items: list[dict[str, Any]]) -> dict[str, Any]:
    results = Counter(g.get("result") for g in items)
    return {"games": len(items), "wins": results["win"], "losses": results["loss"], "draws": results["draw"],
            "last": max((g.get("played") or "" for g in items), default=None)}  # fmt: skip


def _speed(d: dict[str, Any]) -> dict[str, Any] | None:
    r = speed.rate(d)
    return {k: r[k] for k in ("total", "effective", "key", "label", "text", "complete", "cards")} if r else None


def _deck(slug: str, d: dict[str, Any], games: list[dict[str, Any]]) -> dict[str, Any]:
    v = d.get("validation") or {}
    r0 = rule0.build({**d, "slug": slug})
    return {
        "slug": slug, "name": d.get("name") or slug, "commanders": d.get("commanders") or [],
        "colors": v.get("color_identity") or "", "bracket": d.get("bracket"),
        "tier": (d.get("power_profile") or {}).get("tier"), "level": level_text(d), "proxy": bool(d.get("proxy")),
        "legal": v.get("legal"), "description": rule0._first_sentence(d.get("description") or d.get("strategy") or "", 220),
        "version": d.get("version"), "updated": d.get("updated"), "checking": bool(d.get("needs_revalidation")),
        "rule0": {"rows": r0["rows"], "text": r0["text"]},
        "speed": _speed(d),
        "cards": [{"name": c["name"], "qty": int(c.get("qty") or 1), "category": c.get("category") or ""}
                  for c in d.get("cards") or [] if isinstance(c, dict) and c.get("name")],
        "maybe": [{"name": m["name"], "category": m.get("category") or ""} for m in d.get("maybe") or [] if isinstance(m, dict) and m.get("name")],
        "record": _record(games), "pinned": bool(d.get("pinned")), "shelved": bool(d.get("shelved")),
        "pin_rank": d.get("pin_rank") if d.get("pinned") else None,
    }  # fmt: skip


def collection(doc: Any) -> list[dict[str, Any]]:
    """The collection for the phone: the fields it shows; ``image`` only where there is no Scryfall id to derive it."""
    out = []
    for e in doc if isinstance(doc, list) else []:
        if not (isinstance(e, dict) and e.get("id") and e.get("name")):
            continue
        row = {k: e.get(k) for k in COLLECTION_KEYS}
        row["qty"] = int(e.get("qty") or 0)
        row["proxy"], row["foil"], row["lang"] = bool(e.get("proxy")), bool(e.get("foil")), e.get("lang") or "en"
        if not e.get("scryfall_id") and e.get("image"):
            row["image"] = e["image"]
        out.append(row)
    return sorted(out, key=lambda e: e["name"].lower())


def snapshot(docs: dict[str, Any]) -> dict[str, Any]:
    decks_raw = {m.group(1): v for p, v in docs.items() if (m := DECK_RE.fullmatch(p)) and isinstance(v, dict)}
    games: list[dict[str, Any]] = []
    for path, value in docs.items():
        m = GAMES_RE.fullmatch(path)
        if m and isinstance(value, list):
            games += [{**g, "deck": m.group(1)} for g in value if isinstance(g, dict) and g.get("id")]
    games.sort(key=lambda g: g.get("played") or "", reverse=True)

    decks = [_deck(slug, d, [g for g in games if g["deck"] == slug]) for slug, d in decks_raw.items()]
    decks.sort(key=lambda d: (d["record"]["last"] or "", d["updated"] or ""), reverse=True)
    decks.sort(key=list_rank)  # pinned first (in the dragged order), shelved last

    names = {d["slug"]: d["name"] for d in decks}
    all_games = [(g["deck"], names.get(g["deck"], g["deck"]), g) for g in games]
    raw = (docs.get(OPPONENTS_PATH) or {}).get("opponents") if isinstance(docs.get(OPPONENTS_PATH), dict) else []
    opponents = []
    for o in raw or []:
        if not isinstance(o, dict) or not o.get("id"):
            continue
        rec = opponent_record(o, all_games)
        opponents.append({
            "id": o["id"], "title": opponent_title(o), "label": o.get("label") or "", "player": o.get("player") or "",
            "commanders": o.get("commanders") or [], "colors": "".join(o.get("color_identity") or []),
            "bracket": o.get("bracket"), "tags": [t for t in o.get("tags") or [] if t in TAGS],
            "notes": sorted(o.get("notes") or [], key=lambda n: n.get("at") or "", reverse=True)[:NOTES_MAX],
            "record": {k: rec[k] for k in ("games", "wins", "losses", "draws", "last", "per_deck")},
            "updated": o.get("updated"), "created": o.get("created"),
        })  # fmt: skip
    opponents.sort(key=lambda o: (o["record"]["last"] or "", o["updated"] or ""), reverse=True)

    return {
        "version": VERSION, "decks": decks, "opponents": opponents, "games": games[:GAMES_MAX],
        "collection": collection(docs.get(COLLECTION_PATH)),
        "players": sorted({o["player"] for o in opponents if o["player"]}, key=str.lower),
        "options": {
            "results": RESULTS, "issues": [[k, v[0]] for k, v in ISSUES.items()],
            "tags": [[k, v[0]] for k, v in TAGS.items()], "how": [[k, v] for k, v in HOW.items()],
        },
    }  # fmt: skip
