"""Where this installation keeps its files.

Three roots, each overridable by one environment variable:

- ``home()`` – the user's data (decks, collection, blacklist, table rules, backups, proxies, settings, sync state).
  ``MTG_HOME``; otherwise the repository root when running from a checkout (``uv run mtg-gui``), or the platform's
  app-data folder when running as the packaged desktop app (``%APPDATA%\\MTG Deckbuilder`` on Windows).
  The per-file variables (``MTG_DECKS_DIR`` …) still win over it.
- ``cache_home()`` – card database and HTTP cache (large, re-creatable). ``MTG_CACHE_HOME``; otherwise
  ``~/.cache/mtgdeck`` or ``%LOCALAPPDATA%\\app.mtgdeck.desktop\\cache`` when packaged (the desktop shell passes
  ``--cache``; the folder is named after the app identifier because a per-user install itself lives in
  ``%LOCALAPPDATA%\\Conclave``).

No imports from the rest of the package: every module reads its default path from here.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "Conclave"  # the name people see (window, tray, installer)
# The data folders keep the app's old name, so the decks of existing installs stay where they are.
DATA_FOLDER = "MTG Deckbuilder"
APP_ID = "app.mtgdeck.desktop"  # the desktop app's identifier (tauri.conf.json)
REPO_ROOT = Path(__file__).resolve().parents[2]


def frozen() -> bool:
    """Running as the packaged desktop backend (PyInstaller)."""
    return bool(getattr(sys, "frozen", False))


def bundle_dir() -> Path:
    """The packaged app's read-only files (``_internal/`` of the PyInstaller folder build)."""
    return Path(getattr(sys, "_MEIPASS", REPO_ROOT))


def _platform_data() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / DATA_FOLDER
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / DATA_FOLDER
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "mtgdeck"


def _platform_cache() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / APP_ID / "cache"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / DATA_FOLDER
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "mtgdeck"


def home() -> Path:
    env = os.environ.get("MTG_HOME")
    if env:
        return Path(env).expanduser()
    return _platform_data() if frozen() else REPO_ROOT


def cache_home() -> Path:
    env = os.environ.get("MTG_CACHE_HOME")
    if env:
        return Path(env).expanduser()
    return _platform_cache() if frozen() else Path.home() / ".cache" / "mtgdeck"


def inside(base: Path, *parts: str) -> Path:
    """``base / parts`` – refused (``ValueError``) when the result would leave ``base``.

    Every path built from a deck slug, an order id or another name that came in over the API goes through this,
    on top of the name checks themselves (``storage.slug()``, the id patterns).
    """
    root = os.path.abspath(base)
    target = os.path.abspath(os.path.join(root, *parts))
    if target != root and not target.startswith(root + os.sep):
        raise ValueError(f"Pfad außerhalb von {root}: {os.path.join(*parts) if parts else ''}")
    return Path(target)
