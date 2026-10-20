from conftest import deck_lines

from mtgdeck import rule0, speed
from mtgdeck.sync import appdata
from mtgdeck.validate import validate_deck

MEREN = ["Meren of Clan Nel Toth"]


async def test_total_mana_value_counts_commanders_not_lands():
    r = await validate_deck(MEREN, deck_lines(), 2)
    s = r["stats"]
    assert s["commander_mana_value"] == 4
    assert s["total_mana_value"] == round(s["nonland_mana_value"] + 4, 1)
    nonland = s["card_count"] - s["types"]["Land"]
    assert abs(s["nonland_mana_value"] - s["avg_cmc_nonland"] * nonland) < 1


def test_tiers():
    assert speed.tier(126)[1] == "Sehr schnell"
    assert speed.tier(140)[1] == "Sehr schnell"
    assert speed.tier(158)[1] == "Schnell"
    assert speed.tier(190)[1] == "Zügig"
    assert speed.tier(225)[1] == "Gemächlich"
    assert speed.tier(300)[1] == "Langsam"


def test_rate_from_a_checked_deck():
    deck = {"commanders": MEREN, "validation": {"commanders": MEREN, "stats": {
        "card_count": 99, "types": {"Land": 30}, "avg_cmc_nonland": 1.8, "total_mana_value": 128.0}}}
    r = speed.rate(deck)
    assert (r["total"], r["key"], r["complete"], r["exact"]) == (128, "very-fast", True, True)
    assert speed.line(deck) == "Sehr schnell (Gesamt-Manawert 128, Ø 1,80)"
    rows = {row["label"]: row for row in rule0.build({**deck, "bracket": 4, "slug": "x"})["rows"]}
    assert rows["Tempo"]["value"].startswith("Sehr schnell (Gesamt-Manawert 128")
    assert appdata._deck("x", deck, [])["speed"]["label"] == "Sehr schnell"


def test_rate_old_check_and_unfinished_deck():
    assert speed.rate({}) is None
    old = {"commanders": MEREN, "validation": {"stats": {"card_count": 40, "types": {"Land": 20}, "avg_cmc_nonland": 3.0}}}
    r = speed.rate(old)
    assert (r["total"], r["exact"], r["complete"], r["cards"]) == (60, False, False, 41)
    assert "erst 41 von 100" in r["summary"]


def _card(name, cost, cmc, type_line, text="", pt=None):
    c = {"name": name, "mana_cost": cost, "cmc": cmc, "type_line": type_line, "oracle_text": text}
    return {**c, "pt": pt} if pt else c


GHALTA = _card("Ghalta, Primal Hunger", "{10}{G}{G}", 12, "Legendary Creature — Dinosaur",
               "This spell costs {X} less to cast, where X is the total power of creatures you control.", "12/12")
GORECLAW = _card("Goreclaw, Terror of Qal Sisma", "{3}{G}", 4, "Legendary Creature — Bear",
                 "Creature spells you cast with power 4 or greater cost {2} less to cast.", "4/3")
CRUISE = _card("Treasure Cruise", "{7}{U}", 8, "Sorcery", "Delve (Each card you exile from your graveyard while casting this spell pays for {1}.)\\nDraw three cards.")
BEAST = _card("Big Beast", "{4}{G}{G}", 6, "Creature — Beast", "", "6/6")
ELF = _card("Small Elf", "{G}", 1, "Creature — Elf", "", "1/1")
SPHERE = _card("Sphere of Resistance", "{2}", 2, "Artifact", "Spells cost {1} more to cast.")
FOREST = _card("Forest", "", 0, "Basic Land — Forest")


def test_self_discounts_count_their_pips_or_half():
    a = speed.analyse([CRUISE, BEAST, FOREST], {"Forest": 30}, [GHALTA])
    found = {d["name"]: d["after"] for d in a["discounts"]}
    assert found == {"Ghalta, Primal Hunger": 2, "Treasure Cruise": 4}
    assert a["effective"] == 2 + 4 + 6


def test_deck_wide_reducer_respects_condition_pips_and_cap():
    beasts = [{**BEAST, "name": f"Beast {i}"} for i in range(8)]
    a = speed.analyse([GORECLAW, ELF, SPHERE, *beasts], {}, [])
    (r,) = a["reducers"]
    assert (r["name"], r["amount"], r["cards"], r["saved"]) == ("Goreclaw, Terror of Qal Sisma", 2, 5, speed.REDUCER_CAP)
    assert r["what"] == "Kreatur · Stärke 4+"
    assert speed.reducers(SPHERE) == []  # "more" is no discount


def test_cheap_combo_makes_the_deck_at_least_fast():
    deck = {"commanders": MEREN, "validation": {"commanders": MEREN, "stats": {
        "card_count": 99, "types": {"Land": 36}, "avg_cmc_nonland": 3.6, "total_mana_value": 230.0}}}
    assert speed.rate(deck)["label"] == "Gemächlich"
    tempo = speed.analyse([_card("A", "{1}{B}", 2, "Creature — Human"), _card("B", "{2}{B}", 3, "Artifact")], {}, [],
                          [{"cards": ["A", "B"]}])
    assert tempo["combo"] == {"cards": ["A", "B"], "mana_value": 5}
    r = speed.rate(deck, {**tempo, "effective": 230})
    assert r["label"] == "Schnell" and "A + B" in r["text"]
    assert "Combo A + B" in speed.line({**deck, "validation": {**deck["validation"], "stats": {**deck["validation"]["stats"], "tempo": tempo}}})
