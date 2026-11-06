from mtgdeck import bulk, cardrules


def test_can_lead_follows_scryfall():
    lead = cardrules.can_lead
    assert lead({"type_line": "Legendary Creature — Elf"})
    assert lead({"type_line": "Legendary Enchantment — Background"})
    assert lead({"type_line": "Legendary Planeswalker — Teferi", "oracle_text": "Teferi can be your commander."})
    assert lead({"type_line": "Legendary Artifact — Vehicle", "pt": "6/6"})
    assert lead({"type_line": "Legendary Artifact — Spacecraft", "power": "4", "toughness": "4"})  # raw Scryfall card
    assert not lead({"type_line": "Legendary Artifact — Vehicle"})  # no power/toughness
    assert not lead({"type_line": "Creature — Elf"})
    assert not lead({"type_line": "Sorcery // Legendary Creature — Elf"})  # only the front face counts


def test_raw_cards_read_their_faces():
    card = {"type_line": "Legendary Planeswalker — X // Legendary Creature — Y",
            "card_faces": [{"oracle_text": "X can be your commander."}, {"oracle_text": ""}]}  # fmt: skip
    assert bulk.is_commander(card)


def test_can_pair_needs_a_pairing_keyword():
    pair = cardrules.can_pair
    assert pair({"type_line": "Legendary Creature — Elf", "oracle_text": "Partner"})
    assert pair({"type_line": "Legendary Creature — Elf", "oracle_text": "Partner with Someone"})
    assert pair({"type_line": "Legendary Creature — Elf", "oracle_text": "Choose a Background"})
    assert pair({"type_line": "Legendary Enchantment — Background"})
    assert pair({"type_line": "Legendary Creature — Time Lord", "oracle_text": "Doctor's companion"})
    assert not pair({"type_line": "Legendary Planeswalker — Daretti", "oracle_text": "Daretti can be your commander."})
    assert not pair({"type_line": "Legendary Creature — Elf", "oracle_text": "Your partners in crime get +1/+1."})


def test_a_land_is_never_a_tutor():
    assert cardrules.is_tutor({"type_line": "Sorcery", "roles": ["tutor"]})
    assert not cardrules.is_tutor({"type_line": "Land", "roles": ["tutor", "ramp"]})
    assert not cardrules.is_tutor({"type_line": "Instant", "roles": ["removal"]})
    assert cardrules.is_tutor({"type_line": "Instant"}, roles={"tutor"})
