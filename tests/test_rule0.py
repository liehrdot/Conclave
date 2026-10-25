"""Rule-0 text."""

from conftest import deck_lines, save_deck
from fastapi.testclient import TestClient

from mtgdeck import rule0, storage
from mtgdeck.gui.app import app


async def _save(name="Guide", extra=None, **kw):
    await save_deck(**{"name": name, "commanders": ["Meren of Clan Nel Toth"], "bracket": 3,
        "description": "Opfern und zurückholen. Meren holt jede Runde etwas zurück.",
        "cards": [{"name": l.split(" ", 1)[1], "qty": int(l.split(" ", 1)[0])} for l in deck_lines(extra=extra)], **kw})  # fmt: skip
    return storage.load(storage.slug(name))


async def test_rule0_rows_and_text():
    deck = await _save(extra=["1 Demonic Tutor", "1 Time Warp"], fillers=None, power_profile={"tier": "high", "allow_two_card_combos": False})
    r = rule0.build(deck)
    rows = {x["label"]: x for x in r["rows"]}
    assert rows["Stufe"]["value"].startswith("oberes Bracket 3 (Upgraded)")
    assert rows["Spielweise"]["value"] == "Opfern und zurückholen."
    assert rows["Game Changer"]["value"] == "1: Demonic Tutor" and rows["Game Changer"]["flag"]
    assert rows["Extra-Züge"]["value"] == "Time Warp" and rows["Extra-Züge"]["flag"]
    assert rows["2-Karten-Combos"]["value"] == "keine"
    assert rows["Hausregeln"]["value"] == "keine 2-Karten-Combos"
    assert rows["Tempo"]["value"].endswith("Zug 6+")
    assert r["text"].startswith("Guide – Rule 0\nStufe: ") and r["text"].endswith("Passt das für eure Runde?")
    assert "Proxys" not in rows


async def test_rule0_route_and_proxy():
    await _save("Proxy Guide", proxy=True)
    r = TestClient(app).get("/api/decks/proxy-guide/rule0").json()
    assert any(x["label"] == "Proxys" for x in r["rows"])
    assert TestClient(app).get("/api/decks/nope/rule0").status_code == 404


async def test_rule0_in_english():
    deck = await _save(extra=["1 Demonic Tutor", "1 Time Warp"], fillers=None, power_profile={"tier": "high", "allow_two_card_combos": False})
    r = rule0.build(deck, lang="en")
    rows = {x["label"]: x for x in r["rows"]}
    assert rows["Level"]["value"].startswith("upper Bracket 3 (Upgraded)")
    assert rows["Play style"]["value"] == "Opfern und zurückholen."  # the deck's own text stays as written
    assert rows["Game Changers"]["value"] == "1: Demonic Tutor" and rows["Game Changers"]["flag"]
    assert rows["Extra turns"]["value"] == "Time Warp"
    assert rows["Two-card combos"]["value"] == "none"
    assert rows["House rules"]["value"] == "no two-card combos"
    assert rows["Speed"]["value"].endswith("earliest game end by bracket: turn 6+")
    assert r["text"].startswith("Guide – Rule 0\nLevel: ") and r["text"].endswith("Does this fit your table?")
    assert [x["flag"] for x in r["rows"]] == [x["flag"] for x in rule0.build(deck)["rows"]]
    assert rule0._names([str(i) for i in range(8)], lang="en").endswith("0, 1, 2, 3, 4, 5 and 2 more")
