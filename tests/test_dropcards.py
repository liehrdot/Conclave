"""Cards dragged in from scryfall.com (links, card images, names) are recognised."""

from fastapi.testclient import TestClient

from mtgdeck import dropcards
from mtgdeck.gui.app import app

from conftest import PRINTINGS, _printing

UUID = "0afa0e33-4804-4b00-b625-c2d6b61090fc"
IMAGE = f"https://cards.scryfall.io/large/front/0/a/{UUID}.jpg?1702429567"


def test_urls_become_identifiers():
    assert dropcards.from_url("https://scryfall.com/card/c21/263/sol-ring") == {"set": "c21", "collector_number": "263"}
    assert dropcards.from_url("https://scryfall.com/card/m21/177/de/kultivieren") == {"set": "m21", "collector_number": "177"}
    assert dropcards.from_url(IMAGE) == {"id": UUID}
    assert dropcards.from_url(f"https://api.scryfall.com/cards/{UUID.upper()}") == {"id": UUID}
    assert dropcards.from_url("https://api.scryfall.com/cards/c21/263") == {"set": "c21", "collector_number": "263"}
    for other in ("https://scryfall.com/search?q=sol", "https://api.scryfall.com/cards/named?fuzzy=sol",
                  "https://edhrec.com/cards/sol-ring", "https://evil.example/scryfall.com/card/c21/263", "not a url"):
        assert dropcards.from_url(other) is None


def test_refs_prefer_what_was_under_the_pointer():
    link = "https://scryfall.com/card/c21/263/sol-ring"
    html = f'<a href="{link}"><img src="{IMAGE}" alt="Sol Ring"></a>'
    # a search result: the uri-list has the link, the markup has link and image of the same card
    assert dropcards.refs(f"# comment\n{link}", html, link) == [{"set": "c21", "collector_number": "263"}]
    # only markup: the link wins over the image inside it, so it stays one card
    assert dropcards.refs("", html) == [{"set": "c21", "collector_number": "263"}]
    assert dropcards.refs("", f'<img src="{IMAGE}">') == [{"id": UUID}]
    assert dropcards.refs("", '<img src="https://example.com/x.png" alt="Sol Ring">') == [{"name": "Sol Ring"}]
    # plain text: card names, one per line, with quantities and set codes
    assert dropcards.refs("", "", "1x Sol Ring\nCultivate (M21) 177\n\n") == [{"name": "Sol Ring"}, {"name": "Cultivate"}]
    assert dropcards.refs("", "", "https://example.com/nothing") == []
    assert len(dropcards.refs("\n".join(f"https://scryfall.com/card/c21/{i}/x" for i in range(50)))) == dropcards.MAX_CARDS


def test_drop_route_resolves_cards(monkeypatch):
    monkeypatch.setitem(PRINTINGS, UUID, _printing("Cultivate", UUID, "m21", "177"))
    client = TestClient(app)
    r = client.post("/api/cards/drop", json={"uri_list": "https://scryfall.com/card/c21/263/sol-ring"}).json()
    assert [c["name"] for c in r["cards"]] == ["Sol Ring"] and r["missing"] == []
    r = client.post("/api/cards/drop", json={"html": f'<img src="{IMAGE}"><img src="https://cards.scryfall.io/large/front/1/1/{UUID[:-1]}1.jpg">'}).json()
    assert [c["name"] for c in r["cards"]] == ["Cultivate"] and len(r["missing"]) == 1
    r = client.post("/api/cards/drop", json={"text": "Sol Ring\nSol Ring\nCultivate"}).json()
    assert [c["name"] for c in r["cards"]] == ["Sol Ring", "Cultivate"]
    assert r["cards"][0]["type_line"]
    r = client.post("/api/cards/drop", json={"text": "https://example.com/x"})
    assert r.status_code == 400 and "scryfall.com" in r.json()["detail"]
