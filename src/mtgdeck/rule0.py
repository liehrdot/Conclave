"""Rule-0 text: what you tell the table before the game ("Rule 0" conversation), built from the
stored deck check without AI – level, play style, Game Changers, combos, tutors, extra turns,
land destruction, expected speed, proxies and house rules.
"""

from __future__ import annotations

from typing import Any

from . import brackets, speed, storage


# every text Rule 0 writes itself; ``build(lang="en")`` is for the native phone apps (the web app stays German)
TEXT: dict[str, dict[str, str]] = {
    "de": {
        "more": " und {n} weitere", "none": "keine", "estimate": " · Einschätzung {v}", "mood": "Stimmung",
        "level": "Stufe", "commander": "Commander", "style": "Spielweise", "tempo": "Tempo", "game_end": "frühestes Spielende nach Bracket: {v}",
        "game_changers": "Game Changer", "combos": "2-Karten-Combos", "tutors": "Tutoren", "extra_turns": "Extra-Züge",
        "land_destruction": "Land-Zerstörung", "proxies": "Proxys", "proxy_deck": "Proxy-Deck – enthält selbst gedruckte Karten",
        "table_rule": "Tischregel", "kept": "eingehalten", "broken": "{n} Verstoß/Verstöße", "house_rules": "Hausregeln",
        "max_game_changers": "max. {n} Game Changer", "max_tutors": "max. {n} Tutoren",
        "no_combos": "keine 2-Karten-Combos", "no_extra_turns": "keine Extra-Züge",
        "no_land_denial": "keine Massen-Landzerstörung", "question": "Passt das für eure Runde?",
    },
    "en": {
        "more": " and {n} more", "none": "none", "estimate": " · estimate {v}", "mood": "Mood",
        "level": "Level", "commander": "Commander", "style": "Play style", "tempo": "Speed", "game_end": "earliest game end by bracket: {v}",
        "game_changers": "Game Changers", "combos": "Two-card combos", "tutors": "Tutors", "extra_turns": "Extra turns",
        "land_destruction": "Land destruction", "proxies": "Proxies", "proxy_deck": "Proxy deck – contains self-printed cards",
        "table_rule": "Table rule", "kept": "followed", "broken": "{n} violation(s)", "house_rules": "House rules",
        "max_game_changers": "max. {n} Game Changers", "max_tutors": "max. {n} tutors",
        "no_combos": "no two-card combos", "no_extra_turns": "no extra turns",
        "no_land_denial": "no mass land denial", "question": "Does this fit your table?",
    },
}  # fmt: skip


def _names(items: list[str], limit: int = 6, lang: str = "de") -> str:
    more = TEXT[lang]["more"].format(n=len(items) - limit)
    return ", ".join(items[:limit]) + (more if len(items) > limit else "")


def _first_sentence(text: str, limit: int = 180) -> str:
    text = " ".join((text or "").split())
    cut = next((i + 1 for i, ch in enumerate(text) if ch in ".!?" and i > 20), len(text))
    text = text[:cut]
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _house_rules(profile: dict[str, Any], lang: str = "de") -> list[str]:
    t = TEXT[lang]
    out = []
    if profile.get("max_game_changers") is not None:
        out.append(t["max_game_changers"].format(n=profile["max_game_changers"]))
    if profile.get("max_tutors") is not None:
        out.append(t["max_tutors"].format(n=profile["max_tutors"]))
    for key, text in (("allow_two_card_combos", "no_combos"), ("allow_extra_turns", "no_extra_turns"),
                      ("allow_mass_land_denial", "no_land_denial")):  # fmt: skip
        if profile.get(key) is False:
            out.append(t[text])
    return out


def build(deck: dict[str, Any], lang: str = "de") -> dict[str, Any]:
    """``{"title", "rows": [{"label", "value", "flag"}], "text"}`` – ``flag`` marks rows the table
    should know about (Game Changers, combos, extra turns, land destruction); ``text`` is the
    copyable plain-text version. ``lang`` is ``"de"`` or ``"en"`` (the deck's own texts stay as written)."""
    t = TEXT[lang]
    en = lang == "en"
    v = deck.get("validation") or {}
    b = v.get("bracket") or {}
    number = int(deck.get("bracket") or b.get("target") or 3)
    rules = brackets.BY_NUMBER.get(number, brackets.BY_NUMBER[3])
    power = b.get("power") or {}
    profile = deck.get("power_profile") or {}
    rows: list[dict[str, Any]] = []

    def row(label: str, value: str, flag: bool = False) -> None:
        rows.append({"label": t[label], "value": value, "flag": flag})

    def names(items: list[str], limit: int = 6) -> str:
        return _names(items, limit, lang)

    level = f"{storage.level_text(deck, lang)} ({rules['name']})"
    if power.get("value"):
        value = f"{power['value']:.1f}"
        level += t["estimate"].format(v=value if en else value.replace(".", ","))
    row("level", level)
    row("commander", " + ".join(deck.get("commanders") or []) or "?")
    style = _first_sentence(deck.get("description") or deck.get("strategy") or "")
    if profile.get("style"):
        style = f"{style} {t['mood']}: {profile['style']}.".strip()
    if style:
        row("style", style)
    pace = speed.line(deck, lang)
    end = rules["earliest_game_end_en" if en else "earliest_game_end"]
    row("tempo", f"{pace + ' · ' if pace else ''}{t['game_end'].format(v=end)}")

    gc = b.get("game_changers") or []
    row("game_changers", f"{len(gc)}: {names(gc)}" if gc else t["none"], bool(gc))
    combos = b.get("two_card_combos") or []
    if combos:
        text = "; ".join(" + ".join(c.get("cards") or ["?"]) + (f" ({', '.join(p for p in c['produces'] if p)[:60]})" if any(c.get("produces") or []) else "")
                         for c in combos[:4])  # fmt: skip
        row("combos", text, True)
    else:
        row("combos", t["none"])
    tutors = b.get("tutors") or []
    row("tutors", f"{len(tutors)}: {names(tutors, 4)}" if tutors else t["none"], len(tutors) >= 4)
    extra = b.get("extra_turns") or []
    row("extra_turns", names(extra) if extra else t["none"], bool(extra))
    mld = b.get("mass_land_denial") or []
    row("land_destruction", names(mld) if mld else t["none"], bool(mld))
    if deck.get("proxy"):
        row("proxies", t["proxy_deck"], True)
    table = v.get("table_rule") or {}
    if table.get("name"):
        state = t["kept"] if table.get("compliant") else t["broken"].format(n=len(table.get("violations") or []))
        quoted = f"“{table['name']}”" if en else f"„{table['name']}“"
        row("table_rule", f"{quoted} – {state}", not table.get("compliant"))
    rules_text = _house_rules(profile, lang)
    if rules_text:
        row("house_rules", ", ".join(rules_text))

    title = f"{deck.get('name', deck.get('slug', 'Deck'))} – Rule 0"
    lines = [title] + [f"{r['label']}: {r['value']}" for r in rows] + [t["question"]]
    return {"title": title, "rows": rows, "text": "\n".join(lines)}
