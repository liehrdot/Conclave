"""The desktop shell's bridge (poll: tooltip, notices, commands; what the web app sees of it)."""

import time

from fastapi.testclient import TestClient

from mtgdeck import settings
from mtgdeck.gui import app as gui
from mtgdeck.gui import desktop

def test_without_a_shell_nothing_is_shown_or_queued():
    client = TestClient(gui.app)
    assert client.get("/api/desktop").json() == {"shell": None, "notify": True}
    assert desktop.notify("Deck fertig") is None  # nobody listens
    assert client.post("/api/desktop/command", json={"type": "open_data"}).status_code == 409


def test_shell_poll_reports_state_and_fetches_notices_and_commands_once():
    client = TestClient(gui.app)
    r = client.post("/api/desktop/poll", json={"since": 0, "visible": False, "autostart": True, "version": "0.1.0"}).json()
    assert r["notices"] == [] and r["commands"] == [] and r["tooltip"] == "Conclave"
    shell = client.get("/api/desktop").json()["shell"]
    assert shell["version"] == "0.1.0" and shell["autostart"] is True and shell["visible"] is False
    n = desktop.notify("Deck fertig", "„Meren“ ist gespeichert.")
    client.post("/api/desktop/command", json={"type": "autostart", "value": False})
    client.post("/api/desktop/command", json={"type": "autostart", "value": True})  # replaces the older one
    client.post("/api/desktop/command", json={"type": "open_log"})
    r = client.post("/api/desktop/poll", json={"since": 0}).json()
    assert [x["title"] for x in r["notices"]] == ["Deck fertig"] and r["since"] == n["id"]
    assert r["commands"] == [{"type": "autostart", "value": True}, {"type": "open_log"}]
    r = client.post("/api/desktop/poll", json={"since": r["since"]}).json()
    assert r["notices"] == [] and r["commands"] == []
    assert client.post("/api/desktop/command", json={"type": "reboot"}).status_code == 422
    # the update state travels with the poll and reaches the web app; the install command is queued like any other
    client.post("/api/desktop/poll", json={"update": {"state": "available", "current": "0.1.0", "version": "0.2.0"}})
    assert client.get("/api/desktop").json()["shell"]["update"]["version"] == "0.2.0"
    client.post("/api/desktop/command", json={"type": "install_update"})
    assert client.post("/api/desktop/poll", json={}).json()["commands"] == [{"type": "install_update"}]


def test_notices_follow_the_setting_and_the_tooltip_shows_the_state(monkeypatch):
    client = TestClient(gui.app)
    client.post("/api/desktop/poll", json={})
    settings.update({"desktop_notify": False})
    assert desktop.notify("x") is None
    settings.update({"desktop_notify": True})
    assert desktop.notify("x")["title"] == "x"
    monkeypatch.setattr(gui, "_sync_view", lambda: {"connected": True, "last_ok": time.time() - 150, "running": False,
                                                    "online": True})  # fmt: skip
    gui.JOBS["t1"] = gui.Job(id="t1")
    try:
        tip = client.post("/api/desktop/poll", json={}).json()["tooltip"].split("\n")
    finally:
        gui.JOBS.pop("t1", None)
    assert tip == ["Conclave", "Ein Auftrag läuft", "Sync: vor 2 Min."]
