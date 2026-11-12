"""„Was ist neu?“: what a new version brings, shown once after an update (issue #129).

The notes are the release notes in ``releasenotes/<version>.md`` (the release workflow puts the same file on the
GitHub release). Which version this device has already seen lives in the setting ``whatsnew_seen`` (per device,
not synced). After an update the GUI shows every version newer than the seen one up to the running one, so a jump
over a release shows both. A preview build (``0.3.1-preview.42``) shows the notes of its coming release (``0.3.1``).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .. import settings, storage
from .releases import version_key

NOTES_DIR = Path(__file__).parent / "releasenotes"
_ITEM = re.compile(r"-\s+\*\*(.+?)\*\*\s*(.*)")
_HEAD = re.compile(r"\*\*(.+)\*\*")


def base(version: str) -> str:
    """The release a version belongs to: ``0.3.1-preview.42`` → ``0.3.1``."""
    return version.lstrip("v").split("-", 1)[0]


def parse(text: str) -> dict[str, Any]:
    """A notes file → ``{title, items: [{title, text}]}``. The bullets ``- **Title:** text`` are the items; other
    lines (the installer note at the end) are for the GitHub page only."""
    title, items = "", []
    for line in text.splitlines():
        line = line.strip()
        if m := _ITEM.fullmatch(line):
            items.append({"title": m.group(1).rstrip(":").strip(), "text": m.group(2).strip()})
        elif not title and not items and (m := _HEAD.fullmatch(line)):
            title = m.group(1).strip()
    return {"title": title, "items": items}


def all_notes() -> list[dict[str, Any]]:
    """Every version with notes, newest first."""
    out = []
    for f in NOTES_DIR.glob("*.md"):
        if version_key(f.stem)[0] < 0:
            continue
        note = parse(f.read_text("utf-8"))
        if note["items"]:
            out.append({"version": f.stem, **note})
    out.sort(key=lambda n: version_key(n["version"]), reverse=True)
    return out


def current(version: str) -> dict[str, Any] | None:
    """The notes of the running version (a preview build: of its coming release), else the newest older ones."""
    now = version_key(base(version))
    return next((n for n in all_notes() if version_key(n["version"]) <= now), None)


def _has_data() -> bool:
    """Someone used Conclave before this feature existed (an update, not a fresh install)."""
    return any(storage.DECKS_DIR.glob("*.json")) if storage.DECKS_DIR.is_dir() else False


def state(version: str) -> dict[str, Any]:
    """What to show for the running ``version``: ``show`` once after an update, with the ``releases`` newer than
    the seen version (up to this one). A fresh install shows nothing; a device updated from a version without this
    feature (nothing seen yet, but decks exist) gets this version's notes. Going back to an older version shows
    nothing either."""
    seen = str(settings.load().get("whatsnew_seen") or "")
    now = version_key(base(version))
    if seen:
        since = version_key(base(seen))
        releases = [n for n in all_notes() if since < version_key(n["version"]) <= now]
    elif _has_data():
        releases = [n for n in all_notes() if version_key(n["version"]) == now]
    else:
        releases = []
    return {"version": version, "preview": "-" in version, "seen": seen or None, "show": bool(releases),
            "releases": releases}  # fmt: skip


def mark_seen(version: str) -> None:
    settings.update({"whatsnew_seen": version})
