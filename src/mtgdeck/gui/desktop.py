"""The bridge between the backend and the desktop shell (Tauri, ``desktop/src-tauri``).

The shell polls ``POST /api/desktop/poll`` every few seconds with what it knows (its version, whether the window is
visible, whether autostart is on, the update state) and gets back the tray tooltip, new notices (it shows them as system
notifications while the window is hidden) and the commands the web app queued for it (autostart on/off, open the
data folder or the log). With ``wait`` the poll is held until a notice or command comes up (a long poll, so a click
on „Update installieren“ reaches the shell at once). While an update installs, the shell also pushes its state to
``POST /api/desktop/update`` every few hundred milliseconds (``report_update()``); the ``rev`` counter keeps the newest
of a push and a poll that cross. Everything lives in memory. When no shell polls (the app runs in a browser),
``present()`` is False, ``shell()`` is None and ``notify()`` does nothing.
"""

from __future__ import annotations

import itertools
import threading
import time
from typing import Any

from .. import settings

MAX_NOTICES = 50
SHELL_TIMEOUT = 45.0  # seconds without a poll: there is no shell (browser), or it is gone
MAX_WAIT = 20.0  # longest a poll is held

_lock = threading.Lock()
_wake = threading.Condition(_lock)
_ids = itertools.count(1)
_shell: dict[str, Any] = {}
_notices: list[dict[str, Any]] = []
_commands: list[dict[str, Any]] = []


def reset() -> None:
    with _lock:
        _shell.clear()
        _notices.clear()
        _commands.clear()


def present() -> bool:
    with _lock:
        return bool(_shell) and time.time() - _shell.get("seen", 0.0) < SHELL_TIMEOUT


def shell() -> dict[str, Any] | None:
    """What the web app may show about the shell, or None in a browser."""
    if not present():
        return None
    with _lock:
        return {k: _shell.get(k) for k in ("version", "autostart", "visible", "update", "features", "seen")}


def _take_update(update: Any) -> None:
    """Keep the shell's update state unless an older one (lower ``rev``) arrives after a newer one. Under ``_lock``."""
    old = _shell.get("update")
    if isinstance(update, dict) and isinstance(old, dict) and update.get("rev", 0) < old.get("rev", 0):
        return
    _shell["update"] = update


def poll(info: dict[str, Any], since: int, wait: float = 0) -> dict[str, Any]:
    """The shell reports its state and fetches the notices newer than ``since`` plus the queued commands (once).
    With ``wait`` (seconds) it blocks until there is something to fetch or the time is up."""
    deadline = time.monotonic() + min(max(wait, 0), MAX_WAIT)
    since = max(int(since), 0)
    with _lock:
        _shell.update({k: info[k] for k in ("version", "autostart", "visible", "features") if k in info}, seen=time.time())
        if "update" in info:
            _take_update(info["update"])
        # bounded by the deadline, whatever ``since`` is
        while (left := deadline - time.monotonic()) > 0 and not _commands and not (_notices and _notices[-1]["id"] > since):
            _wake.wait(left)
        _shell["seen"] = time.time()
        notices = [n for n in _notices if n["id"] > since]
        commands, _commands[:] = list(_commands), []
        last = _notices[-1]["id"] if _notices else since
    return {"notices": notices, "commands": commands, "since": max(since, last)}


def notify(title: str, body: str = "", kind: str = "info") -> dict[str, Any] | None:
    """Queue a system notification (the shell shows it only while the window is hidden). None when no shell is
    listening or notifications are switched off in the settings."""
    if not present() or not settings.load().get("desktop_notify", True):
        return None
    notice = {"id": next(_ids), "at": time.time(), "title": title, "body": body, "kind": kind}
    with _lock:
        _notices.append(notice)
        del _notices[:-MAX_NOTICES]
        _wake.notify_all()
    return notice


def report_update(update: dict[str, Any]) -> None:
    """The shell's update state between polls (download progress, the current step)."""
    with _lock:
        if _shell:
            _take_update(update)
            _shell["seen"] = time.time()


def command(kind: str, value: Any = None) -> dict[str, Any]:
    """Queue a command for the shell; a newer command of the same kind replaces an older unsent one."""
    cmd: dict[str, Any] = {"type": kind}
    if value is not None:
        cmd["value"] = value
    with _lock:
        _commands[:] = [c for c in _commands if c["type"] != kind] + [cmd]
        _wake.notify_all()
    return cmd
