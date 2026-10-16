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


def test_candidates_find_double_faced_names():
    idx = cardmarket.build_index(
        {"priceGuides": [{"idProduct": 1, "trend": 0.3, "low": 0.1}, {"idProduct": 2, "trend": None, "low": None, "trend-foil": 2.0}]},
        {"products": [{"idProduct": 1, "name": "Delver of Secrets / Insectile Aberration"}, {"idProduct": 2, "name": "Fire // Ice"}]},
    )
    assert cardmarket.candidates(idx, "Delver of Secrets // Insectile Aberration")[0]["id"] == 1
    assert cardmarket.candidates(idx, "Delver of Secrets")[0]["id"] == 1
    assert cardmarket.candidates(idx, "Fire // Ice") == [{"id": 2, "expansion": None, "trend": 2.0, "low": None}]  # foil only
    assert cardmarket.build_index({"oops": 1}, None) == {"date": None, "cards": {}}


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
