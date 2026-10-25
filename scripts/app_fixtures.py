"""Writes docs/app-api/ops.json: what each phone app operation does to the read model, worked out by the server itself.

The phone web app (``data.js``) and the native apps (Conclave for iPhone, later Android) apply an operation to their copy
of the read model at once, before the server has answered, and send it in the background. Their tests check that copy
against these cases. ``bases`` holds read models (what ``GET /api/app/data`` returns, ``appdata.snapshot``); each case is
``{name, about, base, op}`` plus ``after`` = the top-level keys of the read model that the server's ``appops.apply``
changed, with their new value (``{}`` = nothing changed), or ``error`` = the German message the server answers with.

    uv run python scripts/app_fixtures.py          # write the file
    uv run python scripts/app_fixtures.py --check  # exit 1 if it is out of date (tests/test_app_fixtures.py does this)

Cases only use ids the op brings along: where the server makes one up (a game note without an id), it is random.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any

from mtgdeck.sync import appdata, appops

OUT = Path(__file__).resolve().parent.parent / "docs" / "app-api" / "ops.json"
AT = "2026-10-10T20:00:00+00:00"
VERSION = 1

MEREN = {
    "name": "Meren", "slug": "meren", "commanders": ["Meren of Clan Nel Toth"], "bracket": 3, "power_profile": {"tier": "high"},
    "version": 2, "description": "Opfern und zurückholen.", "created": "2026-09-01T10:00:00+00:00", "updated": "2026-10-01T10:00:00+00:00",
    "cards": [{"name": "Forest", "qty": 30, "category": "Land"}, {"name": "Sakura-Tribe Elder", "qty": 1, "category": "Ramp"},
              {"name": "Sol Ring", "qty": 1, "category": "Ramp"}],
    "maybe": [{"name": "Grim Backwoods", "category": "Draw"}],
    "validation": {"legal": True, "color_identity": "BG", "bracket": {"game_changers": [], "power": {"value": 3.7}}},
    "history": [{"version": 1, "at": "2026-09-01T10:00:00+00:00", "note": "Import"}, {"version": 2, "at": "2026-10-01T10:00:00+00:00", "note": "Manuell"}],
}  # fmt: skip
KAALIA = {
    "name": "Kaalia", "slug": "kaalia", "commanders": ["Kaalia of the Vast"], "bracket": 2, "version": 1, "pinned": True, "pin_rank": 0,
    "created": "2026-09-05T10:00:00+00:00", "updated": "2026-09-05T10:00:00+00:00", "cards": [{"name": "Sol Ring", "qty": 1, "category": "Ramp"}],
    "validation": {"legal": True, "color_identity": "RWB"},
}  # fmt: skip
GAMES = [{"id": "g1", "played": "2026-10-02T20:00:00+00:00", "result": "win", "opponents": ["Atraxa, Praetors' Voice"], "opponent_ids": ["o1"],
          "turn": 9, "issues": [], "mvp": None, "note": "", "version": 2}]  # fmt: skip
OPPONENTS = {"opponents": [
    {"id": "o1", "commanders": ["Atraxa, Praetors' Voice"], "label": "", "player": "Tim", "bracket": 4, "table_rule": None, "tags": ["combo"],
     "notes": [{"id": "n1", "text": "Hält Interaktion für Meren zurück", "at": "2026-10-02T21:00:00+00:00", "game_id": "g1", "deck_slug": "meren"}],
     "color_identity": ["W", "U", "B", "G"], "image": None, "created": "2026-09-01T00:00:00+00:00", "updated": "2026-10-02T21:00:00+00:00"},
    {"id": "o2", "commanders": ["Krenko, Mob Boss"], "label": "Goblins", "player": "Lisa", "bracket": None, "table_rule": None, "tags": [],
     "notes": [], "color_identity": ["R"], "image": None, "created": "2026-09-01T00:00:00+00:00", "updated": "2026-09-01T00:00:00+00:00"},
]}  # fmt: skip
SOL_RING = {"id": "c1", "name": "Sol Ring", "qty": 2, "proxy": False, "foil": False, "lang": "en", "scryfall_id": "4cbc6901-6a4a-4d0a-83ea-7eefa3b35021",
            "set": "c21", "set_name": "Commander 2021", "collector_number": "263", "image": None, "image_back": None, "price_eur": "1.20",
            "price_usd": None, "place": "Binder", "place_deck": "", "note": "", "added": "2026-09-01T00:00:00+00:00"}  # fmt: skip
FOREST = {**SOL_RING, "id": "c2", "name": "Forest", "qty": 10, "scryfall_id": None, "set": None, "set_name": None, "collector_number": None,
          "price_eur": None, "place": "", "place_deck": "meren"}  # fmt: skip

BASE = {"decks/meren.json": MEREN, "decks/kaalia.json": KAALIA, "decks/.games/meren.json": GAMES, "decks/.games/kaalia.json": None,
        "decks/.opponents.json": OPPONENTS, "collection.json": [SOL_RING, FOREST]}  # fmt: skip

# (name, about, type, payload)
CASES: list[tuple[str, str, str, dict[str, Any]]] = [
    ("game-add-known-opponent", "A game against an opponent deck picked by id; its note goes to that opponent.", "game.add",
     {"game": {"id": "g2", "deck": "meren", "result": "loss", "turn": 11, "how": "combo", "place": 2},
      "opponents": [{"id": "o1", "commander": "Atraxa, Praetors' Voice", "place": 1}]}),
    ("game-add-by-commander", "No id: the newest opponent deck with this commander is linked, a new one is made for an unknown commander.", "game.add",
     {"game": {"id": "g3", "deck": "meren", "result": "win", "started": "me", "place": 1},
      "opponents": [{"commander": "Krenko, Mob Boss", "place": 2}, {"commander": "Edgar Markov", "new_id": "o9", "colors": "RWB", "place": 3}]}),
    ("game-add-with-round", "A game with its round log, as Conclave Table sends it.", "game.add",
     {"game": {"id": "g4", "deck": "meren", "result": "win", "round": {
         "start_life": 40, "life": 12, "poison": 0, "turns": 7, "started": "2026-10-10T19:00:00+00:00", "ended": AT,
         "cmd": [{"name": "Krenko, Mob Boss", "dmg": 9}],
         "events": [{"turn": 3, "kind": "life", "delta": -5, "life": 35, "at": "2026-10-10T19:20:00+00:00"},
                    {"turn": 5, "kind": "cmd", "delta": -9, "life": 26, "from": "Krenko, Mob Boss", "at": "2026-10-10T19:40:00+00:00"}]}},
      "opponents": [{"id": "o2", "commander": "Krenko, Mob Boss"}]}),
    ("game-add-twice", "The same game id again (the phone resent it): nothing changes.", "game.add",
     {"game": {"id": "g1", "deck": "meren", "result": "loss"}, "opponents": []}),
    ("game-add-no-result", "A game needs a result.", "game.add", {"game": {"id": "g5", "deck": "meren"}, "opponents": []}),
    ("game-add-deleted-deck", "The deck was deleted on the PC meanwhile.", "game.add",
     {"game": {"id": "g6", "deck": "gone", "result": "win"}, "opponents": []}),
    ("game-delete", "A game is deleted.", "game.delete", {"deck": "meren", "id": "g1"}),
    ("opponent-add", "A new opponent deck with a first note.", "opponent.add",
     {"opponent": {"id": "o3", "commanders": ["Edgar Markov"], "colors": "RWB", "player": "Max", "tags": ["aggro"]}, "note": "Viele Token", "note_id": "n5"}),
    ("opponent-add-no-commander", "An opponent deck needs a commander.", "opponent.add", {"opponent": {"id": "o4", "commanders": []}}),
    ("opponent-update", "Name, player and bracket of an opponent deck change; games stay linked by id.", "opponent.update",
     {"id": "o2", "label": "Krenko Tokens", "player": "Lisa M.", "bracket": 3}),
    ("opponent-update-commander", "The commander changes: colours and artwork follow.", "opponent.update",
     {"id": "o2", "commanders": ["Krenko, Tin Street Kingpin"], "colors": "R"}),
    ("opponent-note", "A note on an opponent deck.", "opponent.note", {"id": "o2", "note_id": "n6", "text": "Wipe bereithalten"}),
    ("opponent-note-delete", "A note is deleted.", "opponent.note_delete", {"id": "o1", "note_id": "n1"}),
    ("opponent-delete", "An opponent deck is deleted; its games keep the commander name.", "opponent.delete", {"id": "o1"}),
    ("deck-new", "An empty deck with its commander, built on the tablet; the PC checks it later.", "deck.new",
     {"deck": {"slug": "edgar", "name": "Vampire", "commanders": ["Edgar Markov"], "bracket": 3}}),
    ("deck-new-taken", "The slug is taken.", "deck.new", {"deck": {"slug": "meren", "commanders": ["Meren of Clan Nel Toth"]}}),
    ("deck-edit", "Cards added, removed, counted and moved; the maybe list follows.", "deck.edit",
     {"deck": "meren", "add": [{"name": "Swamp", "qty": 2, "category": "Land"}, {"name": "Sol Ring", "qty": 1}],
      "remove": ["Sakura-Tribe Elder"], "set_qty": {"Forest": 28}, "set_category": {"Sol Ring": "Utility"},
      "maybe_add": [{"name": "Phyrexian Arena", "category": "Draw"}], "maybe_remove": ["Grim Backwoods"]}),
    ("deck-edit-to-maybe", "A deck card moves onto the maybe list.", "deck.edit", {"deck": "meren", "maybe_add": [{"name": "Sakura-Tribe Elder"}]}),
    ("deck-edit-nothing", "Nothing changes: no new version.", "deck.edit", {"deck": "meren", "set_qty": {"Sol Ring": 1}}),
    ("deck-edit-commander", "The commander cannot go into the 99.", "deck.edit", {"deck": "meren", "add": [{"name": "Meren of Clan Nel Toth"}]}),
    ("deck-flags-pin", "A deck is pinned.", "deck.flags", {"deck": "meren", "pinned": True}),
    ("deck-flags-shelve", "A deck is shelved and unpinned (its pin rank goes).", "deck.flags", {"deck": "kaalia", "pinned": False, "shelved": True}),
    ("deck-pin-order", "The pinned decks get their dragged order; unpinned ones are left alone.", "deck.pin_order", {"slugs": ["meren", "kaalia"]}),
    ("collection-add-new", "A scanned card that is not in the collection yet.", "collection.add",
     {"entry": {"id": "c3", "name": "Arcane Signet", "qty": 1, "lang": "de", "scryfall_id": "c6ec4b0c-ba8e-4f1d-9a59-bd95cc7b6b1c",
                "set": "M3C", "set_name": "Modern Horizons 3 Commander", "collector_number": "283", "price_eur": "0.35", "place": "Binder"}}),
    ("collection-add-more", "The same printing at the same place: more copies of the entry.", "collection.add",
     {"entry": {"id": "c4", "name": "Sol Ring", "qty": 1, "scryfall_id": "4cbc6901-6a4a-4d0a-83ea-7eefa3b35021", "set": "c21",
                "collector_number": "263", "place": "binder"}}),
    ("collection-add-undo", "A negative quantity takes copies away again (undo of an add).", "collection.add",
     {"entry": {"name": "Sol Ring", "qty": -2, "scryfall_id": "4cbc6901-6a4a-4d0a-83ea-7eefa3b35021", "place": "Binder"}}),
    ("collection-update-qty", "Fewer copies.", "collection.update", {"id": "c2", "qty": 7}),
    ("collection-update-delete", "Quantity 0 deletes the entry.", "collection.update", {"id": "c1", "qty": 0}),
    ("collection-update-merge", "Moved to where an equal entry already is: the two become one.", "collection.update",
     {"id": "c4x", "place": "Binder"}),
    ("collection-update-place", "Another place: from a deck into a box.", "collection.update", {"id": "c2", "place": "Kiste 3", "place_deck": ""}),
    ("unknown-type", "An operation the server does not know.", "chat.ask", {}),
]  # fmt: skip


def _base(name: str) -> dict[str, Any]:
    docs = copy.deepcopy(BASE)
    if name == "collection-update-merge":  # a second Sol Ring entry in a box, then moved to the binder
        docs["collection.json"].append({**SOL_RING, "id": "c4x", "qty": 1, "place": "Kiste"})
    return docs


def _op(name: str, type_: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"id": f"op-{name}"[:40], "type": type_, "payload": payload, "at": AT}


def build() -> dict[str, Any]:
    bases: dict[str, Any] = {}
    cases = []
    for name, about, type_, payload in CASES:
        op = _op(name, type_, payload)
        docs = _base(name)
        before = appdata.snapshot(docs)
        base = next((k for k, v in bases.items() if v == before), None) or ("default" if not bases else name)
        bases.setdefault(base, before)
        case: dict[str, Any] = {"name": name, "about": about, "base": base, "op": op}
        try:
            changed = appops.apply_copy(op, {p: docs.get(p) for p in appops.paths(op)})
        except appops.OpError as exc:
            case["error"] = str(exc)
        else:
            after = appdata.snapshot({**docs, **changed})
            case["after"] = {k: v for k, v in after.items() if v != before.get(k)}
        cases.append(case)
    return {"version": VERSION, "about": "See docs/app-api.md; written by scripts/app_fixtures.py.", "bases": bases, "cases": cases}


def text() -> str:
    return json.dumps(build(), ensure_ascii=False, indent=1, sort_keys=True) + "\n"


def main(argv: list[str]) -> int:
    if "--check" in argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text():
            print(f"{OUT} is out of date: run uv run python scripts/app_fixtures.py", file=sys.stderr)
            return 1
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text(), encoding="utf-8")
    print(f"wrote {OUT} ({len(CASES)} cases)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
