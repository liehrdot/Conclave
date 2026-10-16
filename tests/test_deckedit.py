"""Editing saved decks directly and replacement suggestions."""

import pytest
from conftest import deck_lines, save_deck
from fastapi.testclient import TestClient

from mtgdeck import deckedit, storage
from mtgdeck.gui.app import app


async def _deck(name="Edit Deck"):
    await save_deck(**{
        "name": name, "commanders": ["Meren of Clan Nel Toth"], "bracket": 3,
        "cards": [{"name": l.split(" ", 1)[1], "qty": int(l.split(" ", 1)[0]), "category": "Synergy"} for l in deck_lines()],
    })  # fmt: skip
    return storage.slug(name)


async def test_edit_add_remove_qty_category_creates_version():
    slug = await _deck()
    r = await deckedit.edit_deck(slug, add=[{"name": "sol ring"}], remove=["Filler 0"],
                                 set_qty={"Forest": 17, "Swamp": 18}, set_category={"Cultivate": "Ramp"}, note="Test")  # fmt: skip
    deck = storage.load(slug)
    names = {c["name"]: c for c in deck["cards"]}
    assert "Filler 0" not in names and names["Forest"]["qty"] == 17 and names["Cultivate"]["category"] == "Ramp"
    assert names["Sol Ring"]["qty"] == 2  # was already in the deck: quantities add up
    assert r["version"] == 2 and r["change_note"].startswith("Test (Manuell: + Sol Ring; − Filler 0; Forest 18→17")
    assert deck["validation"]["stats"]["card_count"] == 98  # re-validated after the edit
    assert storage.versions(slug)[-1]["removed"] == ["Filler 0", "Forest"]  # one Forest less


async def test_new_card_gets_category_from_its_role_and_errors():
    slug = await _deck()
    await deckedit.edit_deck(slug, add=[{"name": "Demonic Tutor"}, {"name": "Forest", "qty": 1}], remove=["Filler 1", "Filler 2"])
    names = {c["name"]: c for c in storage.load(slug)["cards"]}
    assert names["Demonic Tutor"]["category"] == "Synergy" and names["Forest"]["qty"] == 19
    with pytest.raises(ValueError, match="nicht gefunden"):
        await deckedit.edit_deck(slug, add=[{"name": "Gibt Es Nicht Karte"}])
    with pytest.raises(ValueError, match="Commander"):
        await deckedit.edit_deck(slug, add=[{"name": "Meren of Clan Nel Toth"}])
    with pytest.raises(ValueError, match="Keine Änderung"):
        await deckedit.edit_deck(slug, remove=["Not In Deck"])


async def test_similar_cards_excludes_deck_and_blacklist():
    slug = await _deck()
    out = await deckedit.similar_cards(storage.load(slug), "Sol Ring")
    names = [c["name"] for c in out]
    assert names == ["Filler Ramp Rock"]  # Cultivate/Sol Ring are already in the deck
    assert out[0]["reason"].startswith("gleiche Rolle")


async def test_edit_routes():
    slug = await _deck()
    client = TestClient(app)
    r = client.post(f"/api/decks/{slug}/cards", json={"add": [{"name": "Demonic Tutor"}], "remove": ["Filler 3"]})
    assert r.status_code == 200 and r.json()["version"] == 2
    assert client.post(f"/api/decks/{slug}/cards", json={"add": [{"name": "Nope Nope"}]}).status_code == 400
    assert client.post("/api/decks/nope/cards", json={"remove": ["x"]}).status_code == 404
    sim = client.get(f"/api/decks/{slug}/similar", params={"card": "Sol Ring"}).json()
    assert sim[0]["name"] == "Filler Ramp Rock"


async def test_maybe_list_moves_cards_and_never_counts():
    slug = await _deck()
    count = storage.load(slug)["validation"]["stats"]["card_count"]
    r = await deckedit.edit_deck(slug, maybe_add=[{"name": "demonic tutor"}, {"name": "Cultivate"}])
    deck = storage.load(slug)
    assert deck["maybe"] == [{"name": "Cultivate", "category": "Synergy"}, {"name": "Demonic Tutor", "category": "Synergy"}]
    assert "Cultivate" not in {c["name"] for c in deck["cards"]}  # a deck card moves to the list
    assert deck["validation"]["stats"]["card_count"] == count - 1  # maybe cards never count
    assert r["version"] == 2 and r["change_note"] == "Manuell: Vielleicht + Demonic Tutor; Cultivate → Vielleicht"
    assert storage.versions(slug)[-1]["removed"] == ["Cultivate"]

    await deckedit.edit_deck(slug, add=[{"name": "Cultivate", "category": "Ramp"}])  # into the deck → off the list
    deck = storage.load(slug)
    assert [m["name"] for m in deck["maybe"]] == ["Demonic Tutor"] and {c["name"]: c for c in deck["cards"]}["Cultivate"]["category"] == "Ramp"
    r = await deckedit.edit_deck(slug, maybe_remove=["Demonic Tutor"])
    assert "maybe" not in storage.load(slug) and r["change_note"] == "Manuell: Vielleicht − Demonic Tutor"
    with pytest.raises(ValueError, match="Commander"):
        await deckedit.edit_deck(slug, maybe_add=[{"name": "Meren of Clan Nel Toth"}])
    with pytest.raises(ValueError, match="Keine Änderung"):
        await deckedit.edit_deck(slug, maybe_remove=["Demonic Tutor"])


async def test_maybe_routes_and_card_data():
    slug = await _deck()
    client = TestClient(app)
    r = client.post(f"/api/decks/{slug}/cards", json={"maybe_add": [{"name": "Demonic Tutor", "category": "Tutor"}]})
    assert r.status_code == 200
    deck = client.get(f"/api/decks/{slug}").json()
    assert deck["maybe"] == [{"name": "Demonic Tutor", "category": "Tutor"}] and "Demonic Tutor" in deck["card_data"]
    assert "Demonic Tutor" not in deck["export_text"]
