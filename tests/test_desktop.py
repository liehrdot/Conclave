"""The desktop shell's bridge (poll: tooltip, notices, commands; what the web app sees of it)."""

import time

from fastapi.testclient import TestClient

from mtgdeck import settings
from mtgdeck.gui import app as gui
from mtgdeck.gui import desktop, releases

def test_without_a_shell_nothing_is_shown_or_queued():
    client = TestClient(gui.app)
    assert client.get("/api/desktop").json() == {"shell": None, "notify": True, "preview": False}
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
    # a shell that opens moxfield.com links in its own window says so; older shells send no features
    assert client.get("/api/desktop").json()["shell"]["features"] is None
    client.post("/api/desktop/poll", json={"features": ["moxfield"]})
    assert client.get("/api/desktop").json()["shell"]["features"] == ["moxfield"]


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


def _release(tag, *, pre=False, draft=False, feed=True, date="2026-10-16T08:00:00Z"):
    assets = [{"name": "Conclave_x64-setup.exe", "browser_download_url": releases.DOWNLOAD + tag + "/setup.exe"}]
    if feed:
        assets.append({"name": "latest.json", "browser_download_url": releases.DOWNLOAD + tag + "/latest.json"})
    return {"tag_name": tag, "prerelease": pre, "draft": draft, "published_at": date, "body": "", "assets": assets}


GITHUB = [
    _release("v0.1.7"),
    _release("preview-0.1.10-preview.12", pre=True),
    _release("v0.1.8", feed=False),  # the empty locked release: cannot be installed
    _release("v0.1.9"),
    _release("preview-0.1.10-preview.9", pre=True),
    _release("v0.2.0", draft=True),  # still being built
]


def test_versions_sort_like_semver_with_previews_between_releases():
    order = ["0.1.9", "0.1.10-preview.9", "0.1.10-preview.12", "0.1.10", "0.2.0"]
    assert sorted(reversed(order), key=releases.version_key) == order


async def test_feed_is_stable_unless_previews_are_on_or_a_version_is_picked(monkeypatch):
    calls = []

    async def fake(url, params=None, ttl=0):
        calls.append(url)
        return GITHUB

    monkeypatch.setattr(releases.http, "get_json", fake)
    assert await releases.feed() == {"feed": releases.STABLE_FEED, "preview": False}
    assert calls == []  # the stable check needs no GitHub API call
    assert [r["version"] for r in await releases.available()] == ["0.1.9", "0.1.7"]
    settings.update({"desktop_preview": True})
    assert [r["version"] for r in await releases.available()] == ["0.1.10-preview.12", "0.1.10-preview.9", "0.1.9", "0.1.7"]
    assert (await releases.feed())["feed"].endswith("/preview-0.1.10-preview.12/latest.json")
    old = await releases.feed("0.1.7")
    assert old == {"feed": releases.DOWNLOAD + "v0.1.7/latest.json", "preview": False, "version": "0.1.7"}
    try:
        await releases.feed("0.1.8")
        raise AssertionError("an empty release must not be offered")
    except LookupError:
        pass


async def test_feed_only_takes_this_repos_files_and_previews_only_with_the_setting(monkeypatch):
    evil = _release("v0.3.0")
    evil["assets"][1]["browser_download_url"] = releases.DOWNLOAD + "../../../../other/repo/releases/download/x/latest.json"
    encoded = _release("v0.3.1")
    encoded["assets"][1]["browser_download_url"] = releases.DOWNLOAD + "%2e%2e/latest.json"

    async def fake(url, params=None, ttl=0):
        return [*GITHUB, evil, encoded]

    monkeypatch.setattr(releases.http, "get_json", fake)
    assert [r["version"] for r in await releases.available(preview=True)][:2] == ["0.1.10-preview.12", "0.1.10-preview.9"]
    assert "0.3.0" not in [r["version"] for r in await releases.available(preview=True)]
    try:  # going back to a preview build needs the setting, like the list in the settings panel
        await releases.feed("0.1.10-preview.9")
        raise AssertionError("a preview build must not be installable with the setting off")
    except LookupError:
        pass
    settings.update({"desktop_preview": True})
    assert (await releases.feed("0.1.10-preview.9"))["version"] == "0.1.10-preview.9"


def test_routes_offer_versions_and_queue_the_switch(monkeypatch):
    async def fake(url, params=None, ttl=0):
        return GITHUB

    monkeypatch.setattr(releases.http, "get_json", fake)
    client = TestClient(gui.app)
    r = client.get("/api/desktop/releases").json()
    assert r["preview"] is False and [x["version"] for x in r["releases"]] == ["0.1.9", "0.1.7"]
    assert client.get("/api/desktop/feed", params={"version": "0.1.7"}).json()["feed"].endswith("/v0.1.7/latest.json")
    assert client.get("/api/desktop/feed", params={"version": "9.9.9"}).status_code == 404
    client.post("/api/settings", json={"desktop_preview": True})
    assert client.get("/api/desktop").json()["preview"] is True
    assert client.get("/api/desktop/feed").json()["preview"] is True
    client.post("/api/desktop/poll", json={})
    assert client.post("/api/desktop/command", json={"type": "install_version"}).status_code == 422
    client.post("/api/desktop/command", json={"type": "install_version", "value": "0.1.7"})
    assert client.post("/api/desktop/poll", json={}).json()["commands"] == [{"type": "install_version", "value": "0.1.7"}]


def test_feed_falls_back_to_stable_when_github_is_unreachable(monkeypatch):
    async def down(url, params=None, ttl=0):
        raise releases.http.HttpError(0, url, "keine Verbindung")

    monkeypatch.setattr(releases.http, "get_json", down)
    settings.update({"desktop_preview": True})
    client = TestClient(gui.app)
    assert client.get("/api/desktop/feed").json() == {"feed": releases.STABLE_FEED, "preview": False}
    r = client.get("/api/desktop/feed", params={"version": "0.1.7"})
    assert r.status_code == 502 and "GitHub" in r.json()["detail"]
