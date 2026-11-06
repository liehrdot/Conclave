"""What a card may be in Commander, decided the same way everywhere: who can lead a deck, who can share the command
zone, and what counts as a tutor. Works on Conclave's compact cards (``scryfall.compact``) and on raw Scryfall card
objects (the bulk import). Stdlib only: ``bulk`` uses it, and Conclave Cards imports ``bulk``.

The commander rule follows Scryfall's ``is:commander``. Legality (banned cards) is not part of it; callers check
``commander_legal`` themselves, because the deck check reports a banned commander with its own message."""

from __future__ import annotations

import re
from typing import Any

# Keywords that let two commanders share the command zone (a Background type line does too).
PAIR_RE = re.compile(r"\bpartner\b|friends forever|choose a background|doctor'?s companion", re.I)


def front_type(card: dict[str, Any]) -> str:
    """The front face's type line (``"A // B"`` for a double-faced card)."""
    return (card.get("type_line") or "").split("//")[0]


def _text(card: dict[str, Any]) -> str:
    text = card.get("oracle_text") or " ".join(f.get("oracle_text") or "" for f in card.get("card_faces") or [])
    return text.lower()


def _has_pt(card: dict[str, Any]) -> bool:
    faces = card.get("card_faces") or [{}]
    return bool(card.get("pt")) or card.get("power") is not None or faces[0].get("power") is not None


def can_lead(card: dict[str, Any]) -> bool:
    """Whether a card can be a commander, like Scryfall's ``is:commander``: a legendary creature, a Background, a
    legendary Vehicle or Spacecraft with power/toughness, or a card that says it can be your commander."""
    if "can be your commander" in _text(card):
        return True
    front = front_type(card)
    if "Legendary" not in front:
        return False
    return "Creature" in front or "Background" in front or (_has_pt(card) and ("Vehicle" in front or "Spacecraft" in front))


def can_pair(card: dict[str, Any]) -> bool:
    """Whether a commander can share the command zone: Partner (also „Partner with …“), Friends forever, Choose a
    Background, Doctor's companion, or a Background itself."""
    return "Background" in front_type(card) or bool(PAIR_RE.search(_text(card)))


def is_tutor(card: dict[str, Any], roles: Any = None) -> bool:
    """A tutor for the bracket and table rules: a card with the „tutor“ role (``deck.card_roles``) that is no land, so
    fetch lands and other land searches never count."""
    roles = card.get("roles") if roles is None else roles
    return "tutor" in (roles or ()) and "Land" not in front_type(card)
