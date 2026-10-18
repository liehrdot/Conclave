"""Deck speed from the total mana value: the mana values of all 100 cards added up (commanders
included, lands count 0, X counts 0, a double-faced card counts its front). Fast decks are cheap:
strong Bracket 4 and cEDH decks sit around 120–140, a typical precon above 220. No network – it
reads the stored deck check (``deck["validation"]["stats"]``).
"""

from __future__ import annotations

from typing import Any

from . import fmt

# (highest total, key, label, what it means) – the last row has no upper end.
TIERS: list[tuple[float, str, str, str]] = [
    (140, "very-fast", "Sehr schnell", "cEDH-Tempo: so günstig wie Bracket-5- und starke Bracket-4-Decks."),
    (170, "fast", "Schnell", "Starkes Bracket-4-Tempo: fast alles kommt früh auf den Tisch."),
    (205, "brisk", "Zügig", "Gut optimiert, wie ein starkes Bracket 3 oder ein lockeres Bracket 4."),
    (240, "steady", "Gemächlich", "Typisches Casual-Tempo, etwa wie ein Precon."),
    (float("inf"), "slow", "Langsam", "Viele teure Karten: das Deck braucht lange, bis es läuft."),
]  # fmt: skip
SCALE = (100, 300)  # where the GUI's bar starts and ends
FULL_DECK = 100


def tier(total: float) -> tuple[str, str, str]:
    return next((key, label, text) for top, key, label, text in TIERS if total <= top)


def total(stats: dict[str, Any]) -> tuple[float, bool]:
    """(total mana value, exact). Checks before ``total_mana_value`` existed only stored the
    average of the non-land cards; that gives the total without the commanders (not exact)."""
    if stats.get("total_mana_value") is not None:
        return float(stats["total_mana_value"]), True
    nonland = int(stats.get("card_count") or 0) - int((stats.get("types") or {}).get("Land", 0))
    return float(stats.get("avg_cmc_nonland") or 0) * max(nonland, 0), False


def rate(deck: dict[str, Any]) -> dict[str, Any] | None:
    """``{total, key, label, text, summary, average, cards, complete, exact, scale}`` or None
    when the deck has not been checked yet."""
    validation = deck.get("validation") or {}
    stats = validation.get("stats") or {}
    if not stats.get("card_count"):
        return None
    value, exact = total(stats)
    value = round(value)
    key, label, text = tier(value)
    cards = int(stats["card_count"]) + len(validation.get("commanders") or deck.get("commanders") or [])
    complete = cards >= FULL_DECK
    summary = f"{label} – Gesamt-Manawert {value}"
    if not complete:
        summary += f" bei erst {cards} von {FULL_DECK} Karten"
    return {
        "total": value, "key": key, "label": label, "text": text, "summary": summary,
        "average": stats.get("avg_cmc_nonland"), "cards": cards, "complete": complete, "exact": exact,
        "scale": list(SCALE), "tiers": [{"key": k, "label": lab, "max": None if top == float("inf") else top}
                                        for top, k, lab, _ in TIERS],
    }  # fmt: skip


def line(deck: dict[str, Any]) -> str:
    """One line for Rule 0 and the phone: „Schnell (Gesamt-Manawert 158)“."""
    r = rate(deck)
    if not r:
        return ""
    out = f"{r['label']} (Gesamt-Manawert {r['total']}"
    if r["average"]:
        out += f", Ø {fmt.num(float(r['average']))}"
    return out + ("" if r["complete"] else f", erst {r['cards']} Karten") + ")"
