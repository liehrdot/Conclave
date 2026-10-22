"""Pinned and shelved decks: storage, the GUI route, the buy list, the phone's read model and operation, the sync."""

import pytest
from conftest import save_deck
from fastapi.testclient import TestClient
from test_phone_app import _op
from test_sync import _deck, world  # noqa: F401 (fixture)

from mtgdeck import buylist, collection, storage
from mtgdeck.gui.app import app


def _plain(name):
    return storage.save({"name": name, "commanders": ["Meren of Clan Nel Toth"], "bracket": 2, "cards": [{"name": "Sol Ring", "qty": 1}]})


def test_pinned_decks_lead_and_shelved_decks_end_the_list():
    for name in ("Alpha", "Beta", "Gamma", "Delta"):
        _plain(name)
    storage.set_flags("beta", pinned=True)
    storage.set_flags("alpha", shelved=True)
    order = [d["slug"] for d in storage.list_decks()]
    assert order[0] == "beta" and order[-1] == "alpha"
    rows = {d["slug"]: d for d in storage.list_decks()}
    assert rows["beta"]["pinned"] and not rows["beta"]["shelved"] and rows["alpha"]["shelved"]
    deck = storage.load("beta")
    assert deck["version"] == 1 and len(deck["history"]) == 1  # no new version
    storage.set_flags("beta", pinned=False)
    assert "pinned" not in storage.load("beta")
    with pytest.raises(ValueError):
        storage.set_flags("beta", favourite=True)
    copy = storage.copy("alpha")
    assert "shelved" not in copy and "pinned" not in copy  # a copy starts unmarked
    d = storage.load("alpha")
    d["cards"].append({"name": "Cultivate", "qty": 1})
    storage.save(d)
    assert storage.load("alpha")["shelved"] is True  # a saved edit keeps the mark


def test_flags_route():
    _plain("Alpha")
    client = TestClient(app)
    r = client.put("/api/decks/alpha/flags", json={"pinned": True})
    assert r.json() == {"slug": "alpha", "pinned": True, "shelved": False}
    assert client.put("/api/decks/alpha/flags", json={"shelved": True}).json()["pinned"] is True
    assert client.get("/api/decks/alpha").json()["shelved"] is True
    assert client.put("/api/decks/alpha/flags", json={}).status_code == 422
    assert client.put("/api/decks/nope/flags", json={"pinned": True}).status_code == 404


async def test_buylist_takes_cards_out_of_shelved_decks():
    await collection.add([{"name": "Sol Ring"}, {"name": "Cultivate"}])
    await save_deck(name="Alt", commanders=["Atraxa, Praetors' Voice"], bracket=2, cards=["1 Sol Ring", "1 Cultivate"])
    deck = {"slug": "neu", "name": "Neu", "commanders": ["Meren of Clan Nel Toth"], "cards": [{"name": "Sol Ring", "qty": 1}, {"name": "Cultivate", "qty": 1}]}
    r = await buylist.build(deck)
    assert {i["name"] for i in r["items"]} >= {"Sol Ring", "Cultivate"} and r["from_shelved"] == []
    storage.set_flags("alt", shelved=True)
    r = await buylist.build(deck)
    assert {i["name"] for i in r["items"]} == {"Meren of Clan Nel Toth"}
    assert r["from_shelved"] == [{"name": "Cultivate", "qty": 1, "decks": ["Alt"]}, {"name": "Sol Ring", "qty": 1, "decks": ["Alt"]}]
    assert [p for p in r["places"] if p["kind"] == "deck"][0]["shelved"] is True
    assert (await buylist.build(deck, use_collection=False))["from_shelved"] == []


def test_phone_reads_and_sets_the_flags():
    from mtgdeck.sync.appdata import snapshot
    from mtgdeck.sync.appops import OpError, apply, paths

    def deck(slug, **extra):
        return {"slug": slug, "name": slug.title(), "commanders": ["Meren of Clan Nel Toth"], "version": 1, "history": [], "cards": [], **extra}

    docs = {"decks/a.json": deck("a", shelved=True), "decks/b.json": deck("b"), "decks/c.json": deck("c", pinned=True)}
    snap = snapshot(docs)["decks"]
    assert [d["slug"] for d in snap] == ["c", "b", "a"] and snap[0]["pinned"] and snap[2]["shelved"]
    op = _op("deck.flags", {"deck": "a", "shelved": False, "pinned": True, "prev": {"shelved": True}})
    assert paths(op) == ["decks/a.json"]
    out = apply(op, {"decks/a.json": docs["decks/a.json"]})["decks/a.json"]
    assert out["pinned"] is True and "shelved" not in out and out["version"] == 1
    assert apply(op, {"decks/a.json": out}) == {}  # sent twice: nothing changes
    with pytest.raises(OpError):
        apply(_op("deck.flags", {"deck": "a", "pinned": "ja"}), {"decks/a.json": out})
    with pytest.raises(OpError):
        apply(_op("deck.flags", {"deck": "zz", "pinned": True}), {"decks/zz.json": None})


def test_flags_sync_without_a_new_version(world):  # noqa: F811
    store, a, b, use, sync = world
    use(a)
    storage.save(_deck("Meren", [("Sol Ring", 1)]))
    sync(a), use(b), sync(b)
    storage.set_flags("meren", pinned=True)  # B pins
    use(a)
    storage.set_flags("meren", shelved=True)  # A shelves meanwhile
    sync(a)
    use(b), sync(b)
    use(a), sync(a)
    for roots in (a, b):
        use(roots)
        deck = storage.load("meren")
        assert deck["pinned"] and deck["shelved"] and deck["version"] == 1 and "needs_revalidation" not in deck
