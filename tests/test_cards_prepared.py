"""Spells that are also the prepared spell of a creature (Rampant Growth / Studious First-Year), without the card DB."""

from fastapi.testclient import TestClient

from mtgdeck import scryfall
from mtgdeck.cards import card_text, name_choices
from mtgdeck.gui.app import app


async def test_choices_without_the_card_db():
    choices = await name_choices("Rampant Growth")
    assert [c["name"] for c in choices] == ["Rampant Growth", "Studious First-Year // Rampant Growth"]
    assert await name_choices("Sol Ring") == []


async def test_printings_leave_out_the_prepared_creature():
    prints = await scryfall.prints("Rampant Growth")
    assert prints["prints"] and all(p["name"] == "Rampant Growth" for p in prints["prints"])
    assert prints["total"] == 3
    # the creature itself (and a front face) still finds its own printings
    assert (await scryfall.prints("Studious First-Year // Rampant Growth"))["prints"]
    assert scryfall.same_card({"name": "Delver of Secrets // Insectile Aberration"}, "Delver of Secrets")
    assert not scryfall.same_card({"name": "Studious First-Year // Rampant Growth"}, "Rampant Growth")


async def test_card_text_is_the_spell():
    assert (await card_text("Rampant Growth", "en"))["name"] == "Rampant Growth"


def test_card_route_offers_choices():
    client = TestClient(app)
    r = client.get("/api/card", params={"name": "Rampant Growth", "choices": 1}).json()
    assert r["name"] == "Rampant Growth"
    assert [c["name"] for c in r["choices"]] == ["Rampant Growth", "Studious First-Year // Rampant Growth"]
    assert "choices" not in client.get("/api/card", params={"name": "Rampant Growth"}).json()
    assert client.get("/api/card", params={"name": "Sol Ring", "choices": 1}).json()["choices"] == []
