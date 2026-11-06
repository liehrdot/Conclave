"""When two collection entries are the same thing, and how a place is stored: no imports, so the sync server's phone
operations (``sync/appops``) use it as well as ``collection`` (which needs the network stack). The phone web app
(``collKey`` in ``sync/app/js/apply.js``) and the iPhone app mirror ``key``; ``docs/app-api/ops.json`` checks them.
"""

from __future__ import annotations

import re
from typing import Any

PLACE_MAX = 80
DECK_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,80}")


def key(e: dict[str, Any]) -> tuple[Any, ...]:
    """Entries with the same key merge: name, printing, proxy, foil, language and place (a deck, else the place text)."""
    return (str(e.get("name") or "").lower(), e.get("scryfall_id") or "", bool(e.get("proxy")), bool(e.get("foil")), e.get("lang") or "en",
            e.get("place_deck") or "", "" if e.get("place_deck") else str(e.get("place") or "").strip().lower())  # fmt: skip


def clean_place(place: Any, place_deck: Any) -> tuple[str, str]:
    """(place, place_deck) as stored: trimmed text (≤ ``PLACE_MAX``), a deck slug only when it looks like one."""
    text = " ".join(str(place or "").split())[:PLACE_MAX]
    slug = str(place_deck or "").strip()
    return text, slug if DECK_SLUG.fullmatch(slug) else ""
