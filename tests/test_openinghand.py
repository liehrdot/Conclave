from conftest import deck_lines, save_deck
from fastapi.testclient import TestClient

from mtgdeck import openinghand as oh

COLORS = {"B", "G"}


def c(name, *, type_line="Creature — Elf", cmc=2, mana_cost="{1}{G}", text="", roles=()):
    data = {"name": name, "type_line": type_line, "cmc": cmc, "mana_cost": mana_cost, "oracle_text": text, "roles": list(roles)}
    return oh.card_from(data, deck_colors=COLORS)


FOREST = c("Forest", type_line="Basic Land — Forest", cmc=0, mana_cost="", text="({T}: Add {G}.)")
SWAMP = c("Swamp", type_line="Basic Land — Swamp", cmc=0, mana_cost="", text="({T}: Add {B}.)")
SOL = c("Sol Ring", type_line="Artifact", cmc=1, mana_cost="{1}", text="{T}: Add {C}{C}.", roles=["ramp"])
ELF = c("Llanowar Elves", cmc=1, mana_cost="{G}", text="{T}: Add {G}.", roles=["ramp"])
CULT = c("Cultivate", type_line="Sorcery", cmc=3, mana_cost="{2}{G}",
         text="Search your library for up to two basic land cards, put one onto the battlefield tapped.", roles=["ramp"])  # fmt: skip
BEAR = c("Bear")
DRAW = c("Night's Whisper", type_line="Sorcery", mana_cost="{1}{B}", text="You draw two cards.", roles=["card_draw"])
BIG = c("Big Thing", cmc=7, mana_cost="{5}{G}{G}")
BLUE = c("Blue Thing", cmc=2, mana_cost="{1}{U}")


def deck_of(hand_like=None, lands=37, speed=""):
    cards = [FOREST] * (lands // 2) + [SWAMP] * (lands - lands // 2) + [BEAR] * (99 - lands)
    cmdr = c("Meren", cmc=4, mana_cost="{2}{B}{G}")
    return oh.Deck(cards=cards, commanders=[cmdr], colors=set(COLORS), speed=speed)


def test_card_features():
    assert FOREST.land and FOREST.colors == {"G"} and not FOREST.tapped
    assert (SOL.ramp, SOL.ramp_kind) == (2, "rock") and SOL.fast_mana
    assert (ELF.ramp, ELF.ramp_kind, ELF.colors) == (1, "dork", {"G"})
    assert (CULT.ramp, CULT.ramp_kind) == (1, "land")
    assert BIG.pips == [{"G"}, {"G"}]
    tapped = c("Golgari Guildgate", type_line="Land — Gate", cmc=0, mana_cost="", text="This land enters tapped. {T}: Add {B} or {G}.")
    assert tapped.tapped and tapped.colors == {"B", "G"}
    signet = c("Arcane Signet", type_line="Artifact", cmc=2, mana_cost="{2}",
               text="{T}: Add one mana of any color in your commander's color identity.", roles=["ramp"])  # fmt: skip
    assert (signet.ramp, signet.ramp_kind, signet.colors) == (1, "rock", COLORS)
    altar = c("Ashnod's Altar", type_line="Artifact", cmc=3, mana_cost="{3}", text="Sacrifice a creature: Add {C}{C}.", roles=["ramp"])
    assert altar.ramp == 0
    mdfc = c("Spell // Land", type_line="Sorcery // Land", cmc=3)
    assert mdfc.flex and not mdfc.land


def test_goldfish_ramp_and_commander():
    deck = deck_of()
    gf = oh.goldfish([FOREST, SWAMP, SOL, BEAR, BEAR, DRAW, BIG], deck, land_ratio=0.37, on_draw=False)
    assert "Sol Ring" in gf.cast[1]
    assert gf.mana[2] >= 4  # two lands + Sol Ring
    assert gf.commander_turn == 2


def test_good_and_bad_hands():
    deck = deck_of()
    keep = oh.score_hand([FOREST, SWAMP, FOREST, ELF, BEAR, DRAW, BEAR], deck)
    one = oh.score_hand([FOREST, BEAR, BEAR, DRAW, BIG, BIG, BEAR], deck)
    none = oh.score_hand([BEAR] * 7, deck)
    flood = oh.score_hand([FOREST] * 4 + [SWAMP] * 3, deck)
    assert keep.score >= oh.KEEP and not keep.bad
    assert one.score < oh.BORDER and any("Nur 1 Land" in b for b in one.bad)
    assert none.fatal and oh.verdict(none, 7, 0)[0] == "mulligan"
    assert flood.fatal.startswith("Nur Länder")


def test_sol_ring_saves_a_one_lander():
    deck = deck_of()
    plain = oh.score_hand([FOREST, BEAR, BEAR, BEAR, DRAW, BIG, BIG], deck).score
    rocks = oh.score_hand([FOREST, SOL, ELF, BEAR, BEAR, DRAW, BIG], deck)
    assert rocks.score > plain + 25
    assert any("Ein-Länder spielbar" in g for g in rocks.good)


def test_missing_colour():
    deck = deck_of()
    r = oh.score_hand([FOREST, FOREST, FOREST, BLUE, BEAR, BEAR, DRAW], deck)
    assert any(b.startswith("Blau fehlt für Blue Thing") for b in r.bad)
    assert any(b.startswith("Schwarz fehlt") for b in r.bad)


def test_fast_deck_wants_a_fast_start():
    hand = [FOREST, SWAMP, FOREST, BEAR, BEAR, BEAR, BEAR]
    casual = oh.score_hand(hand, deck_of()).score
    fast = oh.score_hand(hand, deck_of(speed="very-fast"))
    assert fast.score < casual and any("schnelles Deck" in b for b in fast.bad)


def test_combo_in_hand():
    deck = deck_of()
    a, b = c("Combo A", roles=[]), c("Combo B")
    a.combo = b.combo = True
    deck.combos = [{"Combo A", "Combo B"}]
    r = oh.score_hand([FOREST, SWAMP, FOREST, a, b, BEAR, BEAR], deck)
    assert any(g.startswith("Ganze Kombo") for g in r.good)


def test_bottom_and_profile():
    deck = deck_of()
    out = oh.bottom([FOREST, SWAMP, FOREST, SWAMP, FOREST, BEAR, BIG], deck, 2)
    assert len(out) == 2 and "Bear" not in out
    profile = oh.deck_profile(deck, samples=200)
    assert 0 < profile["playable"] <= 1 and len(profile["scores"]) == 200
    assert oh.percentile(100, profile["scores"]) == 100


async def test_route_rates_a_hand(monkeypatch):
    monkeypatch.setenv("MTG_SYNC_AUTO", "0")
    from mtgdeck.gui.app import app

    await save_deck("Meren", ["Meren of Clan Nel Toth"], deck_lines(), 2, slug="meren")
    with TestClient(app) as client:
        r = client.post("/api/decks/meren/hand", json={"cards": ["Forest", "Swamp", "Forest", "Sol Ring", "Cultivate", "Filler 1", "Filler 2"]})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["verdict"] == "keep" and body["label"] == "Behalten"
        assert 0 <= body["percentile"] <= 100 and body["deck"]["speed"] == "very-fast" and body["deck"]["playable"] > 0.3
        assert body["facts"]["lands"] == 3 and body["facts"]["commander_turn"] is not None
        r = client.post("/api/decks/meren/hand", json={"cards": ["Forest"] * 5 + ["Filler 1", "Sol Ring"], "mulligans": 2, "bottom": 1})
        assert r.json()["bottom"] == ["Forest"]
        assert client.post("/api/decks/nope/hand", json={"cards": []}).status_code == 404



def test_ramp_needs_its_colour():
    deck = deck_of()
    r = oh.score_hand([SWAMP, ELF, ELF, BEAR, DRAW, BIG, BIG], deck)
    assert not any(g.startswith("Ramp:") for g in r.good)
    assert any(b.startswith("Grün fehlt für Llanowar Elves") for b in r.bad)
    roots = c("Insidious Roots", type_line="Enchantment", cmc=2, mana_cost="{B}{G}",
              text='Creature tokens you control have "{T}: Add one mana of any color."', roles=["ramp"])  # fmt: skip
    assert roots.ramp == 0
