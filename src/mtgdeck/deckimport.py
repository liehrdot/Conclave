"""Turn an imported list (link, pasted text, precon) into a saved deck: preview with commander
candidates, then validation (bracket estimated when not given), categories and a new version."""

from __future__ import annotations

from typing import Any

from . import storage
from .cards import resolve
from .deck import BASIC_LANDS, parse_decklist
from .edhrec import slugify


def _can_be_commander(card: dict[str, Any]) -> bool:
    front = (card.get("type_line") or "").split("//")[0]
    text = (card.get("oracle_text") or "").lower()
    return ("Legendary" in front and ("Creature" in front or "Background" in front)) or "can be your commander" in text


_PAIRS = ("partner", "choose a background", "friends forever", "doctor's companion")


def _pairs(card: dict[str, Any]) -> bool:
    """Can share the command zone (Partner, Background, Friends forever, Doctor's companion)."""
    text = (card.get("oracle_text") or "").lower()
    return "Background" in (card.get("type_line") or "") or any(k in text for k in _PAIRS)


def _candidates(counts: dict[str, int], found: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Legendary cards of the list; ``fits`` = its colour identity (or with a partner's) covers the
    whole deck's, those come first (a commander must cover every card's colours, so the others are rarely the one)."""
    deck_ci = {c for n in counts if n in found for c in found[n].get("color_identity") or []}
    out = []
    for n in counts:
        card = found.get(n)
        if not card or not _can_be_commander(card):
            continue
        out.append({"name": n, "image": card.get("image"), "type_line": card.get("type_line") or "",
                    "color_identity": card.get("color_identity") or [], "pairs": _pairs(card),
                    "fits": deck_ci <= set(card.get("color_identity") or [])})  # fmt: skip
    if not any(c["fits"] for c in out):  # maybe two partners cover it together
        pairs = [c for c in out if c["pairs"]]
        for c in pairs:
            c["fits"] = any(o is not c and deck_ci <= {*c["color_identity"], *o["color_identity"]} for o in pairs)
    return sorted(out, key=lambda c: not c["fits"])


async def preview(data: dict[str, Any]) -> dict[str, Any]:
    """Resolve the imported names (German too), count cards and offer commander candidates.

    Adds ``card_count``, ``unresolved``, ``commander_candidates`` ([{name, image, type_line,
    color_identity, pairs, fits}], legendary cards of the list, colour-fitting first) and ``suggested`` (commanders to preselect)."""
    parsed = parse_decklist(data["cards"])
    names = list(data["commanders"]) + [e.name for e in parsed.entries]
    try:
        found, renames, missing = await resolve(names)
    except Exception:  # offline: keep the names as they are
        found, renames, missing = {}, {}, []
    commanders = [renames.get(c, c) for c in data["commanders"]]
    counts: dict[str, int] = {}
    for e in parsed.entries:
        n = renames.get(e.name, e.name)
        counts[n] = counts.get(n, 0) + e.qty
    categories = {renames.get(k, k): v for k, v in (data.get("categories") or {}).items()}
    candidates = _candidates(counts, found)
    suggested = commanders
    hint = (data.get("commander_hint") or "").strip()
    if not suggested and hint:
        suggested = [c["name"] for c in candidates if c["name"] == hint or slugify(c["name"]) == slugify(hint)][:1]
    fitting = [c["name"] for c in candidates if c["fits"]]
    if not suggested and len(candidates) == 1:
        suggested = [candidates[0]["name"]]
    if not suggested and (len(fitting) == 1 or (len(fitting) == 2 and all(c["pairs"] for c in candidates if c["fits"]))):
        suggested = fitting
    images = {n: c.get("image") for n, c in found.items()}
    return {**data, "commanders": commanders, "cards": [f"{q} {n}" for n, q in counts.items()], "categories": categories,
            "card_count": len(commanders) + sum(counts.values()), "unresolved": missing,
            "commander_candidates": candidates, "suggested": suggested,
            "commander_images": {c: images.get(c) for c in commanders}}  # fmt: skip


async def save(*, name: str, commanders: list[str], cards: list[str], categories: dict[str, str] | None = None,
               bracket: int | None = None, currency: str = "eur", description: str = "", note: str = "",
               extra: dict[str, Any] | None = None) -> dict[str, Any]:  # fmt: skip
    """Validate and save as a new deck. ``cards`` are "N Name" lines without the commanders; with
    ``bracket=None`` the deck is checked against the bracket Spellbook/the heuristic estimates."""
    from .deckedit import guess_category  # deckedit imports validate; keep the import lazy
    from .validate import validate_deck

    if not commanders:
        raise ValueError("Wähle den Commander des Decks.")
    lines = [line for line in cards if line.split(" ", 1)[-1] not in commanders]
    target = bracket or 3
    result = await validate_deck(commanders, lines, target, currency=currency)
    if bracket is None:
        est = result["bracket"].get("estimated")
        if isinstance(est, int) and 1 <= est <= 5 and est != target:
            target = est
            result = await validate_deck(commanders, lines, target, currency=currency)
    card_data = result.pop("_card_data")
    cats = categories or {}

    def category(n: str) -> str:
        if n in BASIC_LANDS:
            return "Land"
        return cats.get(n) or guess_category(card_data.get(n, {}))

    deck = {
        "name": name, "slug": storage.unique_slug(name), "commanders": result["commanders"], "bracket": target,
        "description": description, "strategy": "", "budget": None, "proxy": False, "power_profile": None,
        "currency": currency, "notes": "", "change_note": note or "Importiert",
        "cards": [{**c, "category": category(c["name"])} for c in result.pop("cards")], "validation": result,
        **(extra or {}),
    }  # fmt: skip
    saved = storage.save(deck)
    return {**saved, "bracket": target, "legal": result["legal"], "errors": result["errors"]}
