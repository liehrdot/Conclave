"""Game log per deck: storage, statistics, learning focus, and routes."""

import pytest
from conftest import deck_lines, save_deck
from fastapi.testclient import TestClient

from mtgdeck import games, storage
from mtgdeck.gui.app import app


async def _save(name="Games"):
    await save_deck(**{"name": name, "commanders": ["Meren of Clan Nel Toth"], "bracket": 3,
        "cards": [{"name": l.split(" ", 1)[1], "qty": int(l.split(" ", 1)[0])} for l in deck_lines()]})  # fmt: skip
    return storage.slug(name)


async def test_add_stats_and_focus():
    slug = await _save()
    games.add(slug, result="win", turn=9, mvp="Sol Ring", version=1)
    games.add(slug, result="loss", turn=7, issues=["few_lands", "no_draw"], opponents=["Atraxa", " "], version=1)
    games.add(slug, result="loss", issues=["few_lands"], version=2)
    s = games.stats(games.games(slug))
    assert (s["games"], s["wins"], s["losses"], s["win_rate"], s["avg_turn"]) == (3, 1, 2, 0.33, 8.0)
    assert s["issues"][0] == {"key": "few_lands", "label": "zu wenige Länder", "count": 2}
    assert s["per_version"] == [{"version": 1, "games": 2, "wins": 1}, {"version": 2, "games": 1, "wins": 0}]
    assert s["mvps"] == [{"name": "Sol Ring", "count": 1}] and s["opponents"] == [{"name": "Atraxa", "count": 1}]
    focus = games.learn_focus(games.games(slug))
    assert focus.startswith("Aus den Partien: konstanter Mana") and "2× „zu wenige Länder“" in focus
    with pytest.raises(ValueError):
        games.add(slug, result="gewonnen")
    with pytest.raises(ValueError):
        games.add(slug, result="win", issues=["unbekannt"])
    assert games.learn_focus([]) == ""


async def test_routes_and_delete_with_deck():
    slug = await _save()
    client = TestClient(app)
    r = client.post(f"/api/decks/{slug}/games", json={"result": "win", "mvp": "sol ring", "opponents": ["Meren of Clan Nel Toth"],
                                                       "issues": ["slow"], "turn": 10})  # fmt: skip
    assert r.status_code == 200
    body = r.json()
    assert body["game"]["mvp"] == "Sol Ring" and body["game"]["version"] == 1 and body["stats"]["wins"] == 1
    assert body["issue_labels"]["slow"] == "zu langsam"
    assert client.post(f"/api/decks/{slug}/games", json={"result": "maybe"}).status_code == 422
    assert client.post(f"/api/decks/{slug}/games", json={"result": "win", "issues": ["x"]}).status_code == 400
    assert client.get("/api/decks/nope/games").status_code == 404
    gid = body["game"]["id"]
    assert client.delete(f"/api/decks/{slug}/games/{gid}").json()["stats"]["games"] == 0
    assert client.delete(f"/api/decks/{slug}/games/{gid}").status_code == 404
    games.add(slug, result="draw")
    storage.delete(slug)
    assert games.games(slug) == []


async def test_finishing_places_are_stored_and_counted():
    slug = await _save()
    games.add(slug, result="win", opponents=["Atraxa", "Krenko"], place=1, opponent_places=[3, 2])
    games.add(slug, result="loss", opponents=["Atraxa", "Krenko", "Korvold"], place=3, opponent_places=[1, None, 2])
    games.add(slug, result="loss", place=5)  # no opponents noted: only the user's place, up to PLACES_MAX
    games.add(slug, result="loss", opponents=["Atraxa"], place=3, opponent_places=[True])  # 3rd of 2 players: dropped
    items = games.games(slug)
    assert [(g.get("place"), g.get("opponent_places")) for g in items] == [(1, [3, 2]), (3, [1, None, 2]), (5, None), (None, None)]
    assert games.stats(items)["places"] == {"games": 3, "avg": 3.0, "counts": [{"place": 1, "count": 1}, {"place": 3, "count": 1},
                                                                           {"place": 5, "count": 1}], "avg_players": 3.5}  # fmt: skip
    assert games.stats([])["places"] is None
    client = TestClient(app)
    r = client.post(f"/api/decks/{slug}/games", json={"result": "loss", "opponents": ["Krenko", "", "Atraxa"], "place": 2,
                                                       "opponent_places": [3, 2, 1]})  # fmt: skip
    assert (r.json()["game"]["place"], r.json()["game"]["opponent_places"]) == (2, [3, 1])
    assert client.post(f"/api/decks/{slug}/games", json={"result": "win", "place": 7}).status_code == 422
    # an opponent going out shows in the round's turn table
    assert games.round_turns({"start_life": 40, "turns": 1, "events": [_ev(1, "out", 1, "Krenko, Mob Boss")]})[0]["events"] == ["Krenko, Mob Boss ist raus"]


def _ev(turn, kind, delta, frm=None, text=None):
    e = {"turn": turn, "kind": kind, "delta": delta, "at": "2026-10-11T12:00:00Z"}
    return e | ({"from": frm} if frm else {}) | ({"text": text} if text else {})


KRENKO, ATRAXA = "Krenko, Mob Boss", "Atraxa, Praetors' Voice"
ROUND_A = {"start_life": 40, "life": 12, "poison": 1, "turns": 4, "started": "2026-10-11T12:00:00Z", "ended": "2026-10-11T12:40:00Z",
           "cmd": [{"name": KRENKO, "dmg": 14}], "events": [
    _ev(1, "life", -2), _ev(2, "turn", 1), _ev(2, "life", -5, KRENKO), _ev(2, "note", 0, text="Wrath"), _ev(3, "turn", 1),
    _ev(3, "cmd", 10, KRENKO), _ev(3, "life", 3), _ev(3, "poison", 1), _ev(4, "turn", 1), _ev(4, "cmd", 4, KRENKO), _ev(4, "life", -10, ATRAXA)]}
ROUND_B = {"start_life": 40, "life": 0, "poison": 0, "turns": 3, "cmd": [{"name": KRENKO, "dmg": 21}], "events": [
    _ev(2, "turn", 1), _ev(3, "turn", 1), _ev(3, "cmd", 21, KRENKO), _ev(3, "life", -19)]}  # fmt: skip


def _add_rounds(slug):
    for rnd in (ROUND_A, ROUND_B):
        games.add(slug, result="loss", opponents=["Krenko, Mob Boss"])
        items = games.games(slug)
        items[-1]["round"] = rnd  # what sync/appops writes for a game from the phone's Runden-Helfer
        games._write(slug, items)


async def test_round_logs_turn_by_turn_and_over_all_games():
    turns = games.round_turns(ROUND_A)
    assert [t["life"] for t in turns] == [38, 33, 26, 12]
    assert turns[2] == {"turn": 3, "lost": 10, "gained": 3, "cmd": {KRENKO: 10}, "poison": 1, "life": 26, "notes": [],
                        "events": ["10 Commander-Schaden von Krenko, Mob Boss", "+3 Leben", "+1 Giftmarke"]}  # fmt: skip
    assert turns[1]["notes"] == ["Wrath"] and turns[1]["events"] == ["−5 Leben von Krenko, Mob Boss"]
    slug = await _save()
    games.add(slug, result="win")
    _add_rounds(slug)
    r = games.stats(games.games(slug))["rounds"]
    assert (r["rounds"], r["avg_end_life"], r["poison_rounds"]) == (2, 6.0, 1)
    assert r["sources"][0] == {"name": KRENKO, "damage": 40, "cmd": 35, "rounds": 2}
    assert r["sources"][1] == {"name": ATRAXA, "damage": 10, "cmd": 0, "rounds": 1}
    assert r["worst_turn"] == {"turn": 3, "avg_lost": 25.0, "rounds": 2}
    assert games.stats([{"result": "win"}])["rounds"] is None
    focus = games.learn_focus(games.games(slug))
    assert "Antworten auf Krenko, Mob Boss (40 Schaden in 2 Runden)" in focus and "in Zug 3 im Schnitt 25 Leben verloren" in focus
    # the GUI gets the turns of each logged round
    shown = games.summary(slug)["games"]
    assert "round_turns" not in shown[0] and shown[1]["round_turns"][0]["life"] == 38
