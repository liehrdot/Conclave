"""The maybe list ("Vielleicht"): cards the user considers for a deck but has not put in yet.

Stored as ``deck["maybe"]`` = ``[{name, category}]`` (sorted by name, the key is left out when empty). It is deck
content, so a change makes a new version and syncs like the card list, but the cards never count: no card count,
legality, bracket, price or print run looks at it. A card is either in the deck or on its maybe list, never both:
putting a deck card on the list takes it out of the deck, adding a maybe card to the deck takes it off the list.

``change()`` is shared by the desktop edit (``deckedit``) and the phone's ``deck.edit`` operation (``sync/appops``),
so no imports here (the sync server image installs the package without dependencies).
"""

from __future__ import annotations

from typing import Any, Callable

MAYBE_MAX = 150  # cards on one maybe list


def entries(deck: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {m["name"]: dict(m) for m in deck.get("maybe") or [] if isinstance(m, dict) and m.get("name")}


def store(deck: dict[str, Any], maybe: dict[str, dict[str, Any]]) -> None:
    if maybe:
        deck["maybe"] = sorted(maybe.values(), key=lambda m: m["name"])
    else:
        deck.pop("maybe", None)


def change(
    cards: dict[str, dict[str, Any]],
    maybe: dict[str, dict[str, Any]],
    *,
    add: list[dict[str, Any]],
    remove: list[str],
    commanders: set[str],
    guess: Callable[[str], str] = lambda name: "Synergy",
) -> list[str]:
    """Apply maybe changes after the card changes (both dicts by name, changed in place); returns note parts.

    Cards now in the deck leave the list; ``remove`` takes names off it; ``add`` (``[{name, category}]``) puts cards on
    it – a card that is in the deck moves (it leaves the deck). Raises ``ValueError`` for a commander or a full list.
    """
    for name in [n for n in maybe if n in cards]:
        del maybe[name]  # went into the deck
    dropped = [name for name in remove if maybe.pop(name, None) is not None]
    put: list[str] = []
    moved: list[str] = []
    for a in add:
        name = a["name"]
        if name in commanders:
            raise ValueError(f"{name} ist der Commander des Decks.")
        card = cards.pop(name, None)
        if name in maybe and card is None:
            continue
        maybe[name] = {"name": name, "category": a.get("category") or (card or {}).get("category") or guess(name)}
        (moved if card else put).append(name)
    if len(maybe) > MAYBE_MAX:
        raise ValueError(f"Auf der Vielleicht-Liste ist Platz für {MAYBE_MAX} Karten.")
    parts = []
    if put:
        parts.append("Vielleicht + " + ", ".join(put))
    if moved:
        parts.append(", ".join(moved) + " → Vielleicht")
    if dropped:
        parts.append("Vielleicht − " + ", ".join(dropped))
    return parts
