"""The desktop app's versions on GitHub: stable releases and preview builds (prereleases from every push to master,
`.github/workflows/preview.yml`). The shell asks ``feed()`` which ``latest.json`` to check: the stable one by default,
the newest of all with the setting „Vorschau-Versionen anzeigen“ on, or one picked version for going back. The
signature in that file is still checked against the key in ``tauri.conf.json``, so a feed can only offer our builds.
"""

from __future__ import annotations

import re
from typing import Any

from .. import http, settings

REPO = "liehrdot/Conclave"  # renamed from mtgdeckbuilder; GitHub redirects the old URLs
API = f"https://api.github.com/repos/{REPO}/releases"
DOWNLOAD = f"https://github.com/{REPO}/releases/download/"
STABLE_FEED = f"https://github.com/{REPO}/releases/latest/download/latest.json"
TTL = 600  # seconds; GitHub allows 60 unauthenticated API calls an hour
_FEED = re.compile(re.escape(DOWNLOAD) + r"[A-Za-z0-9._-]+/latest\.json", re.IGNORECASE)  # no ../ or %2e tricks
_SEMVER = re.compile(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?")


def version_key(v: str) -> tuple:
    """Sort key for versions like 0.1.9 and 0.1.10-preview.42 (a prerelease sorts before its release)."""
    m = _SEMVER.fullmatch(v.lstrip("v"))
    if not m:
        return (-1,)
    pre = m.group(4)
    parts = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split(".")) if pre else ()
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), 0 if pre else 1, parts)


def parse(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Published releases that carry a ``latest.json`` (an empty or draft one cannot be installed), newest first."""
    out = []
    for r in raw:
        if r.get("draft"):
            continue
        feed = next((a.get("browser_download_url") for a in r.get("assets") or [] if a.get("name") == "latest.json"), None)
        tag = str(r.get("tag_name") or "")
        version = tag.removeprefix("preview-").lstrip("v")
        if not feed or not _FEED.fullmatch(str(feed)) or version_key(version) == (-1,):
            continue
        out.append({"version": version, "tag": tag, "preview": bool(r.get("prerelease")), "feed": feed,
                    "date": r.get("published_at"), "notes": (r.get("body") or "").strip()[:500]})  # fmt: skip
    out.sort(key=lambda r: version_key(r["version"]), reverse=True)
    return out


async def available(preview: bool | None = None) -> list[dict[str, Any]]:
    """The installable versions; preview builds only with the setting on (or ``preview=True``)."""
    if preview is None:
        preview = bool(settings.load().get("desktop_preview", False))
    raw = await http.get_json(API, params={"per_page": 50}, ttl=TTL)
    return [r for r in parse(raw if isinstance(raw, list) else []) if preview or not r["preview"]]


async def feed(version: str | None = None) -> dict[str, Any]:
    """The ``latest.json`` the shell should check. Without ``version``: the stable feed, or with previews on the
    newest build of all. With ``version``: exactly that one (going back to an older version)."""
    preview = bool(settings.load().get("desktop_preview", False))
    if not version and not preview:
        return {"feed": STABLE_FEED, "preview": False}
    found = await available(preview=preview)  # a preview build only with the setting on, also when going back
    if version:
        pick = next((r for r in found if r["version"] == version.lstrip("v")), None)
        if not pick:
            raise LookupError(f"Version {version} gibt es nicht (oder sie hat keine Update-Datei).")
        return {"feed": pick["feed"], "preview": pick["preview"], "version": pick["version"]}
    return {"feed": found[0]["feed"] if found else STABLE_FEED, "preview": True}
