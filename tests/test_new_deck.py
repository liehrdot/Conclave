"""Building a deck by hand: an empty deck, filled via the editor, then printed and checked against the collection.
The former AI routes are gone."""

from conftest import deck_lines, save_deck
from fastapi.testclient import TestClient

from mtgdeck import collection, storage
from mtgdeck.gui import app as gui


async def test_empty_deck_editor_print_and_collection():
    with TestClient(gui.app) as client:
        r = client.post("/api/decks/new", json={"commander": "Meren of Clan Nel Toth", "bracket": 2})
        assert r.status_code == 200, r.text
        slug = r.json()["slug"]
        deck = storage.load(slug)
        assert deck["commanders"] == ["Meren of Clan Nel Toth"] and deck["cards"] == [] and deck["name"] == "Meren of Clan Nel Toth"
        assert deck["history"][-1]["note"] == "Leer angelegt"
        r = client.post(f"/api/decks/{slug}/cards", json={"add": [{"name": "Sol Ring", "qty": 1}]})
        assert r.status_code == 200 and [c["name"] for c in storage.load(slug)["cards"]] == ["Sol Ring"]
        assert client.post("/api/decks/new", json={"commander": "Gibts Nicht Karte"}).status_code == 404

        full = (await save_deck("Ohne KI", ["Meren of Clan Nel Toth"], deck_lines(), 2))["slug"]
        plan = client.get(f"/api/decks/{full}/print/plan").json()
        assert plan["quantity"] == 100
        assert client.post("/api/collection", json={"items": [{"name": "Sol Ring", "qty": 2}]}).status_code == 200
        assert collection.summary()["cards"] == 2


def test_ai_routes_are_gone():
    client = TestClient(gui.app)
    for path in ("/api/build", "/api/build-meta", "/api/refine", "/api/retune", "/api/chat", "/api/find-commander",
                 "/api/ai/login", "/api/decks/x/guide", "/api/decks/x/upgrades", "/api/decks/x/upgrade-plan"):  # fmt: skip
        assert client.post(path, json={}).status_code in (404, 405), path
    assert client.get("/api/ai").status_code in (404, 405)
    assert set(client.get("/api/health").json()) == {"ok", "service", "version", "home", "frozen"}


async def test_deck_can_be_renamed():
    deck = await save_deck("Vorher", ["Meren of Clan Nel Toth"], deck_lines(), 2)
    with TestClient(gui.app) as client:
        r = client.put(f"/api/decks/{deck['slug']}/name", json={"name": "Nachher"})
        assert r.status_code == 200, r.text
        renamed = r.json()
        assert renamed["slug"] == deck["slug"] and renamed["name"] == "Nachher"
        assert renamed["version"] == deck["version"] + 1
        assert storage.load(deck["slug"])["history"][-1]["note"] == "Umbenannt in „Nachher“"
        assert client.put(f"/api/decks/{deck['slug']}/name", json={"name": "   "}).status_code == 422


async def test_target_power_is_saved_and_checked():
    slug = (await save_deck("Ziel", ["Meren of Clan Nel Toth"], deck_lines(), 2, power_profile={"notes": "Lieblingskarten bleiben"}))["slug"]
    with TestClient(gui.app) as client:
        r = client.put(f"/api/decks/{slug}/target", json={"bracket": 4, "profile": {"tier": "high", "max_tutors": 2, "notes": "Lieblingskarten bleiben"}})
        assert r.status_code == 200, r.text
        deck = storage.load(slug)
        assert deck["bracket"] == 4 and deck["power_profile"]["tier"] == "high" and deck["power_profile"]["max_tutors"] == 2
        assert deck["power_profile"]["notes"] == "Lieblingskarten bleiben"
        assert deck["history"][-1]["note"] == "Ziel: oberes Bracket 4" and deck["validation"]["bracket"]["target"] == 4
        cards = [c["name"] for c in deck["cards"]]
        r = client.put(f"/api/decks/{slug}/target", json={"bracket": 2, "profile": None})
        assert r.status_code == 200 and storage.load(slug)["power_profile"] is None
        assert [c["name"] for c in storage.load(slug)["cards"]] == cards  # the cards stay as they are
        assert client.put(f"/api/decks/{slug}/target", json={"bracket": 6}).status_code == 422
        assert client.put("/api/decks/gibts-nicht/target", json={"bracket": 2}).status_code == 404
