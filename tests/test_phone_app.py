"""Phone app ("Am Tisch"): the read model and how the sync server serves the app."""

from fastapi.testclient import TestClient

from mtgdeck.sync import appdata
from mtgdeck.sync.server import create_app


def _docs():
    deck = {"name": "Meren", "commanders": ["Meren of Clan Nel Toth"], "bracket": 3, "power_profile": {"tier": "high"}, "version": 2,
            "description": "Opfern und zurückholen. Mehr Text.", "updated": "2026-10-01T10:00:00+00:00",
            "cards": [{"name": "Sol Ring", "qty": 1, "category": "Ramp"}, {"name": "Forest", "qty": 30, "category": "Land"}],
            "guide": {"plan": "Opfern.", "early": ["Ramp"], "key_cards": [{"name": "Sol Ring", "why": "Mana", "image": "x"}]},
            "validation": {"legal": True, "color_identity": "BG", "bracket": {"game_changers": ["Demonic Tutor"], "power": {"value": 3.7}}}}  # fmt: skip
    games = [{"id": "g1", "played": "2026-10-02T20:00:00+00:00", "result": "win", "opponents": ["Atraxa, Praetors' Voice"], "opponent_ids": ["o1"]},
             {"id": "g2", "played": "2026-10-03T20:00:00+00:00", "result": "loss", "opponents": ["Krenko, Mob Boss"]}]  # fmt: skip
    opps = {"opponents": [
        {"id": "o1", "commanders": ["Atraxa, Praetors' Voice"], "player": "Tim", "tags": ["combo", "nope"], "color_identity": ["W", "U", "B", "G"],
         "notes": [{"id": "n1", "text": "alt", "at": "2026-09-01T00:00:00+00:00"}, {"id": "n2", "text": "neu", "at": "2026-10-01T00:00:00+00:00"}]},
        {"id": "o2", "commanders": ["Krenko, Mob Boss"], "player": "Lisa", "tags": [], "color_identity": ["R"]},
    ]}  # fmt: skip
    return {"decks/meren.json": deck, "decks/.games/meren.json": games, "decks/.opponents.json": opps, "collection.json": []}


def test_snapshot_has_what_the_phone_shows():
    snap = appdata.snapshot(_docs())
    d = snap["decks"][0]
    assert d["slug"] == "meren" and d["colors"] == "BG" and d["level"] == "oberes Bracket 3"
    assert d["record"] == {"games": 2, "wins": 1, "losses": 1, "draws": 0, "last": "2026-10-03T20:00:00+00:00"}
    assert d["description"] == "Opfern und zurückholen."
    gc = next(r for r in d["rule0"]["rows"] if r["label"] == "Game Changer")
    assert gc["flag"] and "Demonic Tutor" in gc["value"] and "Rule 0" in d["rule0"]["text"]
    assert "guide" not in d and "chats" not in snap  # no Claude texts on the phone
    assert d["cards"][1] == {"name": "Forest", "qty": 30, "category": "Land"}
    assert [g["id"] for g in snap["games"]] == ["g2", "g1"] and snap["games"][0]["deck"] == "meren"
    atraxa, krenko = sorted(snap["opponents"], key=lambda o: o["id"])
    assert atraxa["record"]["wins"] == 1 and atraxa["tags"] == ["combo"] and atraxa["colors"] == "WUBG"
    assert [n["text"] for n in atraxa["notes"]] == ["neu", "alt"]
    assert krenko["record"]["losses"] == 1  # an unlinked game counts by commander name
    assert snap["players"] == ["Lisa", "Tim"]
    assert ["combo", "Combo"] in snap["options"]["tags"] and ["commander", "Commander-Schaden"] in snap["options"]["how"]


def test_snapshot_in_english_for_the_native_apps():
    snap = appdata.snapshot(_docs())
    d = snap["decks"][0]
    assert d["level"] == "oberes Bracket 3" and d["level_en"] == "upper Bracket 3"
    gc = next(r for r in d["rule0_en"]["rows"] if r["label"] == "Game Changers")
    assert gc["flag"] and "Demonic Tutor" in gc["value"] and d["rule0_en"]["text"].endswith("Does this fit your table?")
    en, de = snap["options_en"], snap["options"]
    for key in ("issues", "tags", "how"):  # the same keys in the same order, every one translated
        assert [k for k, _ in en[key]] == [k for k, _ in de[key]] and all(label for _, label in en[key])
    assert en["results"] == {"win": "Win", "loss": "Loss", "draw": "Draw"}


def test_snapshot_of_nothing():
    snap = appdata.snapshot({})
    assert snap["decks"] == snap["games"] == snap["opponents"] == [] and snap["options"]["issues"]


def test_server_serves_the_app_with_a_strict_policy(tmp_path):
    client = TestClient(create_app(tmp_path))
    r = client.get("/app/")
    assert r.status_code == 200 and "Conclave" in r.text and "/app/js/main.js" in r.text
    csp = r.headers["content-security-policy"]
    assert "script-src 'self'" in csp and "unsafe-inline" not in csp and "api.scryfall.com" in csp
    assert client.get("/app", follow_redirects=False).headers["location"] == "/app/"
    for path in ("/app/js/main.js", "/app/app.css", "/app/manifest.webmanifest", "/app/demo.json", "/app/icons/icon-192.png"):
        assert client.get(path).status_code == 200, path
    assert "content-security-policy" not in client.get("/api/health").headers


# ---- operations of the phone app (sync/appops.py) ----------------------------------------------

import json
import subprocess
import sys

import pytest

from mtgdeck.sync import appops

AT = "2026-10-10T20:00:00+00:00"


def _op(type_, payload, op_id="op000001"):
    return {"id": op_id, "type": type_, "payload": payload, "at": AT}


def test_game_add_links_known_and_new_opponents_like_the_desktop_app():
    docs = {"decks/meren.json": _docs()["decks/meren.json"], "decks/.games/meren.json": None,
            "decks/.opponents.json": _docs()["decks/.opponents.json"]}  # fmt: skip
    game = {"id": "g9", "deck": "meren", "result": "loss", "turn": 7, "issues": ["combo", "bogus"], "how": "combo", "started": 1,
            "mvp": "Sol Ring", "note": "knapp"}  # fmt: skip
    slots = [{"id": "o1", "commander": "Atraxa, Praetors' Voice", "note": "Thoracle"},
             {"commander": "Korvold, Fae-Cursed King", "new_id": "newkorv", "colors": "BRG"}]  # fmt: skip
    out = appops.apply_copy(_op("game.add", {"game": game, "opponents": slots}), docs)
    entry = out["decks/.games/meren.json"][-1]
    assert entry == {"id": "g9", "played": AT, "result": "loss", "opponents": ["Atraxa, Praetors' Voice", "Korvold, Fae-Cursed King"],
                     "turn": 7, "issues": ["combo"], "mvp": "Sol Ring", "note": "knapp", "version": 2,
                     "opponent_ids": ["o1", "newkorv"], "how": "combo", "started": 1}  # fmt: skip
    opps = {o["id"]: o for o in out["decks/.opponents.json"]["opponents"]}
    assert opps["newkorv"]["commanders"] == ["Korvold, Fae-Cursed King"] and opps["newkorv"]["color_identity"] == ["B", "R", "G"]
    assert opps["o1"]["notes"][-1]["text"] == "Thoracle" and opps["o1"]["notes"][-1]["game_id"] == "g9"
    # the same game again changes nothing
    docs2 = {**docs, **out}
    assert appops.apply_copy(_op("game.add", {"game": game, "opponents": slots}, "op000002"), docs2) == {}


def test_game_add_matches_an_opponent_by_commander_and_rejects_bad_input():
    docs = {"decks/meren.json": _docs()["decks/meren.json"], "decks/.games/meren.json": [], "decks/.opponents.json": _docs()["decks/.opponents.json"]}
    out = appops.apply_copy(_op("game.add", {"game": {"id": "g1", "deck": "meren", "result": "win"}, "opponents": [{"commander": "krenko, mob boss"}]}), docs)
    assert out["decks/.games/meren.json"][0]["opponent_ids"] == ["o2"]
    with pytest.raises(appops.OpError, match="Ergebnis"):
        appops.apply_copy(_op("game.add", {"game": {"id": "g2", "deck": "meren", "result": "?"}}), docs)
    with pytest.raises(appops.OpError, match="gibt es nicht mehr"):
        appops.apply_copy(_op("game.add", {"game": {"id": "g2", "deck": "gone", "result": "win"}}), {**docs, "decks/gone.json": None})
    with pytest.raises(appops.OpError, match="Unbekanntes Deck"):
        appops.paths(_op("game.add", {"game": {"id": "g2", "deck": "../x", "result": "win"}}))
    with pytest.raises(appops.OpError, match="Unbekannte Aktion"):
        appops.paths(_op("deck.delete", {}))


def test_game_add_keeps_the_round_log_of_the_round_helper_cleaned():
    docs = {"decks/meren.json": _docs()["decks/meren.json"], "decks/.games/meren.json": [], "decks/.opponents.json": _docs()["decks/.opponents.json"]}
    at = "2026-10-10T20:05:00+00:00"
    events = [{"turn": 1, "kind": "life", "delta": -3, "from": "Atraxa, Praetors' Voice", "life": 37, "at": at},
              {"turn": 2, "kind": "turn", "delta": 1, "life": 37, "at": at},
              {"turn": 2, "kind": "cmd", "delta": 21, "from": "Atraxa, Praetors' Voice", "life": 16, "at": at},
              {"turn": 2, "kind": "note", "delta": 0, "text": "x" * 900, "at": at},
              {"turn": 2, "kind": "mill", "delta": 5, "at": at},              # unknown kind
              {"turn": 0, "kind": "life", "delta": -1, "at": at},             # no such turn
              {"turn": 2, "kind": "life", "delta": True, "at": "gestern"}]   # bad time
    round_log = {"start_life": 40, "life": 16, "poison": 0, "turns": 2, "started": AT, "ended": at,
                 "cmd": [{"name": "Atraxa, Praetors' Voice", "dmg": 21}, {"dmg": 3}], "events": events, "extra": "dropped"}
    game = {"id": "g1", "deck": "meren", "result": "loss", "turn": 2, "how": "commander", "round": round_log}
    entry = appops.apply_copy(_op("game.add", {"game": game, "opponents": [{"id": "o1"}]}), docs)["decks/.games/meren.json"][0]
    r = entry["round"]
    assert set(r) == {"start_life", "life", "poison", "turns", "started", "ended", "cmd", "events"}
    assert r["cmd"] == [{"name": "Atraxa, Praetors' Voice", "dmg": 21}]
    assert [e["kind"] for e in r["events"]] == ["life", "turn", "cmd", "note"]
    assert r["events"][0] == events[0] and len(r["events"][3]["text"]) == 500
    # a game without a round (or with a broken one) has no round key, like before
    plain = appops.apply_copy(_op("game.add", {"game": {**game, "id": "g2", "round": {"life": 3}}}, "op000002"), docs)
    assert "round" not in plain["decks/.games/meren.json"][0]


def test_game_add_keeps_finishing_places_aligned_with_the_opponents():
    docs = {"decks/meren.json": _docs()["decks/meren.json"], "decks/.games/meren.json": [], "decks/.opponents.json": _docs()["decks/.opponents.json"]}
    at = "2026-10-10T20:05:00+00:00"
    events = [{"turn": 4, "kind": "out", "delta": 1, "from": "Krenko, Mob Boss", "life": 30, "at": at}]
    round_log = {"start_life": 40, "life": 30, "turns": 6, "started": AT, "ended": at, "events": events}
    game = {"id": "g1", "deck": "meren", "result": "win", "place": 1, "round": round_log}
    slots = [{"id": "o1", "place": 2}, {"bogus": True}, {"commander": "Krenko, Mob Boss", "place": 3}]  # the middle slot is skipped
    entry = appops.apply_copy(_op("game.add", {"game": game, "opponents": slots}), docs)["decks/.games/meren.json"][0]
    assert (entry["place"], entry["opponent_places"], entry["opponent_ids"]) == (1, [2, 3], ["o1", "o2"])
    assert entry["round"]["events"][0]["kind"] == "out"
    # places outside 1..N (N = the user plus the opponents) and booleans are dropped; none noted = no keys
    bad = {"id": "g2", "deck": "meren", "result": "loss", "place": 4}
    out = appops.apply_copy(_op("game.add", {"game": bad, "opponents": [{"id": "o1", "place": True}, {"id": "o2", "place": 0}]}, "op000002"), docs)
    assert "place" not in out["decks/.games/meren.json"][0] and "opponent_places" not in out["decks/.games/meren.json"][0]


def test_opponent_operations():
    docs = {"decks/.opponents.json": None}
    out = appops.apply_copy(_op("opponent.add", {"opponent": {"id": "neu1", "commanders": ["Muldrotha, the Gravetide"], "colors": "UBG",
                                                               "player": "Jonas", "tags": ["graveyard", "x"]}, "note": "mag Friedhof"}), docs)  # fmt: skip
    o = out["decks/.opponents.json"]["opponents"][0]
    assert o["player"] == "Jonas" and o["tags"] == ["graveyard"] and o["notes"][0]["text"] == "mag Friedhof" and o["bracket"] is None
    docs = out
    docs = {**docs, **appops.apply_copy(_op("opponent.update", {"id": "neu1", "tags": ["combo"], "player": "Jo"}), docs)}
    docs = {**docs, **appops.apply_copy(_op("opponent.note", {"id": "neu1", "note_id": "n77", "text": "Thoracle"}), docs)}
    o = docs["decks/.opponents.json"]["opponents"][0]
    assert o["tags"] == ["combo"] and o["player"] == "Jo" and [n["id"] for n in o["notes"]][-1] == "n77"
    assert appops.apply_copy(_op("opponent.note", {"id": "neu1", "note_id": "n77", "text": "doppelt"}), docs) == {}
    docs = {**docs, **appops.apply_copy(_op("opponent.note_delete", {"id": "neu1", "note_id": "n77"}), docs)}
    assert all(n["id"] != "n77" for n in docs["decks/.opponents.json"]["opponents"][0]["notes"])
    docs = {**docs, **appops.apply_copy(_op("opponent.delete", {"id": "neu1"}), docs)}
    assert docs["decks/.opponents.json"]["opponents"] == []
    assert appops.apply_copy(_op("opponent.delete", {"id": "neu1"}), docs) == {}  # gone already


def test_opponent_edit_keeps_the_games_linked():
    docs = {"decks/.opponents.json": None}
    docs = {**docs, **appops.apply_copy(_op("opponent.add", {"opponent": {"id": "neu1", "commanders": ["Tymna the Weaver"], "colors": "WB"}}), docs)}
    game = {"id": "g1", "deck": "meren", "result": "loss"}
    docs = {**docs, "decks/meren.json": {"slug": "meren", "version": 1}, "decks/.games/meren.json": []}
    docs = {**docs, **appops.apply_copy(_op("game.add", {"game": game, "opponents": [{"id": "neu1", "commander": "Tymna the Weaver"}]}, "op000003"), docs)}
    edit = {"id": "neu1", "label": "Tims Tymna", "commanders": ["Tymna the Weaver", "Kraum, Ludevic's Opus"], "colors": "WUBR",
            "bracket": 4, "player": "Tim"}  # fmt: skip
    docs = {**docs, **appops.apply_copy(_op("opponent.update", edit, "op000004"), docs)}
    o = docs["decks/.opponents.json"]["opponents"][0]
    assert o["label"] == "Tims Tymna" and o["commanders"] == ["Tymna the Weaver", "Kraum, Ludevic's Opus"]
    assert o["color_identity"] == ["W", "U", "B", "R"] and o["bracket"] == 4 and o["player"] == "Tim"
    snap = appdata.snapshot(docs)
    assert snap["opponents"][0]["record"]["games"] == 1 and snap["opponents"][0]["title"].startswith("Tims Tymna")
    # partner removed again, unknown bracket; a missing commander is refused
    docs = {**docs, **appops.apply_copy(_op("opponent.update", {"id": "neu1", "commanders": ["Tymna the Weaver"], "colors": "WB", "bracket": None}, "op000005"), docs)}
    o = docs["decks/.opponents.json"]["opponents"][0]
    assert o["commanders"] == ["Tymna the Weaver"] and o["color_identity"] == ["W", "B"] and o["bracket"] is None
    with pytest.raises(appops.OpError):
        appops.apply_copy(_op("opponent.update", {"id": "neu1", "commanders": [" "]}, "op000006"), docs)


# ---- the routes: data, status, operations; a phone game reaches the PC ------------------------

def test_phone_reads_data_sends_operations_and_the_pc_gets_them(tmp_path, monkeypatch):
    from mtgdeck import games as games_mod, opponents as opponents_mod, storage
    from mtgdeck.jsonstore import write_json
    from mtgdeck.sync import Roots, service
    from mtgdeck.sync.remote import HttpTransport

    app = create_app(tmp_path / "server")
    client = TestClient(app)
    pc = Roots.current()
    service.connect(f"http://testserver/koppeln#{app.state.devices.new_code()['code']}", name="PC", roots=pc, client=client)
    storage.save({"name": "Meren", "commanders": ["Meren of Clan Nel Toth"], "bracket": 3, "cards": [{"name": "Sol Ring", "qty": 1, "category": "Ramp"}]})
    write_json(storage.DECKS_DIR / ".opponents.json", {"opponents": [{"id": "o1", "commanders": ["Atraxa, Praetors' Voice"], "player": "Tim", "tags": [], "notes": []}]})
    assert service.run(roots=pc, client=client)["ok"]

    phone = HttpTransport("http://testserver", client=client).claim(app.state.devices.new_code()["code"], "Handy", "phone")
    auth = {"Authorization": f"Bearer {phone['token']}"}
    assert client.get("/api/app/data").status_code == 401
    r = client.get("/api/app/data", headers=auth)
    data, etag = r.json(), r.headers["etag"]
    assert [d["slug"] for d in data["decks"]] == ["meren"] and data["opponents"][0]["player"] == "Tim"
    assert client.get("/api/app/data", headers={**auth, "If-None-Match": etag}).status_code == 304

    ops = [_op("game.add", {"game": {"id": "gphone1", "deck": "meren", "result": "win", "turn": 9, "how": "combat"},
                            "opponents": [{"id": "o1", "commander": "Atraxa, Praetors' Voice"}, {"commander": "Krenko, Mob Boss", "new_id": "krenko1", "colors": "R"}]}, "opphone01"),
           _op("game.add", {"game": {"id": "gphone2", "deck": "gone", "result": "win"}}, "opphone02"),
           _op("opponent.update", ["kaputt"], "opphone03"),
           _op("chat.ask", {"chat_id": "a" * 12, "message_id": "b" * 10, "question": "Hallo?"}, "opphone04")]  # fmt: skip
    res = client.post("/api/app/ops", json={"ops": ops}, headers=auth).json()
    assert res["results"][0] == {"id": "opphone01", "ok": True}
    assert res["results"][1]["ok"] is False and "gibt es nicht mehr" in res["results"][1]["error"]
    assert res["results"][2] == {"id": "opphone03", "ok": False, "error": "Ungültige Daten"}  # fails alone, never blocks the queue
    assert res["results"][3] == {"id": "opphone04", "ok": False, "error": "Unbekannte Aktion: chat.ask"}  # questions for Claude are gone
    assert res["etag"] != etag
    again = client.post("/api/app/ops", json={"ops": ops[:1]}, headers=auth).json()  # answer was lost: sent again
    assert again["results"][0]["ok"]
    data = client.get("/api/app/data", headers=auth).json()
    assert [g["id"] for g in data["games"]] == ["gphone1"] and data["decks"][0]["record"]["wins"] == 1

    status = client.get("/api/app/status", headers=auth).json()
    assert status["pcs"][0]["name"] == "PC" and status["device"]["name"] == "Handy"
    assert set(status["pcs"][0]) == {"name", "online", "last_seen"} and "jobs" not in status
    assert client.post("/api/jobs/claim", headers=auth).status_code in (404, 405)

    run = service.run(roots=pc, client=client)  # the PC syncs: the game is there as if typed in at the PC
    assert run["ok"] and "Partien mit „Meren“" in run["incoming"]
    entry = games_mod.games("meren")[0]
    assert entry["result"] == "win" and entry["how"] == "combat" and entry["opponent_ids"] == ["o1", "krenko1"]
    assert games_mod.summary("meren")["stats"]["wins"] == 1
    krenko = opponents_mod.get("krenko1")
    assert krenko["commanders"] == ["Krenko, Mob Boss"] and opponents_mod.record(krenko)["games"] == 1

    # deleted at the PC: the next sync pushes the shorter list, and the phone's next read no longer shows the game
    assert games_mod.delete("meren", "gphone1")
    run = service.run(roots=pc, client=client)
    assert run["ok"] and "Partien mit „Meren“" in run["outgoing"]
    after = client.get("/api/app/data", headers=auth).json()
    assert after["games"] == [] and after["decks"][0]["record"]["wins"] == 0


def test_pairing_link_and_root_lead_to_the_app_and_the_worker_is_versioned(tmp_path):
    client = TestClient(create_app(tmp_path))
    assert client.get("/koppeln", follow_redirects=False).headers["location"] == "/app/"
    assert client.get("/", follow_redirects=False).headers["location"] == "/app/"
    sw = client.get("/app/sw.js")
    assert sw.status_code == 200 and "__VERSION__" not in sw.text and sw.headers["cache-control"] == "no-cache"
    assert "worker-src 'self' blob:" in client.get("/app/").headers["content-security-policy"]
    # the worker gets the policy with sw.js and fetches the card images itself: the image CDN must be allowed there
    assert "connect-src 'self' https://api.scryfall.com https://*.scryfall.io" in sw.headers["content-security-policy"]


def test_the_phone_app_creates_a_pairing_link_with_a_qr_code_for_another_device(tmp_path):
    app = create_app(tmp_path, public_url="https://sync.example.de")
    client = TestClient(app)
    phone = client.post("/api/pair/claim", json={"code": app.state.devices.new_code()["code"], "name": "Handy", "kind": "phone"}).json()
    auth = {"Authorization": f"Bearer {phone['token']}"}
    got = client.post("/api/pair/start?qr=1", headers=auth).json()
    assert got["link"] == f"https://sync.example.de/koppeln#{got['code']}" and got["qr"].startswith("<svg")
    assert "qr" not in client.post("/api/pair/start", headers=auth).json()  # the PC renders its own
    ipad = client.post("/api/pair/claim", json={"code": got["code"], "name": "iPad", "kind": "phone"})
    assert ipad.status_code == 200 and ipad.json()["token"]
    assert client.post("/api/pair/start?qr=1").status_code == 401


def test_the_worker_precaches_the_fonts_but_not_their_licenses(tmp_path):
    sw = TestClient(create_app(tmp_path)).get("/app/sw.js").text
    assert "/app/fonts/cascadia-code-latin.woff2" in sw and "/app/fonts/inter-latin.woff2" in sw and "LICENSE.txt" not in sw


def test_the_server_image_needs_no_card_libraries(tmp_path):
    """The Docker image installs the package without its app dependencies (httpx, Pillow)."""
    code = f"""
import sys
class Block:
    def find_spec(self, name, path=None, target=None):
        if name.split('.')[0] in ('httpx', 'PIL'):
            raise ImportError('blocked ' + name)
sys.meta_path.insert(0, Block())
from mtgdeck.sync.server import create_app, app_snapshot, run_op
from mtgdeck.sync import cardsearch
import pytest
from fastapi.testclient import TestClient
app = create_app({str(tmp_path)!r})
print(app_snapshot(app.state.store)['decks'], TestClient(app).get('/app/sw.js').status_code)
"""
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "[] 200"


def test_card_search_composes_fixed_filters_and_cleans_the_model_query():
    from mtgdeck.sync import cardsearch

    assert cardsearch.compose('o:"draw a card"', ["B", "G"], ["creature"]) == 'o:"draw a card" id<=bg -id:c t:creature f:commander'
    assert cardsearch.compose("otag:ramp OR otag:mana-rock", ["C"], ["artifact", "land"]) == \
        "(otag:ramp OR otag:mana-rock) id:c (t:artifact OR t:land) f:commander"
    assert cardsearch.compose("otag:removal", ["C", "R"], ["nonsense"]) == "otag:removal id<=r f:commander"
    assert cardsearch.clean_query('  o:"dies"\n f:modern  legal:commander kw:flying ') == 'o:"dies" kw:flying'


def test_card_search_asks_the_model_and_maps_errors():
    import pytest
    from mtgdeck.sync import cardsearch

    seen = {}

    def fake(cfg, text):
        seen["cfg"], seen["text"] = cfg, text
        return '<think>hm</think>Here: {"query": "o:\\"whenever a creature you control dies\\" o:\\"draw\\"", "broader": "otag:death-trigger otag:draw", "explain": "Kartenzug, wenn eigene Kreaturen sterben"}'

    cfg = cardsearch.config({"key": "sk-secret-1234"})
    got = cardsearch.describe("zieht eine Karte wenn meine Kreatur stirbt", ["B"], [], cfg, ask=fake)
    assert got["query"] == 'o:"whenever a creature you control dies" o:"draw" id<=b -id:c f:commander'
    assert got["broader"] == "otag:death-trigger otag:draw id<=b -id:c f:commander" and got["explain"].startswith("Kartenzug")
    assert seen["text"] == "zieht eine Karte wenn meine Kreatur stirbt" and seen["cfg"]["model"] == cardsearch.DEFAULT_MODEL
    with pytest.raises(cardsearch.SearchError) as exc:
        cardsearch.describe("zieht Karten", [], [], cardsearch.config({}), ask=fake)
    assert exc.value.status == 409
    with pytest.raises(cardsearch.SearchError):
        cardsearch.describe("zieht Karten", [], [], cfg, ask=lambda c, t: "Sorry, no idea.")
    shown = cardsearch.public(cfg)
    assert {k: shown[k] for k in ("configured", "model", "from_env", "key_hint")} == {"configured": True, "model": cardsearch.DEFAULT_MODEL, "from_env": False, "key_hint": "…1234"}
    assert [m["id"] for m in shown["models"]] == list(cardsearch.MODELS) and "think" not in shown["models"][0]


def test_card_search_cache_key_ignores_wording_but_not_meaning():
    from mtgdeck.sync import cardsearch

    cfg = cardsearch.config({"key": "sk-x"})
    key = lambda t: cardsearch.cache_key(t, cfg)  # noqa: E731
    assert key("zieht eine Karte, wenn eine meiner Kreaturen stirbt") == key("Wenn meine Kreatur stirbt, ziehe ich eine Karte!")
    assert key("draw a card when a creature dies") == key("When a creature dies, draw a card")
    assert key("zieht eine Karte") != key("zieht keine Karte")  # negations count
    assert key("zieht zwei Karten") != key("zieht drei Karten")
    assert key("macht Schätze") != cardsearch.cache_key("macht Schätze", {**cfg, "model": "claude-opus-5-5"})


def test_card_search_routes_keep_the_key_on_the_server(tmp_path, monkeypatch):
    from mtgdeck.sync import cardsearch

    for var in ("MTG_AI_KEY", "MTG_AI_MODEL", "MTG_AI_URL"):
        monkeypatch.delenv(var, raising=False)
    app = create_app(tmp_path)
    client = TestClient(app)
    token = app.state.devices.claim(app.state.devices.new_code()["code"], "Handy", "phone")["token"]
    auth = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/app/ai").status_code == 401
    assert client.get("/api/app/ai", headers=auth).json()["configured"] is False
    r = client.post("/api/app/cards/describe", headers=auth, json={"text": "macht Schatzmarken"})
    assert r.status_code == 409 and "eingerichtet" in r.json()["detail"]

    r = client.put("/api/app/ai", headers=auth, json={"key": " sk-abcdefgh9876 ", "model": "claude-sonnet-5-5"})
    assert {k: r.json()[k] for k in ("configured", "model", "key_hint")} == {"configured": True, "model": "claude-sonnet-5-5", "key_hint": "…9876"}
    assert client.put("/api/app/ai", headers=auth, json={"model": "gpt-9"}).status_code == 400
    assert "sk-abcdefgh9876" not in client.get("/api/app/ai", headers=auth).text

    calls = []
    monkeypatch.setattr(cardsearch, "ask_model", lambda cfg, text: calls.append(cfg) or '{"query": "o:treasure", "explain": "Schätze"}')
    monkeypatch.setattr(cardsearch.translate, "__defaults__", (cardsearch.ask_model,))
    r = client.post("/api/app/cards/describe", headers=auth, json={"text": "macht Schatzmarken", "colors": ["R"], "types": ["creature"]})
    assert r.status_code == 200, r.text
    assert r.json() == {"query": "o:treasure id<=r -id:c t:creature f:commander", "broader": "", "explain": "Schätze", "cached": False}
    assert calls[0]["key"] == "sk-abcdefgh9876" and calls[0]["model"] == "claude-sonnet-5-5"
    # the same description again (other colours, spacing, case): from the cache, no new request
    r = client.post("/api/app/cards/describe", headers=auth, json={"text": "  Macht   Schatzmarken. ", "colors": ["G"]})
    assert r.json() == {"query": "o:treasure id<=g -id:c f:commander", "broader": "", "explain": "Schätze", "cached": True} and len(calls) == 1
    client.put("/api/app/ai", headers=auth, json={"model": "claude-haiku-5-5"})  # another model asks anew
    assert client.post("/api/app/cards/describe", headers=auth, json={"text": "macht Schatzmarken"}).json()["cached"] is False and len(calls) == 2

    for i in range(cardsearch.PER_MINUTE):
        client.post("/api/app/cards/describe", headers=auth, json={"text": f"macht {i} Schatzmarken"})
    assert client.post("/api/app/cards/describe", headers=auth, json={"text": "macht viele Schatzmarken"}).status_code == 429
    assert client.post("/api/app/cards/describe", headers=auth, json={"text": "macht Schatzmarken"}).status_code == 200  # cached: no limit

    assert client.put("/api/app/ai", headers=auth, json={"key": ""}).json()["configured"] is False
    monkeypatch.setenv("MTG_AI_KEY", "sk-from-env-0000")
    assert client.get("/api/app/ai", headers=auth).json()["from_env"] is True


def test_card_search_calls_the_claude_messages_api(monkeypatch):
    import io
    import json

    import pytest
    from mtgdeck.sync import cardsearch

    sent = {}

    class Answer(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout):
        sent["url"], sent["headers"], sent["body"] = req.full_url, dict(req.header_items()), json.loads(req.data)
        return Answer(json.dumps({"content": [{"type": "text", "text": '{"query": "otag:ramp"}'}], "stop_reason": "end_turn"}).encode())

    monkeypatch.setattr(cardsearch.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.delenv("MTG_AI_URL", raising=False)
    text = cardsearch.ask_model(cardsearch.config({"key": "sk-ant-x"}), "ramp")
    assert text == '{"query": "otag:ramp"}' and sent["url"] == "https://api.anthropic.com/v1/messages"
    assert sent["headers"]["X-api-key"] == "sk-ant-x" and sent["headers"]["Anthropic-version"] == cardsearch.API_VERSION
    assert "Authorization" not in sent["headers"] and sent["headers"]["User-agent"] == cardsearch.USER_AGENT
    body = sent["body"]
    assert body["model"] == cardsearch.DEFAULT_MODEL and body["system"] == cardsearch.PROMPT
    assert body["messages"] == [{"role": "user", "content": "ramp"}] and "temperature" not in body
    assert body["thinking"] == {"type": "disabled"}
    cardsearch.ask_model({**cardsearch.config({"key": "sk-ant-x"}), "model": "claude-sonnet-5-5"}, "ramp")
    assert sent["body"]["thinking"] == {"type": "between_tools"}
    cardsearch.ask_model({**cardsearch.config({"key": "sk-ant-x"}), "model": "claude-opus-5-5"}, "ramp")
    assert "thinking" not in sent["body"] and sent["body"]["output_config"] == {"effort": "low"}

    monkeypatch.setattr(cardsearch.urllib.request, "urlopen", lambda req, timeout: Answer(b'{"content": [], "stop_reason": "refusal"}'))
    with pytest.raises(cardsearch.SearchError):
        cardsearch.ask_model(cardsearch.config({"key": "sk-ant-x"}), "ramp")


def test_card_search_explains_missing_credit(monkeypatch):
    import io
    import urllib.error

    import pytest
    from mtgdeck.sync import cardsearch

    def no_funds(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 402, "Payment Required", {}, io.BytesIO(b'{"type": "error", "error": {"type": "billing_error"}}'))

    monkeypatch.setattr(cardsearch.urllib.request, "urlopen", no_funds)
    with pytest.raises(cardsearch.SearchError) as exc:
        cardsearch.ask_model(cardsearch.config({"key": "sk-ant-x"}), "ramp")
    assert exc.value.status == 402 and "Guthaben" in str(exc.value)


def test_deck_new_and_edit_save_versions_like_the_desktop_app():
    from mtgdeck.sync.appops import OpError, apply, paths

    new = _op("deck.new", {"deck": {"slug": "kaalia", "name": "Kaalia", "commanders": ["Kaalia of the Vast"], "bracket": 2}}, "opnew0001")
    assert paths(new) == ["decks/kaalia.json"]
    out = apply(new, {"decks/kaalia.json": None})
    deck = out["decks/kaalia.json"]
    assert deck["version"] == 1 and deck["cards"] == [] and deck["bracket"] == 2 and deck["needs_revalidation"]
    assert deck["history"][0]["note"] == "Leer angelegt (Am Tisch)" and out["decks/.versions/kaalia/v0001.json"]["version"] == 1
    with pytest.raises(OpError, match="gibt es schon"):
        apply(new, {"decks/kaalia.json": deck})
    with pytest.raises(OpError, match="Commander"):
        apply(_op("deck.new", {"deck": {"slug": "x", "commanders": []}}, "opnew0002"), {"decks/x.json": None})

    edit = _op("deck.edit", {"deck": "kaalia", "add": [{"name": "Sol Ring", "category": "Ramp"}, {"name": "Mountain", "qty": 3, "category": "Land"},
                                                      {"name": "Odd", "category": "Nonsense"}],
                             "set_qty": {"Mountain": 5}}, "opedit001")  # fmt: skip
    out = apply(edit, {"decks/kaalia.json": deck})
    deck2 = out["decks/kaalia.json"]
    assert {c["name"]: (c["qty"], c["category"]) for c in deck2["cards"]} == {"Sol Ring": (1, "Ramp"), "Mountain": (5, "Land"), "Odd": (1, "Synergy")}
    assert deck2["version"] == 2 and deck2["history"][-1]["note"].startswith("Am Tisch: + Sol Ring, 3× Mountain, Odd")
    assert deck2["history"][-1]["added"] == ["5 Mountain", "Odd", "Sol Ring"] and "decks/.versions/kaalia/v0002.json" in out
    assert deck["version"] == 1  # the input stays as it was

    out = apply(_op("deck.edit", {"deck": "kaalia", "remove": ["Odd"], "set_category": {"Sol Ring": "Draw"}, "note": "Test"}, "opedit002"),
                {"decks/kaalia.json": deck2})  # fmt: skip
    deck3 = out["decks/kaalia.json"]
    assert [c["name"] for c in deck3["cards"]] == ["Mountain", "Sol Ring"] and deck3["history"][-1]["note"] == "Test (Am Tisch: − Odd; Sol Ring → Draw)"
    assert apply(_op("deck.edit", {"deck": "kaalia", "set_qty": {"Mountain": 5}}, "opedit003"), {"decks/kaalia.json": deck3}) == {}
    with pytest.raises(OpError, match="Commander"):
        apply(_op("deck.edit", {"deck": "kaalia", "add": [{"name": "Kaalia of the Vast"}]}, "opedit004"), {"decks/kaalia.json": deck3})
    with pytest.raises(OpError, match="nicht mehr"):
        apply(_op("deck.edit", {"deck": "kaalia", "add": [{"name": "Sol Ring"}]}, "opedit005"), {"decks/kaalia.json": None})


def test_deck_edit_maybe_list():
    from mtgdeck.sync.appdata import snapshot
    from mtgdeck.sync.appops import OpError, apply

    deck = {"slug": "kaalia", "name": "Kaalia", "commanders": ["Kaalia of the Vast"], "version": 1, "history": [],
            "cards": [{"name": "Sol Ring", "qty": 1, "category": "Ramp"}]}  # fmt: skip
    out = apply(_op("deck.edit", {"deck": "kaalia", "maybe_add": [{"name": "Sol Ring"}, {"name": "Rhystic Study", "category": "Draw"}]}, "opmaybe01"),
                {"decks/kaalia.json": deck})  # fmt: skip
    d2 = out["decks/kaalia.json"]
    assert d2["cards"] == [] and d2["maybe"] == [{"name": "Rhystic Study", "category": "Draw"}, {"name": "Sol Ring", "category": "Ramp"}]
    assert d2["history"][-1]["note"] == "Am Tisch: Vielleicht + Rhystic Study; Sol Ring → Vielleicht" and d2["needs_revalidation"]
    assert snapshot({"decks/kaalia.json": d2})["decks"][0]["maybe"] == [{"name": "Rhystic Study", "category": "Draw"}, {"name": "Sol Ring", "category": "Ramp"}]
    out = apply(_op("deck.edit", {"deck": "kaalia", "add": [{"name": "Sol Ring", "category": "Ramp"}], "maybe_remove": ["Rhystic Study"]}, "opmaybe02"),
                {"decks/kaalia.json": d2})  # fmt: skip
    d3 = out["decks/kaalia.json"]
    assert [c["name"] for c in d3["cards"]] == ["Sol Ring"] and "maybe" not in d3
    assert apply(_op("deck.edit", {"deck": "kaalia", "maybe_remove": ["Nope"]}, "opmaybe03"), {"decks/kaalia.json": d3}) == {}
    with pytest.raises(OpError, match="Commander"):
        apply(_op("deck.edit", {"deck": "kaalia", "maybe_add": [{"name": "Kaalia of the Vast"}]}, "opmaybe04"), {"decks/kaalia.json": d3})
    with pytest.raises(OpError, match="Ungültige"):
        apply(_op("deck.edit", {"deck": "kaalia", "maybe_add": {"name": "x"}}, "opmaybe05"), {"decks/kaalia.json": d3})


def test_a_deck_built_on_the_tablet_reaches_the_pc_and_gets_checked(tmp_path):
    from mtgdeck import storage
    from mtgdeck.sync import Roots, service
    from mtgdeck.sync.remote import HttpTransport

    app = create_app(tmp_path / "server")
    client = TestClient(app)
    pc = Roots.current()
    service.connect(f"http://testserver/koppeln#{app.state.devices.new_code()['code']}", name="PC", roots=pc, client=client)
    storage.save({"name": "Meren", "commanders": ["Meren of Clan Nel Toth"], "bracket": 3, "cards": [{"name": "Sol Ring", "qty": 1, "category": "Ramp"}]})
    assert service.run(roots=pc, client=client)["ok"]
    tablet = HttpTransport("http://testserver", client=client).claim(app.state.devices.new_code()["code"], "iPad", "phone")
    auth = {"Authorization": f"Bearer {tablet['token']}"}

    ops = [_op("deck.new", {"deck": {"slug": "meren-2", "name": "Meren 2", "commanders": ["Meren of Clan Nel Toth"]}}, "opdeck001"),
           _op("deck.edit", {"deck": "meren-2", "add": [{"name": "Sol Ring", "category": "Ramp"}, {"name": "Forest", "qty": 2, "category": "Land"}]}, "opdeck002"),
           _op("deck.edit", {"deck": "meren", "add": [{"name": "Forest", "category": "Land"}], "set_qty": {"Sol Ring": 0}}, "opdeck003")]  # fmt: skip
    res = client.post("/api/app/ops", json={"ops": ops}, headers=auth).json()
    assert [r["ok"] for r in res["results"]] == [True, True, True], res
    data = client.get("/api/app/data", headers=auth).json()
    built = next(d for d in data["decks"] if d["slug"] == "meren-2")
    assert built["checking"] and built["version"] == 2 and {c["name"] for c in built["cards"]} == {"Sol Ring", "Forest"}

    run = service.run(roots=pc, client=client)
    assert run["ok"]
    assert storage.load("meren-2")["version"] == 2 and len(storage.versions("meren-2")) == 2
    assert [c["name"] for c in storage.load("meren")["cards"]] == ["Forest"] and storage.load("meren")["version"] == 2
    assert sorted(service.pending_revalidation()) == ["meren", "meren-2"]
    assert any(d["slug"] == "meren-2" for d in storage.list_decks())

    from mtgdeck.gui.app import app as gui_app

    gui = TestClient(gui_app)
    assert gui.get("/api/decks").status_code == 200
    assert gui.get("/api/decks/meren-2").status_code == 200  # not checked yet: still opens
    import asyncio

    assert sorted(asyncio.run(service.revalidate_pending())) == ["meren", "meren-2"]
    checked = storage.load("meren-2")
    assert checked["validation"]["commanders"] == ["Meren of Clan Nel Toth"] and "needs_revalidation" not in checked


# ---- the collection on the phone (scanner, Sammlung tab) ---------------------------------------

SID = "4cbc6901-6a4a-4d0a-83ea-7eefa3b35021"


def _scanned(qty=1, **kw):
    entry = {"id": "scan0001", "name": "Sol Ring", "qty": qty, "proxy": False, "foil": False, "lang": "en", "scryfall_id": SID,
             "set": "C21", "set_name": "Commander 2021", "collector_number": "263", "price_eur": "0.86",
             "image": f"https://cards.scryfall.io/normal/front/4/c/{SID}.jpg", "image_back": "https://evil.example/x.jpg"}  # fmt: skip
    return {"entry": {**entry, **kw}}


def test_collection_add_merges_like_the_desktop_collection():
    out = appops.apply(_op("collection.add", _scanned(2)), {"collection.json": None})
    [e] = out["collection.json"]
    assert e["id"] == "scan0001" and e["qty"] == 2 and e["set"] == "c21" and e["added"] == AT and e["note"] == ""
    assert e["image"].startswith("https://cards.scryfall.io/") and e["image_back"] is None  # only Scryfall's image CDN
    more = appops.apply(_op("collection.add", _scanned(1, id="scan0002")), {"collection.json": out["collection.json"]})
    assert len(more["collection.json"]) == 1 and more["collection.json"][0]["qty"] == 3  # same printing: more copies
    proxy = appops.apply(_op("collection.add", _scanned(1, id="scan0003", proxy=True)), {"collection.json": more["collection.json"]})
    assert [x["proxy"] for x in proxy["collection.json"]] == [False, True]
    back = appops.apply(_op("collection.add", _scanned(-1, proxy=True)), {"collection.json": proxy["collection.json"]})  # undo
    assert [x["qty"] for x in back["collection.json"]] == [3]
    assert appops.apply(_op("collection.add", _scanned(-1, foil=True)), {"collection.json": back["collection.json"]}) == {}
    for bad in (_scanned(0), _scanned(1, name=""), {"entry": "x"}):
        with pytest.raises(appops.OpError):
            appops.apply(_op("collection.add", bad), {"collection.json": None})


def test_collection_update_changes_flags_and_quantities_and_merges():
    items = [{"id": "a1", "name": "Sol Ring", "qty": 2, "proxy": False, "foil": False, "lang": "en", "scryfall_id": SID, "note": "vom PC"},
             {"id": "b2", "name": "Sol Ring", "qty": 1, "proxy": True, "foil": False, "lang": "en", "scryfall_id": SID}]  # fmt: skip
    out = appops.apply_copy(_op("collection.update", {"id": "b2", "proxy": False}), {"collection.json": items})
    assert out["collection.json"] == [{**items[0], "qty": 3}]  # now the same as the first entry: one entry
    out = appops.apply_copy(_op("collection.update", {"id": "a1", "qty": 0}), {"collection.json": items})
    assert [x["id"] for x in out["collection.json"]] == ["b2"]
    assert appops.apply_copy(_op("collection.update", {"id": "gone", "qty": 0}), {"collection.json": items}) == {}
    assert appops.apply_copy(_op("collection.update", {"id": "a1", "qty": 2}), {"collection.json": items}) == {}
    with pytest.raises(appops.OpError):
        appops.apply_copy(_op("collection.update", {"id": "gone", "foil": True}), {"collection.json": items})


def test_collection_place_keeps_entries_apart_and_moves_them():
    out = appops.apply(_op("collection.add", _scanned(2, place="Binder rot")), {"collection.json": None})
    out = appops.apply(_op("collection.add", _scanned(1, id="scan0002", place=" binder  ROT")), out)
    out = appops.apply(_op("collection.add", _scanned(1, id="scan0003", place_deck="meren", place="egal")), out)
    items = out["collection.json"]
    assert [(e["place"], e["place_deck"], e["qty"]) for e in items] == [("Binder rot", "", 3), ("egal", "meren", 1)]
    bad = appops.apply(_op("collection.add", _scanned(1, id="scan0004", place_deck="../x", place=5)), out)
    assert bad["collection.json"][-1]["place"] == "" and bad["collection.json"][-1]["place_deck"] == ""
    moved = appops.apply_copy(_op("collection.update", {"id": "scan0001", "place": "", "place_deck": "meren"}), {"collection.json": items})
    assert [(e["id"], e["qty"]) for e in moved["collection.json"]] == [("scan0001", 4)]  # same deck now: one entry
    assert appops.apply_copy(_op("collection.update", {"id": "scan0003", "place_deck": "meren"}), {"collection.json": items}) == {}


def test_snapshot_has_the_collection_without_notes_and_derivable_images():
    snap = appdata.snapshot({"collection.json": [
        {"id": "a1", "name": "Sol Ring", "qty": 2, "proxy": False, "foil": True, "lang": "de", "scryfall_id": SID, "set": "c21",
         "image": "https://cards.scryfall.io/normal/x.jpg", "note": "privat", "price_eur": "1.20"},
        {"id": "m1", "name": "Arcane Signet", "qty": 1, "proxy": True, "image": "https://cards.scryfall.io/png/y.png"}, "kaputt"]})  # fmt: skip
    assert [e["name"] for e in snap["collection"]] == ["Arcane Signet", "Sol Ring"]
    sol = snap["collection"][1]
    assert "note" not in sol and "image" not in sol and sol["foil"] and sol["lang"] == "de" and sol["price_eur"] == "1.20"
    assert snap["collection"][0]["image"].endswith("y.png") and snap["collection"][0]["lang"] == "en"
    assert appdata.snapshot({})["collection"] == []


def test_cards_scanned_on_the_phone_reach_the_pc_collection(tmp_path):
    from mtgdeck import collection
    from mtgdeck.sync import Roots, service
    from mtgdeck.sync.remote import HttpTransport

    app = create_app(tmp_path / "server")
    client = TestClient(app)
    pc = Roots.current()
    service.connect(f"http://testserver/koppeln#{app.state.devices.new_code()['code']}", name="PC", roots=pc, client=client)
    collection._write([collection._entry("Arcane Signet", qty=1, note="Binder 2")])
    assert service.run(roots=pc, client=client)["ok"]
    phone = HttpTransport("http://testserver", client=client).claim(app.state.devices.new_code()["code"], "Handy", "phone")
    auth = {"Authorization": f"Bearer {phone['token']}"}
    data = client.get("/api/app/data", headers=auth).json()
    assert [e["name"] for e in data["collection"]] == ["Arcane Signet"]

    signet = data["collection"][0]["id"]
    ops = [_op("collection.add", _scanned(2), "opcoll001"), _op("collection.add", _scanned(1, id="scan0002", foil=True, lang="de"), "opcoll002"),
           _op("collection.update", {"id": signet, "proxy": True}, "opcoll003")]  # fmt: skip
    res = client.post("/api/app/ops", json={"ops": ops}, headers=auth).json()
    assert [r["ok"] for r in res["results"]] == [True, True, True], res
    assert client.post("/api/app/ops", json={"ops": ops[:1]}, headers=auth).json()["results"][0]["ok"]  # resent: no third copy
    data = client.get("/api/app/data", headers=auth).json()
    assert sum(e["qty"] for e in data["collection"] if e["name"] == "Sol Ring") == 3

    run = service.run(roots=pc, client=client)
    assert run["ok"] and "Sammlung" in run["incoming"]
    owned = collection.load()
    sol = sorted((e for e in owned if e["name"] == "Sol Ring"), key=lambda e: e["qty"])
    assert [(e["qty"], e["foil"], e["lang"]) for e in sol] == [(1, True, "de"), (2, False, "en")]
    signet_entry = next(e for e in owned if e["name"] == "Arcane Signet")
    assert signet_entry["proxy"] and signet_entry["note"] == "Binder 2"  # the PC's note stays
    assert collection.owned_counts()["Sol Ring"] == {"real": 3, "proxy": 0}


def test_the_card_scanner_loads_its_text_recognition_lazily(tmp_path):
    client = TestClient(create_app(tmp_path))
    sw = client.get("/app/sw.js").text
    assert "/app/js/scan.js" in sw and "/app/vendor/tesseract/" not in sw.split("const FILES = ")[1].split("\n")[0]  # not precached
    for path in ("/app/vendor/tesseract/worker.min.js", "/app/vendor/tesseract/tesseract-core-simd-lstm.wasm", "/app/vendor/tesseract/eng.traineddata.gz"):
        assert client.get(path).status_code == 200, path
    csp = client.get("/app/").headers["content-security-policy"]
    assert "script-src 'self' 'wasm-unsafe-eval';" in csp and "unsafe-eval'" not in csp.replace("'wasm-unsafe-eval'", "")
