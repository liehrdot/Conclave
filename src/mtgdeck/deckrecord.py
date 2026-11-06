"""How a deck's record is kept, without file I/O: which keys are content, how a new version and its history entry
look, the per-deck marks (pinned, shelved, pin rank) and the deck list's order.

``storage`` (the PC), ``sync.appops`` (the phone's operations on the server) and ``sync.merge`` (two devices' copies)
all call these, so a deck saved anywhere looks the same. Stdlib only: the sync server image loads it without the
rest of the package's dependencies."""

from __future__ import annotations

import json
from typing import Any

# Fields whose change creates a new version (re-validation alone does not).
CONTENT_KEYS = ("name", "commanders", "cards", "bracket", "power_profile", "proxy", "budget", "currency",
                "description", "strategy", "notes", "table_rule", "maybe")  # fmt: skip
# Written on every save; everything else that is not content (guide, upgrade_plan, built_against, precon,
# copied_from …) is carried over when a caller saves a deck dict built from scratch.
PER_SAVE_KEYS = {"slug", "history", "version", "created", "updated", "validation", "change_note", "needs_revalidation"}
FLAGS = ("pinned", "shelved")  # per-deck marks outside the content (``with_flags``)
PIN_RANK = "pin_rank"  # the user's order of the pinned decks, 0 = on top


def _card_counts(deck: dict[str, Any]) -> dict[str, int]:
    counts = {c["name"]: int(c.get("qty", 1)) for c in deck.get("cards", [])}
    for cmdr in deck.get("commanders", []):
        counts[f"{cmdr} (Commander)"] = 1
    return counts


def diff(old: dict[str, Any], new: dict[str, Any]) -> dict[str, list[str]]:
    """Cards added/removed between two deck versions ('2 Forest' for count changes)."""
    a, b = _card_counts(old), _card_counts(new)
    added = [f"{b[n] - a.get(n, 0)} {n}" if b[n] - a.get(n, 0) > 1 else n for n in sorted(b) if b[n] > a.get(n, 0)]
    removed = [f"{a[n] - b.get(n, 0)} {n}" if a[n] - b.get(n, 0) > 1 else n for n in sorted(a) if a[n] > b.get(n, 0)]
    return {"added": added, "removed": removed}


def level_text(deck: dict[str, Any], lang: str = "de") -> str:
    """„oberes Bracket 3“; ``lang="en"`` for the native phone apps: „upper Bracket 3“."""
    tier = (deck.get("power_profile") or {}).get("tier")
    labels = {"low": "unteres", "mid": "mittleres", "high": "oberes"} if lang == "de" else {"low": "lower", "mid": "mid", "high": "upper"}
    return f"{labels[tier]} Bracket {deck.get('bracket')}" if tier else f"Bracket {deck.get('bracket')}"


def metrics(deck: dict[str, Any]) -> dict[str, Any]:
    """The figures a history entry keeps of its version: level, price, power score, legal."""
    v = deck.get("validation") or {}
    return {
        "level": level_text(deck),
        "price": v.get("price_total"),
        "power": ((v.get("bracket") or {}).get("power") or {}).get("value"),
        "legal": v.get("legal"),
    }


def content(deck: dict[str, Any]) -> str:
    """The deck's content keys as one comparable string: equal strings = no new version needed."""
    return json.dumps({k: deck.get(k) for k in CONTENT_KEYS}, sort_keys=True, default=str)


def snapshot(deck: dict[str, Any]) -> dict[str, Any]:
    """What ``decks/.versions/<slug>/vNNNN.json`` stores: the deck without its history."""
    return {k: v for k, v in deck.items() if k != "history"}


def history_entry(old: dict[str, Any] | None, deck: dict[str, Any], note: str, at: str) -> dict[str, Any]:
    """The history entry of ``deck``'s version: the card diff against ``old`` (none for a new deck), level from → to
    and the figures of ``metrics``."""
    change = diff(old, deck) if old else {"added": [], "removed": []}
    return {"version": deck["version"], "at": at, "note": note, **change,
            "from": level_text(old) if old else None, "to": level_text(deck), **metrics(deck)}  # fmt: skip


def add_version(deck: dict[str, Any], old: dict[str, Any] | None, note: str, at: str) -> None:
    """Make ``deck`` the version after ``old``: number + 1 and ``old``'s history plus this version's entry."""
    deck["version"] = int((old or {}).get("version") or 0) + 1
    deck["history"] = [*((old or {}).get("history") or []), history_entry(old, deck, note, at)]


def with_flags(deck: dict[str, Any], flags: dict[str, bool]) -> dict[str, Any]:
    """A copy of ``deck`` with each of ``FLAGS`` in ``flags`` set (True) or removed; an unpinned deck loses its
    ``pin_rank``. ``ValueError`` for a key that is no flag."""
    if not flags or set(flags) - set(FLAGS):
        raise ValueError("Unbekannte Markierung")
    out = dict(deck)
    for key, on in flags.items():
        if on:
            out[key] = True
        else:
            out.pop(key, None)
    if not out.get("pinned"):
        out.pop(PIN_RANK, None)
    return out


def with_pin_rank(deck: dict[str, Any], rank: int) -> dict[str, Any] | None:
    """``deck`` with its place among the pinned decks, or None when it is not pinned or already there."""
    if not deck.get("pinned") or deck.get(PIN_RANK) == rank:
        return None
    return {**deck, PIN_RANK: rank}


def list_rank(d: dict[str, Any]) -> tuple[int, int, float]:
    """Pinned decks first (newly pinned ones, without a dragged place yet, on top, then by ``pin_rank``), shelved
    ones last (a deck can be both: then it leads the shelved ones)."""
    rank = d.get(PIN_RANK) if d.get("pinned") else None
    group = (2 if d.get("shelved") else 0) + (0 if d.get("pinned") else 1)
    return group, 0 if not isinstance(rank, (int, float)) else 1, rank if isinstance(rank, (int, float)) else 0
