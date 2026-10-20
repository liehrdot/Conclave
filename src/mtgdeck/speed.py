"""Deck speed from the total mana value: the mana values of all 100 cards added up (commanders
included, lands count 0, X counts 0, a double-faced card counts its front). Fast decks are cheap:
strong Bracket 4 and cEDH decks sit around 120–140, a typical precon above 220.

Printed costs alone call a deck slow that casts Ghalta for two, so ``analyse()`` (run by the deck
check, rule-based on Oracle text, no AI) also works out an *effective* total:

- self discounts: „This spell costs {X} less …“ counts only its coloured pips; convoke, delve,
  improvise, affinity, emerge and „{1} less for each …“ count half; a fixed „{2} less if …“ is taken off;
- deck-wide discounts: „Creature spells you cast cost {1} less“ (Goreclaw, Medallions, Herald's Horn …)
  take their amount off every matching card, at most ``REDUCER_CAP`` per reducer (twice for a commander);
- a cheap two-card combo (Commander Spellbook, ≤ ``COMBO_MAX`` mana together) makes the deck at least „Schnell“.

No card ever drops below its coloured pips. ``rate()`` reads the stored deck check (``deck["validation"]``).
"""

from __future__ import annotations

import math
import re
from collections import Counter
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
REDUCER_CAP = 10
COMBO_MAX = 8
COMBO_TIER = "fast"

_SYMBOL_RE = re.compile(r"\{([^}]+)\}")
_SELF_X_RE = re.compile(r"\bthis spell costs \{X\} less to cast", re.I)
_SELF_EACH_RE = re.compile(r"\bthis spell costs \{(\d+)\} less to cast for each", re.I)
_SELF_FIXED_RE = re.compile(r"\bthis spell costs \{(\d+)\} less to cast(?! for each)", re.I)
_HALF_RE = re.compile(r"(?:^|, )(convoke|delve|improvise|affinity for [a-z]+|emerge)\b", re.I | re.M)
_REDUCER_RE = re.compile(
    r"(?:^|[.\n] ?)([A-Za-z ,'-]*?)\b[Ss]pells(?: you cast)?((?: [a-z0-9 ]+?)?) cost \{(\d+)\} less to cast", re.M
)
_TYPES = {"creature", "artifact", "enchantment", "instant", "sorcery", "planeswalker", "battle", "legendary", "kindred"}
_COLORS = {"white": "W", "blue": "U", "black": "B", "red": "R", "green": "G"}
_FILLER = {"and", "or", "you", "cast", "the", "first", ""}
_GERMAN = {"Creature": "Kreatur", "Artifact": "Artefakt", "Enchantment": "Verzauberung", "Instant": "Spontanzauber",
           "Sorcery": "Hexerei", "Planeswalker": "Planeswalker", "Battle": "Schlacht", "Legendary": "legendär",
           "Kindred": "Stammes", "W": "weiß", "U": "blau", "B": "schwarz", "R": "rot", "G": "grün"}  # fmt: skip
_LABEL = {"self-x": "zählt nur die farbigen Manasymbole",
          "half": "{kw}: zählt etwa die Hälfte",
          "each": "wird pro Bedingung günstiger: zählt etwa die Hälfte",
          "fixed": "kostet {n} weniger"}  # fmt: skip


def tier(total: float) -> tuple[str, str, str]:
    return next((key, label, text) for top, key, label, text in TIERS if total <= top)


def _front(text: str | None) -> str:
    return (text or "").split(" // ")[0]


def pips(card: dict[str, Any]) -> int:
    """Coloured (and {C}) symbols of the front face – what no discount can take away."""
    return sum(1 for s in _SYMBOL_RE.findall(_front(card.get("mana_cost"))) if not s.isdigit() and s not in "XYZ")


def _is_land(card: dict[str, Any]) -> bool:
    return "Land" in _front(card.get("type_line"))


def _self_discount(card: dict[str, Any]) -> tuple[float, str] | None:
    """(effective cost, reason) for a card that makes itself cheaper."""
    cmc, floor, text = float(card.get("cmc") or 0), pips(card), _front(card.get("oracle_text"))
    if cmc <= floor:
        return None
    if _SELF_X_RE.search(text):
        return float(floor), _LABEL["self-x"]
    kw = _HALF_RE.search(text)
    if kw:
        return max(float(floor), math.ceil(cmc / 2)), _LABEL["half"].format(kw=kw.group(1).capitalize())
    if _SELF_EACH_RE.search(text):
        return max(float(floor), math.ceil(cmc / 2)), _LABEL["each"]
    fixed = _SELF_FIXED_RE.search(text)
    if fixed:
        return max(float(floor), cmc - int(fixed.group(1))), _LABEL["fixed"].format(n=fixed.group(1))
    return None


def _subtypes(card: dict[str, Any]) -> list[str]:
    line = _front(card.get("type_line"))
    return line.split("—", 1)[1].split() if "—" in line else []


def reducers(card: dict[str, Any], chosen_type: str | None = None) -> list[dict[str, Any]]:
    """The deck-wide discounts on this card: ``[{amount, what, match}]`` (``match(card) -> bool``),
    leaving out conditions we cannot check (and anything that only helps opponents)."""
    out: list[dict[str, Any]] = []
    text = _front(card.get("oracle_text"))
    for m in _REDUCER_RE.finditer(text):
        subject, rest, amount = m.group(1).strip(), m.group(2).strip(), int(m.group(3))
        if "opponent" in subject.lower() or "opponent" in rest:
            continue
        colors, types, subs, non = set(), set(), set(), set()
        ok = True
        for word in re.split(r"[ ,]+", subject):
            low = word.lower()
            if low in _FILLER:
                continue
            if low in _COLORS:
                colors.add(_COLORS[low])
            elif low in _TYPES:
                types.add(low.capitalize())
            elif low.startswith("non") and low[3:] in _TYPES:
                non.add(low[3:].capitalize())
            elif word[:1].isupper():
                subs.add(word)
            else:
                ok = False
        power = mv = None
        if rest:
            if rest == "of the chosen type" and chosen_type:
                subs.add(chosen_type)
            elif p := re.fullmatch(r"with power (\d+) or greater", rest):
                power = int(p.group(1))
            elif p := re.fullmatch(r"with mana value (\d+) or greater", rest):
                mv = int(p.group(1))
            elif not rest.startswith("for each"):
                ok = False
        if not ok:
            continue

        def match(c: dict[str, Any], colors=colors, types=types, subs=subs, non=non, power=power, mv=mv) -> bool:
            line = _front(c.get("type_line"))
            if _is_land(c):
                return False
            if colors and not any(col in sym for sym in _SYMBOL_RE.findall(_front(c.get("mana_cost"))) for col in colors):
                return False
            if types and not any(t in line for t in types):
                return False
            if non and any(t in line for t in non):
                return False
            if subs and not subs & set(_subtypes(c)):
                return False
            if power is not None:
                pt = (c.get("pt") or "").split("/")[0]
                if not (pt.isdigit() and int(pt) >= power):
                    return False
            return mv is None or float(c.get("cmc") or 0) >= mv

        bits = [" oder ".join(_GERMAN.get(t, t) for t in sorted(colors) + sorted(types)) if colors or types else ""]
        bits += [f"nicht {_GERMAN.get(t, t)}" for t in sorted(non)] + sorted(subs)
        bits += [f"Stärke {power}+"] if power is not None else []
        bits += [f"Manawert {mv}+"] if mv is not None else []
        out.append({"amount": amount, "what": " · ".join(b for b in bits if b) or "alle Zauber", "match": match})
    return out


def analyse(cards: list[dict[str, Any]], qty: dict[str, int], commanders: list[dict[str, Any]] | None = None,
            combos: list[dict[str, Any]] | None = None) -> dict[str, Any]:  # fmt: skip
    """The effective total: ``{effective, discounts, reducers, combo}`` (see the module doc)."""
    entries = [(c, 1, True) for c in commanders or []] + [(c, qty.get(c["name"], 1), False) for c in cards]
    entries = [e for e in entries if not _is_land(e[0])]
    cost = {c["name"]: float(c.get("cmc") or 0) for c, _, _ in entries}
    discounts: list[dict[str, Any]] = []
    for c, _, _ in entries:
        found = _self_discount(c)
        if found:
            cost[c["name"]] = found[0]
            discounts.append({"name": c["name"], "before": float(c.get("cmc") or 0), "after": found[0], "why": found[1]})
    creature_types = Counter(t for c, n, _ in entries if "Creature" in _front(c.get("type_line")) for t in _subtypes(c) for _ in range(n))
    chosen = creature_types.most_common(1)[0][0] if creature_types else None
    reducers_hit: list[dict[str, Any]] = []
    for r_card, r_qty, is_commander in entries:
        found = reducers(r_card, chosen)
        if not found:
            continue
        cap, saved, hit = REDUCER_CAP * (2 if is_commander else 1) * r_qty, 0.0, []
        for c, n, _ in entries:
            red = next((r for r in found if r["match"](c)), None)
            if c["name"] == r_card["name"] or saved >= cap or not red:
                continue
            cut = min(red["amount"], cost[c["name"]] - pips(c)) * n
            cut = min(cut, cap - saved)
            if cut > 0:
                cost[c["name"]] -= cut / n
                saved += cut
                hit.append(c["name"])
        if saved:
            reducers_hit.append({"name": r_card["name"], "amount": max(r["amount"] for r in found),
                                 "what": " / ".join(r["what"] for r in found), "saved": saved, "cards": len(hit)})  # fmt: skip
    effective = sum(cost[c["name"]] * n for c, n, _ in entries)
    combo = None
    for cb in combos or []:
        names = cb.get("cards") or []
        if len(names) == 2 and all(n in cost for n in names):
            value = sum(cost[n] for n in names)
            if value <= COMBO_MAX and (combo is None or value < combo["mana_value"]):
                combo = {"cards": names, "mana_value": value}
    return {"effective": round(effective, 1), "discounts": discounts, "reducers": reducers_hit, "combo": combo}


def total(stats: dict[str, Any]) -> tuple[float, bool]:
    """(total mana value, exact). Checks before ``total_mana_value`` existed only stored the
    average of the non-land cards; that gives the total without the commanders (not exact)."""
    if stats.get("total_mana_value") is not None:
        return float(stats["total_mana_value"]), True
    nonland = int(stats.get("card_count") or 0) - int((stats.get("types") or {}).get("Land", 0))
    return float(stats.get("avg_cmc_nonland") or 0) * max(nonland, 0), False


def rate(deck: dict[str, Any], tempo: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """``{total, effective, key, label, text, summary, average, cards, complete, exact, discounts,
    reducers, combo, scale, tiers}`` or None when the deck has not been checked yet. ``tempo``
    (an ``analyse()`` result) overrides the stored one, for checks made before it existed."""
    validation = deck.get("validation") or {}
    stats = validation.get("stats") or {}
    if not stats.get("card_count"):
        return None
    value, exact = total(stats)
    value = round(value)
    tempo = tempo or stats.get("tempo") or {}
    effective = round(tempo["effective"]) if tempo.get("effective") is not None else value
    key, label, text = tier(effective)
    combo = tempo.get("combo")
    keys = [k for _, k, _, _ in TIERS]
    lifted = bool(combo) and keys.index(key) > keys.index(COMBO_TIER)
    if lifted:
        key, label, text = next((k, lab, t) for _, k, lab, t in TIERS if k == COMBO_TIER)
        text = f"Eine günstige 2-Karten-Combo ({' + '.join(combo['cards'])}) kann früh gewinnen. {text}"
    cards = int(stats["card_count"]) + len(validation.get("commanders") or deck.get("commanders") or [])
    complete = cards >= FULL_DECK
    summary = f"{label} – Gesamt-Manawert {value}" + (f", effektiv {effective}" if effective != value else "")
    if not complete:
        summary += f" bei erst {cards} von {FULL_DECK} Karten"
    return {
        "total": value, "effective": effective, "key": key, "label": label, "text": text, "summary": summary,
        "average": stats.get("avg_cmc_nonland"), "cards": cards, "complete": complete, "exact": exact,
        "discounts": tempo.get("discounts") or [], "reducers": tempo.get("reducers") or [], "combo": combo,
        "combo_lifted": lifted,
        "analysed": bool(tempo), "scale": list(SCALE),
        "tiers": [{"key": k, "label": lab, "max": None if top == float("inf") else top} for top, k, lab, _ in TIERS],
    }  # fmt: skip


def line(deck: dict[str, Any]) -> str:
    """One line for Rule 0 and the phone: „Schnell (Gesamt-Manawert 182, effektiv 158)“."""
    r = rate(deck)
    if not r:
        return ""
    out = f"{r['label']} (Gesamt-Manawert {r['total']}"
    if r["effective"] != r["total"]:
        out += f", effektiv {r['effective']}"
    elif r["average"]:
        out += f", Ø {fmt.num(float(r['average']))}"
    if r["combo"]:
        out += f", Combo {' + '.join(r['combo']['cards'])}"
    return out + ("" if r["complete"] else f", erst {r['cards']} Karten") + ")"
