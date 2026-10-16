from mtgdeck.deck import card_roles, parse_decklist, to_text
from mtgdeck.edhrec import commander_slug, slugify


def test_parse_plain_and_moxfield_formats():
    text = """
Commander
1 Meren of Clan Nel Toth

Deck
1x Sol Ring
Cultivate (M21) 177
2 Forest
1 Forest
Sakura-Tribe Elder (C21) 243 *F*

Sideboard
1 Armageddon
"""
    p = parse_decklist(text)
    assert p.commanders == ["Meren of Clan Nel Toth"]
    names = {e.name: e.qty for e in p.entries}
    assert names == {"Sol Ring": 1, "Cultivate": 1, "Forest": 3, "Sakura-Tribe Elder": 1}


def test_parse_cmdr_marker_roundtrip():
    p = parse_decklist(["1 Meren of Clan Nel Toth *CMDR*", "1 Sol Ring"])
    assert p.commanders == ["Meren of Clan Nel Toth"]
    assert to_text(p.commanders, p.entries) == "1 Meren of Clan Nel Toth *CMDR*\n1 Sol Ring\n"


def test_edhrec_slugs():
    assert slugify("Atraxa, Praetors' Voice") == "atraxa-praetors-voice"
    assert slugify("Esika, God of the Tree // The Prismatic Bridge") == "esika-god-of-the-tree"
    assert slugify("Lim-Dûl the Necromancer") == "lim-dul-the-necromancer"
    assert commander_slug(["Tymna the Weaver", "Kraum, Ludevic's Opus"]) == "kraum-ludevics-opus-tymna-the-weaver"


def test_roles_regex_and_tags():
    assert "ramp" in card_roles({"oracle_text": "{T}: Add {C}{C}.", "type_line": "Artifact"})
    assert "ramp" not in card_roles({"oracle_text": "{T}: Add {G}.", "type_line": "Basic Land — Forest"})
    assert "tutor" in card_roles({"oracle_text": "Search your library for a card, put it into your hand.", "type_line": "Sorcery"})
    assert "tutor" not in card_roles({"oracle_text": "Search your library for a basic land card", "type_line": "Sorcery"})
    assert card_roles({"oracle_text": "", "type_line": "Sorcery", "tags": ["sweeper", "removal"]}) == ["board_wipe", "removal"]


def test_split_qty_and_long_lines():
    from mtgdeck.deck import split_qty

    assert split_qty("4x Sol Ring") == (4, "Sol Ring")
    assert split_qty("4 x Sol Ring") == (4, "Sol Ring")
    assert split_qty("1 Xenagos, God of Revels") == (1, "Xenagos, God of Revels")
    assert split_qty("Sol Ring") == (1, "Sol Ring")
    assert split_qty("10Foo") == (1, "10Foo")
    parsed = parse_decklist(["1 Sol Ring (C21) 263 *F*", "1 " + "a " * 400])
    assert [e.name for e in parsed.entries] == ["Sol Ring"]
