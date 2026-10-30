import sqlite3
from contextlib import closing

from conftest import card, deck_lines, save_deck
from fastapi.testclient import TestClient

from mtgdeck import buylist, cardmarket, carddb, collection, storage
from mtgdeck.gui.app import app

DECK = {"slug": "x", "name": "X", "commanders": ["Meren of Clan Nel Toth"],
        "cards": [{"name": "Sol Ring", "qty": 1}, {"name": "Cultivate", "qty": 1}, {"name": "Swamp", "qty": 30}]}  # fmt: skip


async def test_buylist_prices_the_cheapest_playable_printing():
    r = await buylist.build(DECK)
    items = {i["name"]: i for i in r["items"]}
    assert set(items) == {"Meren of Clan Nel Toth", "Sol Ring", "Cultivate"}  # basics left out
    sol = items["Sol Ring"]  # the oversized product 100 is cheaper but not a deck card
    assert (sol["set_name"], sol["collector_number"], sol["trend"], sol["low"]) == ("Commander 2021", "263", 0.9, 0.5)
    assert sol["url"].endswith("idProduct=101") and sol["source"] == "cardmarket"
    assert items["Cultivate"]["source"] == "scryfall" and items["Cultivate"]["trend"] == 0.5  # not on Cardmarket's list
    assert r["total_trend"] == 1.5 + 0.9 + 0.5 and r["cards"] == 3
    assert r["price_date"] == "2026-10-16T02:42:33+02:00" and r["error"] is None
    assert [i["name"] for i in r["items"]][0] == "Meren of Clan Nel Toth"  # most expensive first


async def test_buylist_skips_real_cards_and_optionally_proxies():
    await collection.add([{"name": "Sol Ring"}, {"name": "Meren of Clan Nel Toth", "proxy": True}])
    with_proxies = {i["name"]: i for i in (await buylist.build(DECK))["items"]}
    assert "Sol Ring" not in with_proxies and with_proxies["Meren of Clan Nel Toth"]["proxy"] == 1
    keep = {i["name"] for i in (await buylist.build(DECK, replace_proxies=False))["items"]}
    assert keep == {"Cultivate"}


async def test_buylist_falls_back_to_scryfall_without_cardmarket(monkeypatch):
    monkeypatch.setattr(cardmarket, "GUIDE_URL", "https://downloads.s3.cardmarket.com/missing.json")
    r = await buylist.build(DECK)
    assert "Cardmarket" in r["error"] and {i["source"] for i in r["items"]} == {"scryfall"}


def test_candidates_skip_printings_with_a_stale_trend():
    """Summer Magic Birds of Paradise: a trend of 3 € but no copy under 8.000 € must not be the pick."""
    idx = cardmarket.build_index(
        {"priceGuides": [{"idProduct": 1, "trend": 3.0, "low": 8000.0}, {"idProduct": 2, "trend": 3.4, "low": 2.5}, {"idProduct": 3, "trend": 9.7, "low": 17.0}]},
        {"products": [{"idProduct": i, "name": "Birds of Paradise"} for i in (1, 2, 3)]},
    )
    assert [p["id"] for p in cardmarket.candidates(idx, "Birds of Paradise")] == [2, 3, 1]  # 17 € low vs 9,70 € trend is normal


def test_candidates_find_double_faced_names():
    idx = cardmarket.build_index(
        {"priceGuides": [{"idProduct": 1, "trend": 0.3, "low": 0.1}, {"idProduct": 2, "trend": None, "low": None, "trend-foil": 2.0}]},
        {"products": [{"idProduct": 1, "name": "Delver of Secrets / Insectile Aberration"}, {"idProduct": 2, "name": "Fire // Ice"}]},
    )
    assert cardmarket.candidates(idx, "Delver of Secrets // Insectile Aberration")[0]["id"] == 1
    assert cardmarket.candidates(idx, "Delver of Secrets")[0]["id"] == 1
    assert cardmarket.candidates(idx, "Fire // Ice") == [{"id": 2, "expansion": None, "trend": 2.0, "low": None}]  # foil only
    assert cardmarket.build_index({"oops": 1}, None) == {"date": None, "cards": {}, "ids": {}}


def test_card_db_maps_cardmarket_products():
    sol = dict(card("Sol Ring"), cardmarket_id=101, set="c21", set_name="Commander 2021", collector_number="263")
    big = dict(card("Sol Ring"), cardmarket_id=100, set="oc15", set_name="Oversized", collector_number="1", oversized=True)
    with closing(carddb._connect()) as conn, conn:
        carddb._import_cards(conn, [sol, big])
    got = carddb.cardmarket_prints([100, 101, 999])
    assert got[101] == {"set": "c21", "set_name": "Commander 2021", "collector_number": "263", "playable": True}
    assert got[100]["playable"] is False and 999 not in got


async def test_buylist_route():
    await save_deck(name="Kauf", commanders=["Meren of Clan Nel Toth"], bracket=2,
                    cards=[{"name": l.split(" ", 1)[1], "qty": int(l.split(" ", 1)[0])} for l in deck_lines()])  # fmt: skip
    client = TestClient(app)
    r = client.get("/api/decks/kauf/buylist").json()
    assert r["name"] == "Kauf" and r["cards"] > 0 and all(i["name"] not in collection.BASIC_LANDS for i in r["items"])
    assert client.get("/api/decks/nope/buylist").status_code == 404


async def test_buylist_counts_only_collection_cards_no_other_deck_uses():
    await collection.add([{"name": "Sol Ring"}, {"name": "Cultivate"}, {"name": "Filler 0", "qty": 2}])
    await save_deck(name="Anderes", commanders=["Meren of Clan Nel Toth"], bracket=2,
                    cards=[{"name": l.split(" ", 1)[1], "qty": int(l.split(" ", 1)[0])} for l in deck_lines()])  # fmt: skip
    deck = {**DECK, "cards": DECK["cards"] + [{"name": "Filler 0", "qty": 1}]}
    items = {i["name"]: i for i in (await buylist.build(deck))["items"]}
    assert items["Sol Ring"]["in_decks"] == ["Anderes"]  # the one copy is sleeved up in "Anderes"
    assert items["Sol Ring"]["decks"] == [{"slug": "anderes", "qty": 1, "planned": False}]
    assert items["Meren of Clan Nel Toth"]["decks"] == [{"slug": "anderes", "qty": 1, "planned": True}]  # listed there, no copy anywhere
    assert "Filler 0" not in items  # 2 copies: one for "Anderes", one free for this deck
    whole = await buylist.build(deck, use_collection=False)
    assert {i["name"] for i in whole["items"]} == {"Meren of Clan Nel Toth", "Sol Ring", "Cultivate", "Filler 0"}
    assert whole["use_collection"] is False and whole["other_decks"] == [{"slug": "anderes", "name": "Anderes", "shelved": False}]
    assert {i["name"]: i["decks"] for i in whole["items"]}["Sol Ring"] == [{"slug": "anderes", "qty": 1, "planned": False}]  # also without the collection check


async def test_buylist_card_only_planned_in_another_deck_is_not_there():
    """Flo's Marsh Flats: another deck lists it, but no copy is in the collection, so it lies nowhere and must be bought."""
    await collection.add([{"name": "Sol Ring"}])
    await save_deck(name="Anderes", commanders=["Atraxa, Praetors' Voice"], bracket=2,
                    cards=[{"name": "Filler 7", "qty": 1}, {"name": "Sol Ring", "qty": 1}])  # fmt: skip
    deck = {**DECK, "cards": DECK["cards"] + [{"name": "Filler 7", "qty": 1}]}
    for use in (True, False):
        items = {i["name"]: i for i in (await buylist.build(deck, use_collection=use))["items"]}
        assert items["Filler 7"]["decks"] == [{"slug": "anderes", "qty": 1, "planned": True}] and items["Filler 7"]["places"] == {}
        assert items["Sol Ring"]["decks"] == [{"slug": "anderes", "qty": 1, "planned": False}]  # the own copy may be sleeved up there


async def test_buylist_counts_copies_placed_in_this_deck():
    """Flo's Finale of Devastation: the one copy lies in this deck, two other decks also play the card."""
    for name in ("Anderes", "Drittes"):
        await save_deck(name=name, commanders=["Atraxa, Praetors' Voice"], bracket=2, cards=[{"name": "Cultivate", "qty": 1}, {"name": "Sol Ring", "qty": 1}])
    await collection.add([{"name": "Cultivate"}], place="X", place_deck="x")  # x = DECK's slug
    await collection.add([{"name": "Sol Ring"}], place="Anderes", place_deck="anderes")  # Anderes' own copy
    await collection.add([{"name": "Sol Ring"}])  # unplaced: Drittes takes it
    items = {i["name"]: i for i in (await buylist.build(DECK))["items"]}
    assert "Cultivate" not in items  # placed here, even though two played decks list it
    assert items["Sol Ring"]["qty"] == 1  # Anderes holds its copy, the loose one goes to Drittes
    await collection.add([{"name": "Sol Ring", "foil": True}], place="X", place_deck="x")
    assert "Sol Ring" not in {i["name"] for i in (await buylist.build(DECK))["items"]}
    assert {i["name"] for i in (await buylist.build(DECK, use_collection=False))["items"]} >= {"Cultivate", "Sol Ring"}


async def test_buylist_lists_copies_by_place():
    await collection.add([{"name": "Sol Ring", "qty": 2}], place="Bulk")
    await collection.add([{"name": "Sol Ring", "proxy": True}], place="bulk")  # same place, other spelling
    await collection.add([{"name": "Cultivate"}], place="Ordner rot")
    await save_deck(name="Anderes", commanders=["Atraxa, Praetors' Voice"], bracket=2, cards=[{"name": "Filler 1", "qty": 1}])
    await collection.add([{"name": "Filler 1"}], place="Anderes", place_deck="anderes")
    deck = {**DECK, "cards": DECK["cards"] + [{"name": "Filler 1", "qty": 1}]}
    r = await buylist.build(deck, use_collection=False)
    items = {i["name"]: i for i in r["items"]}
    assert items["Sol Ring"]["places"] == {"ort:bulk": {"real": 2, "proxy": 1}}
    assert items["Cultivate"]["places"] == {"ort:ordner rot": {"real": 1, "proxy": 0}}
    assert items["Filler 1"]["places"] == {"deck:anderes": {"real": 1, "proxy": 0}}
    assert [(p["key"], p["kind"]) for p in r["places"]] == [("ort:bulk", "place"), ("ort:ordner rot", "place"), ("deck:anderes", "deck")]
    assert r["places"][0]["label"] == "Bulk"
