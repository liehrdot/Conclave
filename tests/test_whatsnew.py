"""„Was ist neu?“ (issue #129): the release notes once after an update, per device."""

import pytest
from fastapi.testclient import TestClient

from mtgdeck import storage
from mtgdeck.gui import app as gui
from mtgdeck.gui import whatsnew

NOTE = "**Neu in Conclave {v}**\n\n- **Feature {v}:** Text mit **fett**.\n- **Zweites:** Noch etwas.\n\nWindows-Installer …\n"


@pytest.fixture
def notes(tmp_path, monkeypatch):
    folder = tmp_path / "notes"
    folder.mkdir()
    for v in ("0.2.1", "0.3.0", "0.3.1", "0.10.0"):
        (folder / f"{v}.md").write_text(NOTE.format(v=v), "utf-8")
    (folder / "README.md").write_text("not a version", "utf-8")
    monkeypatch.setattr(whatsnew, "NOTES_DIR", folder)
    return folder


def _deck():
    storage.DECKS_DIR.mkdir(parents=True, exist_ok=True)
    (storage.DECKS_DIR / "meren.json").write_text("{}", "utf-8")


def test_parse_keeps_the_bullets_and_drops_the_installer_line():
    n = whatsnew.parse(NOTE.format(v="1.0.0"))
    assert n["title"] == "Neu in Conclave 1.0.0"
    assert n["items"] == [{"title": "Feature 1.0.0", "text": "Text mit **fett**."}, {"title": "Zweites", "text": "Noch etwas."}]


def test_versions_sort_as_numbers(notes):
    assert [n["version"] for n in whatsnew.all_notes()] == ["0.10.0", "0.3.1", "0.3.0", "0.2.1"]
    assert whatsnew.current("0.3.1-preview.7")["version"] == "0.3.1"
    assert whatsnew.current("0.4.0")["version"] == "0.3.1"  # no notes of its own: the newest older ones


def test_fresh_install_shows_nothing(notes):
    s = whatsnew.state("0.3.1")
    assert s["show"] is False and s["seen"] is None


def test_first_update_with_this_feature_shows_the_running_version(notes):
    _deck()  # used before: an update, not a fresh install
    s = whatsnew.state("0.3.1")
    assert s["show"] and [r["version"] for r in s["releases"]] == ["0.3.1"]


def test_shown_once_then_only_newer_versions_and_a_skipped_release_too(notes):
    whatsnew.mark_seen("0.2.1")
    assert [r["version"] for r in whatsnew.state("0.3.1")["releases"]] == ["0.3.1", "0.3.0"]
    whatsnew.mark_seen("0.3.1")
    assert whatsnew.state("0.3.1")["show"] is False
    assert whatsnew.state("0.3.0")["show"] is False  # going back shows nothing


def test_preview_build_shows_its_coming_release_once(notes):
    whatsnew.mark_seen("0.3.0")
    s = whatsnew.state("0.3.1-preview.42")
    assert s["preview"] and [r["version"] for r in s["releases"]] == ["0.3.1"]
    whatsnew.mark_seen("0.3.1-preview.42")
    assert whatsnew.state("0.3.1-preview.43")["show"] is False
    assert whatsnew.state("0.3.1")["show"] is False  # the release itself was already shown as a preview


def test_routes_use_the_shell_version_and_remember_what_was_seen(notes):
    _deck()
    client = TestClient(gui.app)
    assert client.get("/api/whatsnew").json()["version"] == gui.VERSION
    client.post("/api/desktop/poll", json={"version": "0.3.1-preview.5"})  # a preview build: only the shell knows
    r = client.get("/api/whatsnew").json()
    assert r["show"] and r["version"] == "0.3.1-preview.5" and r["releases"][0]["version"] == "0.3.1"
    assert client.post("/api/whatsnew/seen", json={"version": "0.3.1-preview.5"}).json() == {"ok": True}
    assert client.get("/api/whatsnew").json()["show"] is False
    every = client.get("/api/whatsnew?all=1").json()
    assert every["current"]["version"] == "0.3.1" and len(every["releases"]) == 4
    assert client.post("/api/whatsnew/seen", json={"version": "../x"}).status_code == 422
    assert client.post("/api/whatsnew/seen", json={"version": "0.3.1 evil"}).status_code == 422


def test_the_running_version_has_notes():
    """Every release carries a notes file: the GitHub release and the app's „Was ist neu?“ show it."""
    real = {n["version"]: n for n in whatsnew.all_notes()}
    assert gui.VERSION in real, f"src/mtgdeck/gui/releasenotes/{gui.VERSION}.md fehlt"
    assert all(n["items"] for n in real.values())
