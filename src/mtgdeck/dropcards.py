"""Cards dragged into the app from another window (scryfall.com, mostly).

A browser drag carries up to three flavours: ``text/uri-list`` (the link or image under the
pointer), ``text/html`` (the dragged markup: ``<a href><img src alt></a>``) and ``text/plain``.
``refs()`` turns them into Scryfall identifiers, ``resolve()`` into English card names.
"""

from __future__ import annotations

import html as html_mod
import re
from typing import Any
from urllib.parse import unquote, urlsplit

from . import scryfall
from .cards import resolve as resolve_names

MAX_CARDS = 30  # one drop; a dragged selection of a whole search page stays bounded
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_UUID_RE = re.compile(_UUID, re.I)
_URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.I)
_ATTR_RE = re.compile(r"""\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.I)
_ALT_RE = re.compile(r"""\balt\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.I)
_QTY_RE = re.compile(r"^\s*(\d+)\s*x?\s+", re.I)


def from_url(url: str) -> dict[str, str] | None:
    """A Scryfall identifier from a card page, API or image link; None for anything else."""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    path = [unquote(p) for p in parts.path.split("/") if p]
    if not (host == "scryfall.com" or host.endswith(".scryfall.com") or host.endswith(".scryfall.io")):
        return None
    if host in ("scryfall.com", "www.scryfall.com", "api.scryfall.com"):
        if len(path) >= 2 and path[0] == "cards" and _UUID_RE.fullmatch(path[1]):  # api: /cards/<id>
            return {"id": path[1].lower()}
        if len(path) >= 3 and path[0] in ("card", "cards") and path[1] not in ("named", "search", "collection"):
            return {"set": path[1].lower(), "collector_number": path[2].lower()}  # /card/<set>/<number>[/<slug>]
        return None
    found = _UUID_RE.search(parts.path)  # image CDN: …/front/a/b/<id>.jpg
    return {"id": found.group(0).lower()} if found else None


def _name_line(line: str) -> str:
    """'1x Sol Ring' / 'Sol Ring (C21) 263' → 'Sol Ring'."""
    line = _QTY_RE.sub("", line.strip())
    return re.sub(r"\s\([A-Za-z0-9]{2,6}\)(?:\s*[\w★-]+)?$", "", line.strip()).strip()


def refs(uri_list: str = "", html: str = "", text: str = "") -> list[dict[str, str]]:
    """Identifiers for the dragged cards, in drop order, without duplicates.

    The uri-list holds what was under the pointer, so it wins; the markup is next (it may hold a
    whole selection); plain text last (a link, or card names one per line).
    """
    uris = [u for u in (uri_list or "").splitlines() if u.strip() and not u.startswith("#")]
    found = [r for r in map(from_url, uris) if r]
    if not found and html:
        attrs = [(kind.lower(), html_mod.unescape(a or b)) for kind, a, b in _ATTR_RE.findall(html)]
        hrefs = [r for kind, u in attrs if kind == "href" and (r := from_url(u))]
        found = hrefs or [r for _, u in attrs if (r := from_url(u))]  # <a><img></a> carries both: one card, not two
        if not found:
            found = [{"name": html_mod.unescape(a or b).strip()} for a, b in _ALT_RE.findall(html) if (a or b).strip()]
    if not found and text:
        urls = _URL_RE.findall(text)
        found = [r for r in map(from_url, urls) if r]
        if not urls:
            found = [{"name": n} for n in map(_name_line, text.splitlines()) if 2 <= len(n) <= 150]
    out: list[dict[str, str]] = []
    for r in found:
        if r not in out:
            out.append(r)
    return out[:MAX_CARDS]


async def resolve(found: list[dict[str, str]]) -> dict[str, Any]:
    """``{"cards": [{name, image, type_line}], "missing": [what was not found]}`` in drop order."""
    printed = [r for r in found if "name" not in r]
    cards, _ = await scryfall.by_identifiers(printed) if printed else ([], 0)
    by_ref = {id(r): c for r, c in zip(printed, cards)}
    names = [r["name"] for r in found if "name" in r]
    data, renames, _ = await resolve_names(names) if names else ({}, {}, [])
    out: list[dict[str, Any]] = []
    missing: list[str] = []
    for r in found:
        if "name" in r:
            card = data.get(renames.get(r["name"], r["name"]))
            label = r["name"]
        else:
            raw = by_ref.get(id(r))
            card = scryfall.compact(raw, with_text=False) if raw else None
            label = r.get("id") or f"{r.get('set', '').upper()} {r.get('collector_number', '')}"
        if not card:
            missing.append(label)
        elif all(c["name"] != card["name"] for c in out):
            out.append({"name": card["name"], "image": card.get("image"), "type_line": card.get("type_line", "")})
    return {"cards": out, "missing": missing}
