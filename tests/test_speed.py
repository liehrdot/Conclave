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
