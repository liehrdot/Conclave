"""Opening hand rating for the Testen tab: keep, borderline or mulligan, with the reasons.

Rules and numbers, no AI. The building blocks come from published Commander mulligan advice:
- Frank Karsten (TCGplayer, "Optimal mana curve … for Commander", "How many sources … 2022"):
  keep 3–5 lands on the free 7, 2–4 lands after a real mulligan, Sol Ring rescues a short hand,
  bottom extra rocks first, then lands down to 3, then the most expensive spells.
- EDHREC / topdeck.gg / playgroup.gg: 2–4 lands with the right colours, a play before turn 4,
  rocks and dorks count like lands; fast decks (cEDH) need fast mana, a tutor or a combo piece.

A hand is played out for a few turns with a deterministic goldfish (lands from the hand, the
library's expected land draws, ramp, then the cheapest spells), and the odds of hitting the land
drops come from the hypergeometric distribution of the remaining library. The score is compared
with random hands of the same deck (``deck_profile``), so a hand is judged against what this
deck usually draws – a 28-land cEDH deck and a 40-land battlecruiser get different baselines.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass, field
from math import comb
from typing import Any

from . import speed as speed_mod

COLORS = "WUBRG"
COLOR_NAMES = {"W": "Weiß", "U": "Blau", "B": "Schwarz", "R": "Rot", "G": "Grün"}
BASIC_TYPES = {"Plains": "W", "Island": "U", "Swamp": "B", "Mountain": "R", "Forest": "G"}
TURNS = 6  # the goldfish plays this many turns (a 6-drop commander still gets its turn)
SAMPLES = 600  # random hands per deck for the comparison
KEEP, BORDER = 62, 45  # score thresholds for a 7-card hand ("Behalten" / "Grenzfall")
FAST_SPEEDS = {"very-fast", "fast"}
SLOW_SPEEDS = {"steady", "slow"}
PLAN_CATEGORIES = {"Win Condition", "Synergy"}

_ADD = re.compile(r"add ((?:\{[^}]+\})+)", re.I)  # "Add {C}{C}": the amount
_ADD_ANY = re.compile(r"add (\{[^.]*)", re.I)  # "Add {B} or {G}": the colours
_TAP_ADD = re.compile(r"(?<![\"'“])\{T\}(?:, [^:.]*)?: add ([^.]*)", re.I)  # "{T}: Add {C}{C}." – mana every turn
_ANY_COLOR = re.compile(r"add [^.]*?(mana of any (one )?(color|type)|any combination of colors)|mana of any color", re.I)
_SEARCH_LAND = re.compile(r"search your library for [^.]*?(land|forest|plains|island|swamp|mountain)", re.I)
_PUT_LAND = re.compile(r"put (a|up to \w+) land cards? from your hand onto the battlefield", re.I)
_TAPPED = re.compile(r"enters( the battlefield)? tapped", re.I)
_UNLESS = re.compile(r"enters( the battlefield)? tapped unless", re.I)
_PIP = re.compile(r"\{([^}]+)\}")


@dataclass
class Card:
    name: str
    mv: int = 0
    land: bool = False  # the front can be played as a land
    flex: bool = False  # a spell with a land on the back (modal double-faced)
    tapped: bool = False
    colors: set[str] = field(default_factory=set)  # mana it can make
    pips: list[set[str]] = field(default_factory=list)  # coloured symbols of its cost
    ramp: int = 0  # extra mana per turn once it resolved
    ramp_kind: str = ""  # "rock" (now), "dork" (next turn), "land" (a land, usually tapped)
    roles: set[str] = field(default_factory=set)
    combo: bool = False
    plan: bool = False

    @property
    def spell(self) -> bool:
        return not self.land

    @property
    def fast_mana(self) -> bool:
        return self.ramp > 0 and self.mv <= 1


def _front(text: str) -> str:
    return (text or "").split("//")[0]


def _symbols(text: str) -> list[str]:
    return [s.upper() for s in _PIP.findall(text or "")]


def card_from(data: dict[str, Any], *, deck_colors: set[str], combo: bool = False, plan: bool = False) -> Card:
    """Turn compact card data (``scryfall.compact`` + ``roles``) into what the goldfish needs."""
    type_line = data.get("type_line") or ""
    front_type = _front(type_line)
    text = data.get("oracle_text") or ""
    front_text = _front(text)
    land = "Land" in front_type
    c = Card(
        name=data.get("name") or "?", mv=int(data.get("cmc") or 0), land=land,
        flex=not land and "Land" in type_line, roles=set(data.get("roles") or []), combo=combo, plan=plan,
    )  # fmt: skip
    for sym in _symbols(_front(data.get("mana_cost") or "")):
        options = {p for p in sym.split("/") if p in COLORS}
        if options and "P" not in sym.split("/"):
            c.pips.append(options)
    makes = set()
    for group in _ADD_ANY.findall(front_text):
        makes |= {s for s in _symbols(group) if s in COLORS}
    if _ANY_COLOR.search(front_text):
        makes |= deck_colors
    if land:
        makes |= {col for word, col in BASIC_TYPES.items() if word in front_type}
        if _SEARCH_LAND.search(front_text):  # fetch lands
            named = {col for word, col in BASIC_TYPES.items() if word in front_text}
            makes |= named or deck_colors
        c.tapped = bool(_TAPPED.search(front_text)) and not _UNLESS.search(front_text)
        c.colors = makes & (deck_colors or set(COLORS))
        return c
    if "ramp" in c.roles or _ADD.search(front_text):
        permanent = not re.search(r"\b(Instant|Sorcery)\b", front_type)
        if _SEARCH_LAND.search(front_text) or _PUT_LAND.search(front_text):
            c.ramp, c.ramp_kind = 1, "land"
            c.colors = deck_colors
        elif permanent and (tap := _TAP_ADD.search(front_text)):  # rocks and dorks; not sacrifice outlets
            c.ramp = 2 if tap.group(1).upper().startswith("{C}{C}") else 1
            c.ramp_kind = "dork" if "Creature" in front_type else "rock"
            c.colors = {s for s in _symbols(tap.group(1)) if s in COLORS} & deck_colors
            if _ANY_COLOR.search(tap.group(0)):
                c.colors = set(deck_colors)
    return c


@dataclass
class Deck:
    """What a hand is judged against: the library, the commanders and the deck's speed."""

    cards: list[Card]  # the 99 (one entry per copy)
    commanders: list[Card]
    colors: set[str]
    speed: str = ""  # speed.TIERS key
    combos: list[set[str]] = field(default_factory=list)


def build_deck(deck: dict[str, Any], card_data: dict[str, dict[str, Any]]) -> Deck:
    commanders = deck.get("commanders") or []
    colors = {col for n in commanders for col in (card_data.get(n) or {}).get("color_identity") or []} or set(COLORS)
    combos = [set(c.get("cards") or []) for c in ((deck.get("validation") or {}).get("combos") or {}).get("included") or []]
    combos = [c for c in combos if c]
    pieces = set().union(*combos) if combos else set()
    cards: list[Card] = []
    for entry in deck.get("cards") or []:
        data = card_data.get(entry["name"]) or {"name": entry["name"]}
        c = card_from(data, deck_colors=colors, combo=entry["name"] in pieces, plan=entry.get("category") in PLAN_CATEGORIES)
        cards += [c] * int(entry.get("qty") or 1)
    cmdrs = [card_from(card_data.get(n) or {"name": n}, deck_colors=colors, combo=n in pieces) for n in commanders]
    speed = (speed_mod.rate(deck) or {}).get("key") or ""
    return Deck(cards=cards, commanders=cmdrs, colors=colors, speed=speed, combos=combos)


# --- goldfish ------------------------------------------------------------------------------------


def _draws(turn: int, on_draw: bool) -> int:
    return turn if on_draw else turn - 1


def _pay(card: Card, sources: list[set[str]]) -> list[set[str]] | None:
    """The sources left after paying for ``card`` (one entry per mana), or None if it cannot be
    paid: every coloured pip needs a source of its colour (scarcest pip first), the rest is generic
    and uses the least flexible sources."""
    if card.mv > len(sources):
        return None
    free = sorted(sources, key=len)
    for options in sorted(card.pips, key=len):
        pick = next((i for i, s in enumerate(free) if s & options), None)
        if pick is None:
            return None
        free.pop(pick)
    return free[max(0, card.mv - len(card.pips)):]


@dataclass
class Goldfish:
    cast: dict[int, list[str]]  # turn -> spells cast
    mana: dict[int, int]  # turn -> mana available
    commander_turn: int | None


def typical_land(library: list[Card]) -> set[str]:
    """The colours a drawn land usually makes: those most of the library's lands make (none for a
    deck of mono-coloured basics – the goldfish does not count on drawing the right colour)."""
    lands = [c for c in library if c.land]
    return {col for col in COLORS if lands and sum(col in c.colors for c in lands) / len(lands) > 0.5}


def goldfish(hand: list[Card], deck: Deck, *, land_ratio: float, on_draw: bool, drawn_colors: set[str] | None = None) -> Goldfish:
    """Play the hand alone for ``TURNS`` turns: a land per turn (drawn lands at the library's rate),
    then ramp, then the cheapest spells. Rocks tap at once, dorks and fetched lands next turn."""
    lands = sorted((c for c in hand if c.land), key=lambda c: (not c.tapped, -len(c.colors)))
    flex = [c for c in hand if c.flex]
    spells = sorted((c for c in hand if c.spell), key=lambda c: (c.ramp == 0, c.mv))
    ready: list[set[str]] = []  # one entry per mana the board makes
    pending: list[set[str]] = []  # entered this turn, ready next turn
    cast: dict[int, list[str]] = {}
    mana_by_turn: dict[int, int] = {}
    commander = max(deck.commanders, key=lambda c: c.mv, default=None)
    commander_turn = None
    drawn = 0
    drawn_colors = set(deck.colors) if drawn_colors is None else drawn_colors
    for turn in range(1, TURNS + 1):
        ready += pending
        pending = []
        while drawn < int(_draws(turn, on_draw) * land_ratio + 0.5):  # the expected land draws, rounded
            lands.append(Card(name="(gezogenes Land)", land=True, colors=drawn_colors))
            drawn += 1
        if lands:
            land = lands.pop(0) if turn == 1 else _pick_land(lands, spells, ready)
            (pending if land.tapped else ready).append(land.colors or {"C"})
        elif any(f in spells for f in flex):  # play a spell's land back side instead
            spells.remove(next(f for f in flex if f in spells))
            ready.append(set(deck.colors))
        mana_by_turn[turn] = len(ready)
        if commander and commander_turn is None and _pay(commander, ready) is not None:
            commander_turn = turn
        left = list(ready)
        for s in list(spells):
            rest = _pay(s, left)
            if rest is None:
                continue
            left = rest
            spells.remove(s)
            cast.setdefault(turn, []).append(s.name)
            made = [s.colors or {"C"}] * s.ramp
            if s.ramp_kind == "rock":
                ready += made
                left += made
            else:
                pending += made
    return Goldfish(cast=cast, mana=mana_by_turn, commander_turn=commander_turn)


def _pick_land(lands: list[Card], spells: list[Card], sources: list[set[str]]) -> Card:
    """Prefer a land that adds a colour the hand still needs, then an untapped one."""
    have = set().union(*sources) if sources else set()
    needed = {col for s in spells for p in s.pips for col in p} - have
    best = max(lands, key=lambda c: (len(c.colors & needed), not c.tapped))
    lands.remove(best)
    return best


# --- odds ---------------------------------------------------------------------------------------


def p_at_least(population: int, successes: int, draws: int, need: int) -> float:
    if need <= 0:
        return 1.0
    draws = max(0, min(draws, population))
    if population <= 0 or draws == 0:
        return 0.0
    total = comb(population, draws)
    hit = sum(comb(successes, k) * comb(population - successes, draws - k) for k in range(need, min(draws, successes) + 1))
    return hit / total


# --- rating -------------------------------------------------------------------------------------


@dataclass
class Rating:
    score: int
    fatal: str = ""
    good: list[str] = field(default_factory=list)
    bad: list[str] = field(default_factory=list)
    facts: dict[str, Any] = field(default_factory=dict)


def _library(hand: list[Card], deck: Deck) -> list[Card]:
    left = list(deck.cards)
    for c in hand:
        for i, d in enumerate(left):
            if d.name == c.name:
                left.pop(i)
                break
    return left


def _names(cards: list[Card] | list[str], most: int = 3) -> str:
    names = list(dict.fromkeys(c if isinstance(c, str) else c.name for c in cards))
    return ", ".join(names[:most]) + (f" und {len(names) - most} weitere" if len(names) > most else "")


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def score_hand(hand: list[Card], deck: Deck, *, on_draw: bool = False) -> Rating:
    """Score 0–100 (higher = better keep) plus the reasons in German."""
    library = _library(hand, deck)
    lib_lands = sum(1 for c in library if c.land)
    ratio = lib_lands / len(library) if library else 0.0
    fast, slow = deck.speed in FAST_SPEEDS, deck.speed in SLOW_SPEEDS
    lands = [c for c in hand if c.land]
    flex = [c for c in hand if c.flex]
    gf = goldfish(hand, deck, land_ratio=ratio, on_draw=on_draw, drawn_colors=typical_land(library))
    early = [n for t in (1, 2, 3) for n in gf.cast.get(t, [])]
    by_two = [n for t in (1, 2) for n in gf.cast.get(t, [])]
    ramp = [c for c in hand if c.spell and c.ramp and c.name in early]  # ramp the hand can actually cast early
    n_lands, size = len(lands), len(hand)
    r = Rating(score=50)
    good, bad = r.good, r.bad

    # 1. lands (Karsten: 3–5 on a 7; fewer cards → 2–4 are fine)
    usable = n_lands + len(flex)
    base = {0: -60, 1: -25, 2: -6, 3: 10, 4: 10, 5: 3, 6: -18, 7: -60}[min(usable, 7)]
    if size <= 6 and usable == 2:
        base = 4
    if fast and usable == 2:
        base = 2
    if fast and usable == 5:
        base = -8
    if slow and usable == 5:
        base = 4
    r.score += base
    land_text = _plural(n_lands, "Land", "Länder") + (f" + {len(flex)} Zauber mit Land-Rückseite" if flex else "")
    if usable in (3, 4) or (usable == 2 and size <= 6):
        good.append(f"{land_text} – genau richtig.")
    elif usable == 2 and ramp:
        good.append(f"{land_text} plus Ramp – das reicht.")
    elif usable == 0:
        r.fatal = "Kein Land: die Hand kann nichts spielen."
    elif usable >= 7 or (usable >= 6 and not any(c.spell for c in hand)):
        r.fatal = "Nur Länder: die Hand macht nichts außer Mana."
    elif usable == 1:
        bad.append(f"Nur {land_text}.")
    elif usable >= 6:
        bad.append(f"{land_text}: kaum Zauber, die Hand flutet.")
    elif usable == 5:
        (good if slow else bad).append(f"{land_text}: {'für ein langsames Deck in Ordnung' if slow else 'eher viel'}.")
    else:
        bad.append(f"Nur {land_text}: knapp.")

    # 2. ramp (rocks and dorks count like lands; Sol Ring saves a short hand)
    fast_mana = [c for c in ramp if c.fast_mana]
    bonus = min(16, sum(10 if c.fast_mana else 7 for c in ramp)) * (1.5 if slow else 1)
    if usable >= 2 or (usable == 1 and fast_mana):
        r.score += round(bonus)
    if ramp:
        good.append(f"Ramp: {_names(ramp)}.")
    if usable == 1 and (len(ramp) >= 2 or fast_mana) and sum(1 for c in hand if c.spell and c.mv <= 2) >= 2:
        r.score += 22
        good.append("Mit dem Ramp ist der Ein-Länder spielbar.")

    # 3. land drops still to come (hypergeometric on the rest of the library)
    odds = {}
    for t in (3, 4):
        odds[t] = p_at_least(len(library), lib_lands, _draws(t, on_draw), t - n_lands)
    if n_lands < 3 and odds[3] < 0.6 and usable + len(ramp) < 4 and not r.fatal:
        bad.append(f"Landdrops unsicher: 3 Länder bis Zug 3 nur zu {round(odds[3] * 100)} %.")

    # 4. what the hand actually does in the first turns
    if not r.fatal:
        if not early:
            r.score -= 15
            bad.append("Bis Zug 3 kannst du keinen Zauber wirken.")
        elif len(early) >= 2:
            r.score += 8
            good.append(f"Früh etwas zu tun: {_names(early)} bis Zug 3.")
    expensive = sorted((c for c in hand if c.spell and c.mv >= 5), key=lambda c: c.mv)
    if len(expensive) >= 2 and gf.mana.get(4, 0) < 5:
        r.score -= (3 if slow else 5) * (len(expensive) - 1)
        bad.append(f"Viel Teures auf der Hand: {_names(expensive)}.")

    # 5. colours: a spell whose colours the hand cannot make is as good as a missing land
    have = set().union(*(c.colors for c in hand if c.land or c in ramp)) if hand else set()
    if flex:
        have |= deck.colors
    need = {col for c in hand if c.spell for p in c.pips if len(p) == 1 for col in p}
    cmd_need = {col for c in deck.commanders for p in c.pips if len(p) == 1 for col in p}
    missing = sorted(need - have, key=COLORS.index)
    if missing and usable:
        stuck = [c for c in hand if c.spell and any(len(p) == 1 and p <= set(missing) for p in c.pips)]
        r.score -= min(20, 6 * len(stuck))
        for col in missing:
            sources = sum(1 for c in library if c.land and col in c.colors)
            p = p_at_least(len(library), sources, _draws(3, on_draw), 1)
            bad.append(f"{COLOR_NAMES[col]} fehlt für {_names([c for c in stuck if any(col in p for p in c.pips)])} – eine Quelle bis Zug 3 zu {round(p * 100)} %.")
    elif have and need and usable >= 2:
        good.append("Die Farben passen zu den Zaubern auf der Hand.")
    cmd_missing = sorted(cmd_need - have - set(missing), key=COLORS.index)

    # 6. the deck's plan: commander on time, card draw, interaction, tutors, combo pieces
    commander = max(deck.commanders, key=lambda c: c.mv, default=None)
    if commander and 3 <= commander.mv <= TURNS and not r.fatal:
        t = gf.commander_turn
        if t is not None and t <= commander.mv:
            r.score += 6
            good.append(f"{commander.name} schon in Zug {t}." if t < commander.mv else f"{commander.name} pünktlich in Zug {t}.")
        elif t is None or t > commander.mv + 1:
            r.score -= 5
            bad.append(f"{commander.name} kommt spät" + (f" (frühestens Zug {t})." if t else f" (nicht bis Zug {TURNS})."))
    roles = set().union(*(c.roles for c in hand if c.spell)) if hand else set()
    if "card_draw" in roles:
        r.score += 8 if usable >= 5 else 5
        good.append("Kartenzug hält die Hand am Laufen.")
    if roles & {"removal", "counterspell", "board_wipe"}:
        r.score += 4
        good.append("Interaktion dabei.")
    tutors = [c for c in hand if "tutor" in c.roles and c.spell]
    if tutors:
        r.score += 8 if fast else 5
        good.append(f"Tutor: {tutors[0].name} holt, was fehlt.")
    names = {c.name for c in hand} | {c.name for c in deck.commanders}
    complete = [combo for combo in deck.combos if combo <= names]
    pieces = [c for c in hand if c.combo]
    if complete:
        r.score += 15
        good.append(f"Ganze Kombo auf der Hand: {' + '.join(sorted(complete[0]))}.")
    elif pieces:
        r.score += min(12, 6 * len(pieces)) * (2 if fast else 1)
        good.append(f"Kombo-Teil: {_names(pieces)}" + (" – mit Tutor für den Rest." if tutors else "."))
    plan = [c for c in hand if c.plan and not c.combo]
    if plan and not complete:
        r.score += 3
        good.append(f"Spielt den Plan des Decks: {_names(plan)}.")

    # 7. speed of the deck: a fast deck needs a fast start, not just a working hand
    if fast and not r.fatal and not (fast_mana or len(by_two) >= 2 or tutors or pieces):
        r.score -= 12
        bad.append("Für ein schnelles Deck zu langsam: kein schnelles Mana, kein Tutor, kein Kombo-Teil.")

    r.score = max(0, min(100, round(r.score)))
    if r.fatal:
        r.score = min(r.score, 10)
    r.facts = {
        "lands": n_lands, "flex": len(flex), "ramp": len(ramp), "mana_sources": usable + len(ramp),
        "early_plays": len(early), "commander_turn": gf.commander_turn,
        "commander": commander.name if commander else None,
        "colors_missing": [COLOR_NAMES[c] for c in missing], "commander_colors_missing": [COLOR_NAMES[c] for c in cmd_missing],
        "odds": {"lands_by_3": round(odds[3], 3), "lands_by_4": round(odds[4], 3)},
        "mana_by_turn": [gf.mana.get(t, 0) for t in range(1, 5)],
    }  # fmt: skip
    return r


def thresholds(size: int, mulligans: int) -> tuple[int, int]:
    """Smaller hands (after a real mulligan) are kept with less – another mulligan costs a card."""
    cut = 6 * max(0, 7 - size)
    return KEEP - cut, BORDER - cut


def verdict(r: Rating, size: int, mulligans: int) -> tuple[str, str]:
    keep, border = thresholds(size, mulligans)
    if r.fatal or r.score < border:
        if size <= 5:
            return "border", "Grenzfall"  # a 5-card hand rarely gets better by going to 4
        return "mulligan", "Mulligan"
    return ("keep", "Behalten") if r.score >= keep else ("border", "Grenzfall")


def bottom(hand: list[Card], deck: Deck, count: int, *, on_draw: bool = False) -> list[str]:
    """Which cards to put under the library: the ones whose loss hurts the rest of the hand least."""
    rest, out = list(hand), []
    for _ in range(max(0, min(count, len(hand)))):
        best = max(range(len(rest)), key=lambda i: (score_hand(rest[:i] + rest[i + 1:], deck, on_draw=on_draw).score, rest[i].mv))
        out.append(rest.pop(best).name)
    return out


def deck_profile(deck: Deck, *, on_draw: bool = False, samples: int = SAMPLES, seed: int = 44) -> dict[str, Any]:
    """Scores of random 7s from this deck: the baseline a hand is compared with."""
    if len(deck.cards) < 8:
        return {"scores": [], "keep": 0.0, "playable": 0.0}
    rnd = random.Random(seed)  # NOSONAR: seeded on purpose (the same baseline every time), not security
    scores = sorted(score_hand(rnd.sample(deck.cards, 7), deck, on_draw=on_draw).score for _ in range(samples))
    keep, border = thresholds(7, 0)
    return {
        "scores": scores,
        "keep": sum(s >= keep for s in scores) / len(scores),
        "playable": sum(s >= border for s in scores) / len(scores),
    }


def percentile(score: int, scores: list[int]) -> int | None:
    if not scores:
        return None
    below = sum(s < score for s in scores) + sum(s == score for s in scores) / 2
    return round(100 * below / len(scores))


def rate(hand_names: list[str], deck: Deck, *, mulligans: int = 0, on_draw: bool = False, to_bottom: int = 0,
         profile: dict[str, Any] | None = None) -> dict[str, Any]:  # fmt: skip
    """The answer for the GUI. Without cards only ``deck`` (how good this deck's hands usually are)."""
    profile = profile or deck_profile(deck, on_draw=on_draw)
    about = {"keep": round(profile["keep"], 3), "playable": round(profile["playable"], 3), "speed": deck.speed,
             "combos": len(deck.combos)}  # fmt: skip
    if not hand_names:
        return {"deck": about}
    by_name = {c.name: c for c in deck.cards}
    hand = [by_name.get(n) or Card(name=n) for n in hand_names]
    r = score_hand(hand, deck, on_draw=on_draw)
    key, label = verdict(r, len(hand) - to_bottom, mulligans)
    pct = percentile(r.score, profile["scores"]) if len(hand) == 7 else None
    advice = ""
    if key == "border" and mulligans == 0:
        advice = "Der erste Mulligan ist frei – bei einem Grenzfall lohnt sich eine neue Hand."
    elif key == "mulligan" and mulligans >= 1:
        advice = f"Ein weiterer Mulligan kostet eine Karte – du hättest dann noch {max(0, 7 - mulligans)}."
    return {
        "score": r.score, "verdict": key, "label": label, "fatal": r.fatal, "good": r.good, "bad": r.bad,
        "facts": r.facts, "percentile": pct, "advice": advice,
        "bottom": bottom(hand, deck, to_bottom, on_draw=on_draw) if to_bottom else [],
        "deck": about,
    }  # fmt: skip
