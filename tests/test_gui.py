
from conftest import deck_lines, save_deck
from fastapi.testclient import TestClient

from mtgdeck import storage
from mtgdeck.gui.app import app


async def test_save_load_export_roundtrip():
    cards = [{"name": line.split(" ", 1)[1], "qty": int(line.split(" ", 1)[0]), "category": "Land" if "Forest" in line or "Swamp" in line else "Synergy"} for line in deck_lines()]
    r = (await save_deck(**{
        "name": "Meren Test", "commanders": ["Meren of Clan Nel Toth"], "cards": cards, "bracket": 2,
        "description": "Test",
    }))  # fmt: skip
    assert r["legal"] and r["validation"]["bracket"]["compliant"], r
    assert r["slug"] == "meren-test"

    deck = storage.load("meren-test")
    assert deck["validation"]["legal"] is True
    assert {"name": "Forest", "qty": 18, "category": "Land"} in deck["cards"]

    text = TestClient(app).get("/api/decks/meren-test/export/text").text
    assert text.startswith("1 Meren of Clan Nel Toth *CMDR*")
    assert (storage.DECKS_DIR / "meren-test.txt").exists()


async def test_gui_routes():
    await save_deck(**{
        "name": "Gui Deck", "commanders": ["Meren of Clan Nel Toth"], "bracket": 3,
        "cards": [{"name": line.split(" ", 1)[1], "qty": int(line.split(" ", 1)[0])} for line in deck_lines()],
    })  # fmt: skip
    client = TestClient(app)
    assert len(client.get("/api/brackets").json()) == 5
    decks = client.get("/api/decks").json()
    assert decks[0]["slug"] == "gui-deck" and decks[0]["valid"] is True and decks[0]["fits"] is True
    d = client.get("/api/decks/gui-deck").json()
    assert d["card_data"]["Sol Ring"]["image"].split("?")[0].endswith("Sol Ring.jpg")
    assert "18 Forest" in d["export_text"]
    assert client.post("/api/decks/gui-deck/validate").json()["legal"] is True
    assert client.get("/").status_code == 200
    trash_id = client.delete("/api/decks/gui-deck").json()["trash_id"]
    assert client.get("/api/decks/gui-deck").status_code == 404
    assert client.get("/api/trash").json()[0]["name"] == "Gui Deck"
    assert client.post(f"/api/trash/{trash_id}/restore").json()["slug"] == "gui-deck"
    assert client.get("/api/decks/gui-deck").status_code == 200


def test_ui_font_setting():
    client = TestClient(app)
    assert client.get("/api/settings").json()["font"] == "cascadia"
    assert client.post("/api/settings", json={"font": "inter"}).json()["font"] == "inter"
    assert client.get("/api/settings").json()["font"] == "inter"
    assert client.post("/api/settings", json={"font": "comic"}).status_code == 422


def test_hover_preview_setting():
    client = TestClient(app)
    assert client.get("/api/settings").json()["hover_preview"] is True
    assert client.post("/api/settings", json={"hover_preview": False}).json()["hover_preview"] is False
    assert client.get("/api/settings").json()["hover_preview"] is False
    # the settings form posts the other fields and must keep an explicit false
    saved = client.post("/api/settings", json={"autofill_path": "", "descreen": "normal", "upscale": False}).json()
    assert saved["hover_preview"] is False
    assert client.post("/api/settings", json={"hover_preview": False, "upscale": False}).json()["hover_preview"] is False
    assert client.post("/api/settings", json={"hover_preview": True}).json()["hover_preview"] is True


def test_deck_view_has_back_faces():
    storage.save({"name": "Dfc Deck", "commanders": ["Meren of Clan Nel Toth"], "bracket": 2,
                  "cards": [{"name": "Delver of Secrets // Insectile Aberration", "qty": 1}, {"name": "Sol Ring", "qty": 1}]})  # fmt: skip
    d = TestClient(app).get("/api/decks/dfc-deck").json()
    delver = d["card_data"]["Delver of Secrets // Insectile Aberration"]
    assert delver["image_back"].endswith("/back/delver.jpg") and delver["layout"] == "transform"
    assert d["card_data"]["Sol Ring"]["image_back"] is None
