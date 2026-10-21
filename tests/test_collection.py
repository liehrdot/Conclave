"""My collection: import formats, merging, artwork/proxy/foil, comparison with decks."""

from conftest import deck_lines, save_deck

from mtgdeck import collection, storage

MANABOX = """Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language
Sol Ring,c21,Commander 2021,263,normal,uncommon,2,1,a1b2-sol,1.00,false,false,near_mint,en
Cultivate,m21,Core Set 2021,177,foil,common,1,2,d3e4-cult,0.30,false,false,near_mint,de
"""
MOXFIELD = """"Count","Tradelist Count","Name","Edition","Condition","Language","Foil","Tags","Last Modified","Collector Number","Alter","Proxy","Purchase Price"
"1","0","Demonic Tutor","uma","Near Mint","English","","","2024-01-01","93","False","True",""
"3","0","Forest","","Near Mint","German","","","2024-01-01","","False","False",""
"""


def test_parse_formats():
    mb = collection.parse_import(MANABOX)
    assert mb[0] == {"name": "Sol Ring", "qty": 2, "set": "c21", "collector_number": "263", "scryfall_id": "a1b2-sol",
                     "foil": False, "proxy": False, "lang": "en"}  # fmt: skip
    assert mb[1]["foil"] is True and mb[1]["lang"] == "de"
    mx = collection.parse_import(MOXFIELD)
    assert mx[0]["proxy"] is True and mx[0]["set"] == "uma" and mx[1]["lang"] == "de" and mx[1]["qty"] == 3
    semi = collection.parse_import("Anzahl;Kartenname;Proxy\n2;Sol Ring;ja\n")
    assert semi == [{"name": "Sol Ring", "qty": 2, "set": None, "collector_number": None, "scryfall_id": None,
                     "foil": False, "proxy": True, "lang": None}]  # fmt: skip
    lines = collection.parse_import("# Kommentar\n2x Sol Ring (C21) 263 *F*\nCultivate\n1 Demonic Tutor [proxy]\n")
    assert [(i["name"], i["qty"], i["set"], i["collector_number"], i["foil"], i["proxy"]) for i in lines] == [
        ("Sol Ring", 2, "c21", "263", True, False), ("Cultivate", 1, None, None, False, False), ("Demonic Tutor", 1, None, None, False, True)]


async def test_import_resolves_printings_and_merges():
    r = await collection.import_text(MANABOX)
    assert r == {"added": 3, "entries": 2, "not_found": [], "lines": 2}
    sol = next(e for e in collection.load() if e["name"] == "Sol Ring")
    assert sol["set_name"] == "Set C21" and sol["image"].endswith("a1b2-sol.jpg") and sol["price_eur"] == "1.50"
    cult = next(e for e in collection.load() if e["name"] == "Cultivate")
    assert cult["foil"] and cult["price_eur"] == "4.00" and cult["lang"] == "de"
    await collection.import_text(MANABOX)  # same printings again -> quantities add up
    assert {e["name"]: e["qty"] for e in collection.load()} == {"Sol Ring": 4, "Cultivate": 2}
    r = await collection.import_text("1 Sol Ring\n1 Gibt Es Nicht\n", proxy=True)
    assert r["not_found"] == ["Gibt Es Nicht"]
    assert collection.owned_counts()["Sol Ring"] == {"real": 4, "proxy": 1}
    r = await collection.import_text("1 Demonic Tutor", replace=True)
    assert [e["name"] for e in collection.load()] == ["Demonic Tutor"]


async def test_update_printing_proxy_and_delete():
    await collection.add([{"name": "Sol Ring", "qty": 2}, {"name": "Sol Ring", "qty": 1, "proxy": True}])
    real, prox = sorted(collection.load(), key=lambda e: e["proxy"])
    new_print = {"scryfall_id": "a1b2-sol", "set": "c21", "set_name": "Set C21", "collector_number": "263", "image": "x.jpg"}
    e = collection.update(real["id"], printing=new_print, foil=True)
    assert e["set"] == "c21" and e["foil"] and e["image"] == "x.jpg"
    merged = collection.update(prox["id"], proxy=False, foil=True, printing=new_print)  # now identical -> merged
    assert merged["qty"] == 3 and len(collection.load()) == 1
    assert collection.update(merged["id"], qty=0) is None and collection.load() == []
    await collection.add([{"name": "Cultivate"}, {"name": "Sol Ring"}])
    assert collection.delete() == 2 and collection.load() == []
    await collection.add([{"qty": 2, "proxy": True, "printing": {"name": "Sol Ring", "set": "abc", "set_name": "Picked", "image": "p.jpg"}}])
    assert [(e["name"], e["qty"], e["set_name"], e["image"], e["proxy"]) for e in collection.load()] == [("Sol Ring", 2, "Picked", "p.jpg", True)]


async def test_csv_roundtrip_and_summary():
    await collection.import_text(MANABOX)
    await collection.add([{"name": "Demonic Tutor", "proxy": True}])
    text = collection.to_csv()
    assert text.splitlines()[0] == "Count,Name,Edition,Collector Number,Foil,Language,Proxy,Scryfall ID"
    assert "1,Demonic Tutor,,,,en,True," in text
    again = collection.parse_import(text)
    assert {(i["name"], i["qty"], i["proxy"]) for i in again} == {("Sol Ring", 2, False), ("Cultivate", 1, False), ("Demonic Tutor", 1, True)}
    s = collection.summary()
    assert s["cards"] == 4 and s["real"] == 3 and s["proxy"] == 1 and s["value_eur"] == 7.0  # 2×1.50 + 1×4.00 (foil)


async def test_deck_ownership_missing_and_shared():
    for name in ("Own A", "Own B"):
        await save_deck(**{"name": name, "commanders": ["Meren of Clan Nel Toth"], "bracket": 2,
            "cards": [{"name": l.split(" ", 1)[1], "qty": int(l.split(" ", 1)[0])} for l in deck_lines()]})  # fmt: skip
    await collection.add([{"name": "Sol Ring"}, {"name": "Cultivate", "proxy": True}, {"name": "Filler 0", "qty": 2}])
    deck = storage.load("own-a")
    o = await collection.deck_ownership(deck)
    assert o["cards"]["Sol Ring"] == {"need": 1, "real": 1, "proxy": 0, "missing": 0, "basic": False,
                                      "other_decks": ["Own B"], "shared_shortage": True,
                                      "places": [{"place": "", "place_deck": "", "proxy": False, "qty": 1}], "copies": []}  # fmt: skip
    assert o["cards"]["Cultivate"]["proxy"] == 1 and o["cards"]["Forest"]["basic"] and o["cards"]["Forest"]["missing"] == 0
    assert o["cards"]["Filler 0"]["shared_shortage"] is False  # 2 copies for 2 decks
    assert o["have_real"] == 1 + 1 + 36 and o["have_proxy"] == 1  # Sol Ring, Filler 0, basics; Cultivate as proxy
    assert o["missing"] == 100 - 39 and "1 Meren of Clan Nel Toth" in o["shopping_text"]
    assert "Sol Ring" in o["shared_shortages"] and o["missing_price"] > 0
    await collection.add([{"name": "Sol Ring", "proxy": True}], place="Bulk")
    await collection.add([{"name": "Sol Ring"}], place="Own A", place_deck="own-a")
    places = (await collection.deck_ownership(deck))["cards"]["Sol Ring"]["places"]
    assert places == [{"place": "", "place_deck": "", "proxy": False, "qty": 1},
                      {"place": "Own A", "place_deck": "own-a", "proxy": False, "qty": 1},
                      {"place": "Bulk", "place_deck": "", "proxy": True, "qty": 1}]  # where each copy is, for the ✓ tooltip  # fmt: skip
    miss = collection.missing_counts(deck)
    assert miss["Sol Ring"] == 0 and miss["Cultivate"] == 0 and miss["Forest"] == 0 and miss["Filler 1"] == 1


async def test_deck_copies_and_value():
    """Copies whose Ort is the deck: their printing and foil look, priced with today's price of that printing."""
    await save_deck(name="Own A", commanders=["Meren of Clan Nel Toth"], bracket=2,
                    cards=[{"name": l.split(" ", 1)[1], "qty": int(l.split(" ", 1)[0])} for l in deck_lines()])  # fmt: skip
    deck = storage.load("own-a")
    plain = await collection.deck_ownership(deck)
    assert plain["value"]["own"] == 0 and plain["value"]["total"] == plain["value"]["cheapest"]
    sid = "5a1c0de0-0000-4000-8000-00000000c0de"
    await collection.add([{"name": "Sol Ring", "scryfall_id": sid, "foil": True}], place="Own A", place_deck="own-a")
    await collection.add([{"name": "Cultivate", "proxy": True}], place="Own A", place_deck="own-a")
    await collection.add([{"name": "Forest", "qty": 3}], place="Own A", place_deck="own-a")
    await collection.add([{"name": "Swamp"}], place="Bulk")  # elsewhere: not shown in the deck
    o = await collection.deck_ownership(deck)
    sol = o["cards"]["Sol Ring"]["copies"]
    assert sol == [{"id": sol[0]["id"], "qty": 1, "proxy": False, "foil": True, "lang": "en", "set": "ltc", "set_name": "Set LTC",
                    "collector_number": "284", "image": f"https://cards.scryfall.io/normal/front/{sid}.jpg", "image_back": None,
                    "price": 4.0}]  # the foil price of that printing  # fmt: skip
    assert o["cards"]["Cultivate"]["copies"][0]["proxy"] and o["cards"]["Swamp"]["copies"] == []
    assert o["cards"]["Forest"]["copies"][0]["qty"] == 3 and o["cards"]["Forest"]["copies"][0]["price"] is None
    v = o["value"]
    assert (v["own"], v["foil"], v["proxy"], v["rest"]) == (4, 1, 1, 95)
    cheap = {n: float((await cards_price(n)) or 0) for n in ("Sol Ring", "Cultivate")}
    # Sol Ring at its foil price, the proxy at 0, the Forests (no price known) like every other card at the cheapest
    assert v["total"] == round(v["cheapest"] - cheap["Sol Ring"] + 4.0 - cheap["Cultivate"], 2)


async def cards_price(name):
    from mtgdeck.cards import resolve
    data, _, _ = await resolve([name])
    return data[name].get("price_eur")


async def test_search_owned_filters_identity():
    await collection.add([{"name": "Sol Ring"}, {"name": "Cultivate", "proxy": True}, {"name": "Time Warp"}])
    names = [c["name"] for c in await collection.search_owned("BG")]
    assert set(names) == {"Sol Ring", "Cultivate"}
    assert [c["name"] for c in await collection.search_owned("BG", type_contains="Sorcery")] == ["Cultivate"]


async def test_collection_routes_print_only_missing_and_add_printed():
    from fastapi.testclient import TestClient

    from mtgdeck import proxy
    from mtgdeck.gui.app import app

    await save_deck(**{"name": "Print Me", "commanders": ["Meren of Clan Nel Toth"], "bracket": 2,
        "cards": [{"name": l.split(" ", 1)[1], "qty": int(l.split(" ", 1)[0])} for l in deck_lines()]})  # fmt: skip
    client = TestClient(app)
    assert client.get("/api/collection").json()["summary"]["cards"] == 0
    r = client.post("/api/collection/import", json={"text": MANABOX}).json()
    assert r["added"] == 3
    r = client.post("/api/collection", json={"items": [{"name": "Filler 0", "qty": 1, "proxy": True}]}).json()
    data = client.get("/api/collection").json()
    assert data["summary"] == {"entries": 3, "cards": 4, "real": 3, "proxy": 1, "unique": 3, "value_eur": 7.0, "value_usd": 6.0}
    assert data["decks"]["Sol Ring"] == ["Print Me"]
    sol = next(e for e in data["entries"] if e["name"] == "Sol Ring")
    assert client.patch(f"/api/collection/{sol['id']}", json={"qty": 5}).json()["entry"]["qty"] == 5
    assert client.patch("/api/collection/nope", json={"qty": 1}).status_code == 404
    assert client.get("/api/collection/export").text.startswith("Count,Name")
    assert client.get("/api/cards/prints", params={"name": "Sol Ring"}).json()["prints"][0]["set_name"] == "Set 0"
    own = client.get("/api/decks/print-me/ownership").json()
    assert own["cards"]["Sol Ring"]["real"] == 5 and own["missing"] == 100 - 36 - 3

    full = await proxy.plan(storage.load("print-me"))
    part = client.get("/api/decks/print-me/print/plan", params={"only_missing": True}).json()
    assert full["quantity"] == 100 and part["quantity"] == 100 - 36 - 3 and part["only_missing"]
    assert "Sol Ring" not in {c["name"] for c in part["cards"]} and "Forest" not in {c["name"] for c in part["cards"]}

    r = client.post("/api/decks/print-me/collection/add-printed", json={"only_missing": True}).json()
    assert r["added"] == 61
    assert client.get("/api/decks/print-me/ownership").json()["missing"] == 0
    assert client.get("/api/decks/print-me/print/plan", params={"only_missing": True}).status_code == 400  # nothing left

    assert client.delete("/api/collection").status_code == 400
    assert client.delete("/api/collection", params={"confirm": True}).json()["deleted"] > 0


async def test_prints_are_paginated_not_capped():
    from fastapi.testclient import TestClient

    from mtgdeck.gui.app import app

    client = TestClient(app)
    p1 = client.get("/api/cards/prints", params={"name": "Forest"}).json()
    p2 = client.get("/api/cards/prints", params={"name": "Forest", "page": 2}).json()
    assert (len(p1["prints"]), p1["total"], p1["has_more"]) == (175, 250, True)
    assert (len(p2["prints"]), p2["has_more"], p2["prints"][0]["set_name"]) == (75, False, "Set 175")


def test_parse_lines_printing_and_flags():
    from mtgdeck.collection import _parse_lines

    items = _parse_lines("2 Sol Ring *F*\n1 Llanowar Elves (M19) 314 [proxy]\n1 Opt [m19] #59")
    assert [(i["name"], i["qty"], i["set"], i["collector_number"], i["foil"], i["proxy"]) for i in items] == [
        ("Sol Ring", 2, None, None, True, False),
        ("Llanowar Elves", 1, "m19", "314", False, True),
        ("Opt", 1, "m19", "59", False, False),
    ]


async def test_places_split_entries_and_move_together():
    from fastapi.testclient import TestClient

    from mtgdeck.gui.app import app

    await collection.add([{"name": "Sol Ring", "qty": 2}], place="Binder rot")
    await collection.add([{"name": "Sol Ring", "qty": 1}], place="  binder   ROT ")  # same place, other spelling
    await collection.add([{"name": "Sol Ring", "qty": 1}], place="Meren", place_deck="meren")
    await collection.add([{"name": "Sol Ring", "qty": 1}])
    entries = collection.load()
    assert sorted((e["place"], e["place_deck"], e["qty"]) for e in entries) == [("", "", 1), ("Binder rot", "", 3), ("Meren", "meren", 1)]
    assert collection.places() == [{"place": "Binder rot", "place_deck": "", "cards": 3}, {"place": "Meren", "place_deck": "meren", "cards": 1}]
    assert collection.clean_place(" a " * 50, "../x") == (" ".join(["a"] * 50)[: collection.PLACE_MAX], "")

    client = TestClient(app)
    ids = [e["id"] for e in entries if e["place_deck"] != "meren"]
    assert client.post("/api/collection/bulk", json={"ids": ids + ["gone"], "place": "Meren", "place_deck": "meren"}).json() == {"changed": 2}
    [one] = collection.load()  # all in the deck now: one entry
    assert one["qty"] == 5 and one["place_deck"] == "meren"
    assert client.get("/api/collection").json()["places"] == [{"place": "Meren", "place_deck": "meren", "cards": 5}]
    assert client.patch(f"/api/collection/{one['id']}", json={"place": "Kiste", "place_deck": ""}).json()["entry"]["place"] == "Kiste"
    r = client.post("/api/collection", json={"items": [{"name": "Sol Ring", "qty": 1}], "place": "Kiste"}).json()
    assert r["entries"] == 1 and collection.load()[0]["qty"] == 6


async def test_bulk_changes_flags_language_and_deletes():
    from fastapi.testclient import TestClient

    from mtgdeck.gui.app import app

    await collection.add([{"name": "Sol Ring", "qty": 1}, {"name": "Sol Ring", "qty": 2, "proxy": True}, {"name": "Filler 1", "qty": 1}])
    client = TestClient(app)
    ids = [e["id"] for e in collection.load()]
    assert client.post("/api/collection/bulk", json={"ids": ids, "proxy": True, "foil": True, "lang": "de"}).json() == {"changed": 3}
    entries = collection.load()  # the two Sol Rings are the same now: one entry
    assert sorted((e["name"], e["qty"], e["proxy"], e["foil"], e["lang"]) for e in entries) == [
        ("Filler 1", 1, True, True, "de"), ("Sol Ring", 3, True, True, "de")]
    assert all(e["place"] == "" for e in entries)  # fields not sent stay
    assert client.post("/api/collection/bulk", json={"ids": ids, "lang": "deutsch"}).status_code == 422
    sol = next(e["id"] for e in entries if e["name"] == "Sol Ring")
    assert client.post("/api/collection/bulk", json={"ids": [sol], "delete": True}).json() == {"changed": 1}
    assert [e["name"] for e in collection.load()] == ["Filler 1"]


async def test_bulk_qty_splits_copies_into_their_own_entry():
    from fastapi.testclient import TestClient

    from mtgdeck.gui.app import app

    await collection.add([{"name": "Sol Ring", "qty": 2}])
    client = TestClient(app)
    sol = collection.load()[0]["id"]
    assert client.post("/api/collection/bulk", json={"ids": [sol], "place": "Bulk", "qty": 1}).json() == {"changed": 1}
    rows = sorted((e["qty"], e["place"]) for e in collection.load())
    assert rows == [(1, ""), (1, "Bulk")]  # one copy moved, the other stayed
    rest = next(e["id"] for e in collection.load() if e["place"] == "")
    client.post("/api/collection/bulk", json={"ids": [rest], "foil": True, "qty": 5})  # more than there are = all
    assert sorted((e["qty"], e["foil"], e["place"]) for e in collection.load()) == [(1, False, "Bulk"), (1, True, "")]
    client.post("/api/collection/bulk", json={"ids": [rest], "foil": False, "place": "Bulk"})  # equal again: merge
    assert [(e["qty"], e["place"]) for e in collection.load()] == [(2, "Bulk")]
    whole = collection.load()[0]["id"]
    assert client.post("/api/collection/bulk", json={"ids": [whole], "delete": True, "qty": 1}).json() == {"changed": 1}
    assert [e["qty"] for e in collection.load()] == [1]  # deleting one of two copies keeps the other
    assert client.post("/api/collection/bulk", json={"ids": [whole], "proxy": True, "qty": 0}).status_code == 422
