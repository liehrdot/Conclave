"""Deck import via link (several sites) or pasted list: preview, commander choice, saving."""

import pytest
from fastapi.testclient import TestClient

from mtgdeck import deckimport, importers, storage
from mtgdeck.gui.app import app


async def test_archidekt_categories_and_excluded_boards():
    d = await importers.import_url("https://archidekt.com/decks/4242/meren")
    names = {line.split(" ", 1)[1] for line in d["cards"]}
    assert d["commanders"] == ["Meren of Clan Nel Toth"] and d["name"] == "Meren Archidekt"
    assert "Necropotence" not in names and "Demonic Tutor" not in names  # not in deck / maybeboard
    assert d["categories"]["Sol Ring"] == "Ramp" and d["categories"]["Cultivate"] == "Ramp"
    assert d["categories"]["Forest"] == "Land" and "Pitiless Plunderer" not in d["categories"]
    assert importers.map_category("Board Wipes") == "Board Wipe" and importers.map_category("Beaters") == ""


async def test_moxfield_falls_back_to_v2_and_explains_block():
    d = await importers.import_url("https://www.moxfield.com/decks/AbC123")
    assert d["commanders"] == ["Meren of Clan Nel Toth"] and "37 Forest" in d["cards"] and d["site"] == "Moxfield"
    with pytest.raises(RuntimeError, match="Liste einfügen"):
        await importers.import_url("https://moxfield.com/decks/blocked")


async def test_text_sites():
    g = await importers.import_url("https://www.mtggoldfish.com/deck/777#paper")
    assert g["commanders"] == [] and g["commander_hint"] == "Meren of Clan Nel Toth"
    t = await importers.import_url("https://tappedout.net/mtg-decks/meren-grave-fun/")
    assert t["commanders"] == ["Meren of Clan Nel Toth"] and t["name"] == "Meren Grave Fun"
    s = await importers.import_url("https://deckstats.net/decks/12/345-meren-deck/de")
    assert s["commanders"] == ["Meren of Clan Nel Toth"] and "1 Sol Ring" in s["cards"] and s["name"] == "Meren Deck"
    e = await importers.import_url("https://edhrec.com/commanders/meren-of-clan-nel-toth")
    assert e["commander_hint"] == "meren-of-clan-nel-toth" and e["name"].startswith("EDHREC-Durchschnitt")
    with pytest.raises(ValueError, match="Unterstützt"):
        await importers.import_url("https://example.com/deck/1")


def test_pasted_text():
    d = importers.import_text("Commander\n1 Meren of Clan Nel Toth\n\nDeck\n1 Sol Ring (C21) 263\n2 Forest")
    assert d["commanders"] == ["Meren of Clan Nel Toth"] and d["cards"] == ["1 Sol Ring", "2 Forest"]
    with pytest.raises(ValueError):
        importers.import_text("  ")


async def test_preview_suggests_commander_from_hint():
    for url in ("https://www.mtggoldfish.com/deck/777", "https://edhrec.com/average-decks/meren-of-clan-nel-toth"):
        p = await deckimport.preview(await importers.import_url(url))
        assert p["suggested"] == ["Meren of Clan Nel Toth"], url
        assert "Meren of Clan Nel Toth" in {c["name"] for c in p["commander_candidates"]}
        assert p["card_count"] == 100


async def test_preview_puts_colour_fitting_commanders_first():
    text = "1 Krenko, Mob Boss\n1 Atraxa, Praetors' Voice\n1 Meren of Clan Nel Toth\n1 Sol Ring\n10 Forest\n10 Swamp"
    p = await deckimport.preview(importers.import_text(text))
    cands = p["commander_candidates"]
    assert [c["name"] for c in cands][0] == "Krenko, Mob Boss"  # WUBRG: none covers it, the list order stays
    assert not any(c["fits"] for c in cands) and p["suggested"] == []
    p = await deckimport.preview(importers.import_text(text.replace("1 Krenko, Mob Boss\n", "")))
    cands = p["commander_candidates"]
    assert [(c["name"], c["fits"]) for c in cands] == [("Atraxa, Praetors' Voice", True), ("Meren of Clan Nel Toth", False)]
    assert p["suggested"] == ["Atraxa, Praetors' Voice"] and cands[0]["type_line"].startswith("Legendary Creature")


async def test_preview_finds_partners_that_cover_the_colours_together(monkeypatch):
    async def fake_resolve(names):
        def card(name, ci, text=""):
            return {"name": name, "type_line": "Legendary Creature — Human", "color_identity": list(ci), "oracle_text": text}
        found = {"Thrasios, Triton Hero": card("Thrasios, Triton Hero", "GU", "Partner"),
                 "Tymna the Weaver": card("Tymna the Weaver", "WB", "Partner"),
                 "Meren of Clan Nel Toth": card("Meren of Clan Nel Toth", "BG"),
                 "Sol Ring": {"name": "Sol Ring", "type_line": "Artifact", "color_identity": []}}  # fmt: skip
        return found, {}, []

    monkeypatch.setattr(deckimport, "resolve", fake_resolve)
    p = await deckimport.preview(importers.import_text("1 Meren of Clan Nel Toth\n1 Sol Ring\n1 Thrasios, Triton Hero\n1 Tymna the Weaver"))
    assert [(c["name"], c["fits"], c["pairs"]) for c in p["commander_candidates"]] == [
        ("Thrasios, Triton Hero", True, True), ("Tymna the Weaver", True, True), ("Meren of Clan Nel Toth", False, False)]
    assert p["suggested"] == ["Thrasios, Triton Hero", "Tymna the Weaver"]


async def test_save_estimates_bracket():
    p = await deckimport.preview(await importers.import_url("https://archidekt.com/decks/4242"))
    saved = await deckimport.save(name=p["name"], commanders=p["commanders"], cards=p["cards"], categories=p["categories"])
    deck = storage.load(saved["slug"])
    assert deck["bracket"] == saved["bracket"] == 2  # no Game Changers, no combos -> estimated Core
    cats = {c["name"]: c["category"] for c in deck["cards"]}
    assert cats["Sol Ring"] == "Ramp" and cats["Swamp"] == "Land" and deck["validation"]["legal"]
    with pytest.raises(ValueError, match="Commander"):
        await deckimport.save(name="x", commanders=[], cards=["1 Sol Ring"])


def test_routes():
    client = TestClient(app)
    p = client.post("/api/import/preview", json={"url": "https://tappedout.net/mtg-decks/meren-grave-fun/"}).json()
    assert p["commanders"] == ["Meren of Clan Nel Toth"] and p["card_count"] == 100
    r = client.post("/api/import", json={"name": "Aus TappedOut", "commanders": p["commanders"], "cards": p["cards"],
                                          "site": p["site"], "source": p["source"], "bracket": 3})  # fmt: skip
    assert r.status_code == 200
    deck = client.get(f"/api/decks/{r.json()['slug']}").json()
    assert deck["bracket"] == 3 and deck["imported_from"]["site"] == "TappedOut"
    assert "tappedout.net" in deck["description"]
    assert client.post("/api/import/preview", json={"url": "https://moxfield.com/decks/blocked"}).status_code == 400
    assert client.post("/api/import/preview", json={"text": ""}).status_code == 400
    assert client.post("/api/import/preview", json={"url": "https://archidekt.com/decks/999"}).status_code == 404
    t = client.post("/api/import/preview", json={"text": "1 Meren of Clan Nel Toth *CMDR*\n1 Sol Ring"}).json()
    assert t["site"] == "Liste" and t["card_count"] == 2
