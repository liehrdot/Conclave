from fastapi.testclient import TestClient

from mtgdeck import backup, collection, selling, settings
from mtgdeck.gui.app import app


async def _sol(qty=3, **extra):
    await collection.add([{"name": "Sol Ring", "scryfall_id": "a1b2-sol", "qty": qty, **extra}])
    return next(e for e in collection.load() if e["name"] == "Sol Ring")


async def test_add_prices_the_exact_printing_with_the_rule():
    e = await _sol()
    r = await selling.add([e["id"]], qty=2)
    assert (r["added"], r["cards"], r["skipped"], r["error"]) == (1, 2, [], None)
    v = await selling.view()
    item = v["items"][0]
    assert item["product_id"] == 101 and item["url"].endswith("idProduct=101")  # c21 #263 via Scryfall's cardmarket_id
    assert (item["trend"], item["low"], item["price"], item["qty"], item["condition"]) == (0.9, 0.5, 0.9, 2, "NM")
    assert (item["lang_id"], item["in_collection"], v["count"]["open"], v["value"]["open"]) == (1, 3, 2, 1.8)
    selling.set_rule("low")
    assert (await selling.view())["items"][0]["price"] == 0.5  # an untouched price follows the rule
    selling.update(item["id"], price=0.777)
    selling.set_rule("trend95")
    assert (await selling.view())["items"][0]["price"] == 0.78  # a typed price stays
    selling.update(item["id"], price=None)
    assert (await selling.view())["items"][0]["price"] == 0.85  # 0.9 × 0.95, rounded to cents


async def test_proxies_and_cards_already_listed_are_skipped():
    e = await _sol()
    await collection.add([{"name": "Meren of Clan Nel Toth", "proxy": True}])
    proxy = next(x for x in collection.load() if x["proxy"])
    await selling.add([e["id"]])
    r = await selling.add([e["id"], proxy["id"]])
    assert r["added"] == 0 and {s["reason"] for s in r["skipped"]} == {"Proxy", "schon auf der Liste"}


async def test_sold_takes_copies_out_and_undo_puts_them_back():
    e = await _sol()
    item = (await selling.add([e["id"]], qty=2)) and selling.load()[0]
    selling.update(item["id"], status="listed", qty=99)
    assert selling.load()[0]["qty"] == 3 and selling.load()[0]["listed_at"]  # never more than the collection has
    selling.update(item["id"], qty=2)
    assert selling.tags()[e["id"]]["status"] == "listed"
    r = selling.sold(item["id"])
    assert r["removed"] == 2 and collection.load()[0]["qty"] == 1 and selling.tags() == {}
    assert selling.sold(item["id"])["removed"] == 0  # twice changes nothing
    back = selling.unsold(item["id"])
    assert back["status"] == "listed" and collection.load()[0]["qty"] == 3 and len(collection.load()) == 1
    assert selling.clear_sold() == 0


async def test_a_merged_entry_keeps_its_sale():
    e = await _sol(qty=1)
    await selling.add([e["id"]])
    collection.bulk_update([e["id"]], place="Binder")
    await collection.add([{"name": "Sol Ring", "scryfall_id": "a1b2-sol"}], place="Binder")  # merges into a new entry
    entry = collection.load()[0]
    assert entry["qty"] == 2 and selling.tags()[entry["id"]]["qty"] == 1


async def test_unknown_printing_falls_back_to_the_search():
    await collection.add([{"name": "Cultivate"}])
    e = collection.load()[0]
    await selling.add([e["id"]])
    item = (await selling.view())["items"][0]
    assert item["product_id"] is None and item["url"] is None and "searchString=Cultivate" in item["search_url"]
    assert item["price"] == 0.5  # Scryfall's price, as Cardmarket's guide has no such product


def test_routes_and_backup():
    with TestClient(app) as client:
        client.post("/api/collection", json={"items": [{"name": "Sol Ring", "scryfall_id": "a1b2-sol", "qty": 2}]})
        eid = client.get("/api/collection").json()["entries"][0]["id"]
        assert client.post("/api/sales", json={"ids": [eid], "condition": "XX"}).status_code == 422
        assert client.post("/api/sales", json={"ids": [eid], "condition": "EX"}).json()["added"] == 1
        item = client.get("/api/sales").json()["items"][0]
        assert item["condition_name"] == "Excellent" and client.get("/api/collection").json()["sales"][eid]["status"] == "open"
        r = client.patch(f"/api/sales/{item['id']}", json={"price": 1.5, "comment": "  wie   neu ", "status": "listed"})
        assert r.json()["item"]["comment"] == "wie neu" and r.json()["item"]["price_custom"] is True
        assert client.put("/api/sales/rule", json={"rule": "low"}).json()["rule"] == "low" and settings.load()["sale_price"] == "low"
        assert client.post(f"/api/sales/{item['id']}/sold").json()["removed"] == 2
        assert client.get("/api/collection").json()["entries"] == []
        assert client.post("/api/sales/nope/sold").status_code == 404
        assert "sales.json" in {n for n, _ in backup._members()}
        assert client.delete("/api/sales/sold").json()["deleted"] == 1


async def test_product_id_comes_from_the_card_db_first():
    from contextlib import closing

    from conftest import card

    from mtgdeck import carddb

    with closing(carddb._connect()) as conn, conn:
        carddb._import_cards(conn, [dict(card("Sol Ring"), cardmarket_id=102, set="c21", set_name="Commander 2021", collector_number="263")])
    assert carddb.cardmarket_ids([("C21", "263"), ("xyz", "1")]) == {("c21", "263"): 102}
    e = await _sol()
    await selling.add([e["id"]])
    assert selling.load()[0]["product_id"] == 102  # no Scryfall lookup needed
