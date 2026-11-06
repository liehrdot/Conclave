"""Reading Scryfall's bulk files and card objects, and Cardmarket's price figures: pure functions, stdlib only.

Conclave's card DB (``carddb``), its Scryfall client (``scryfall``) and Cardmarket prices (``cardmarket``) use them, and so
does Conclave Cards (github.com/liehrdot/Conclave-Cards), whose import builds the same rows: which printing stands for a
card and how Oracle tags roll up must give the same answers in both. Rename or change one only together with a pin bump
there.
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any, Iterable, Iterator

# Layouts in the bulk file that are not deck cards.
SKIP_LAYOUTS = {"token", "double_faced_token", "emblem", "art_series", "planar", "scheme", "vanguard", "augment", "host"}


def find_bulk(items: list[dict[str, Any]], *types: str) -> dict[str, Any] | None:
    for item in items:
        if item.get("type") in types:
            return item
    for item in items:  # fallback on the human-readable name
        if (item.get("name") or "").lower().replace(" ", "_") in types:
            return item
    return None


def iter_jsonl_gz(path: Path) -> Iterator[dict[str, Any]]:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip().rstrip(",")
            if not line or line in ("[", "]"):
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue


def oracle_id(card: dict[str, Any]) -> str | None:
    if card.get("oracle_id"):
        return card["oracle_id"]
    faces = card.get("card_faces") or []  # reversible cards keep the oracle id on the faces
    return faces[0].get("oracle_id") if faces else None


def is_commander(card: dict[str, Any]) -> bool:
    type_line = (card.get("type_line") or "").split("//")[0]
    text = card.get("oracle_text") or " ".join(f.get("oracle_text", "") for f in card.get("card_faces") or [])
    return ("Legendary" in type_line and "Creature" in type_line) or "can be your commander" in text


def printing_score(card: dict[str, Any]) -> int:
    """Which printing represents the card (image, default text): English, paper, normal frame."""
    return (
        8 * (card.get("lang") == "en")
        + 4 * (not card.get("digital"))
        + 2 * (not card.get("promo"))
        + (card.get("image_status") == "highres_scan")
    )


def tag_rows(objs: Iterable[dict[str, Any]]) -> Iterator[tuple[str, str]]:
    """Yield (oracle_id, tag slug) pairs from the Oracle Tags bulk file.

    One line per tag: {"object": "tag", "id", "slug", "type": "oracle", "parent_ids": [...],
    "aliases": [...], "taggings": [{"oracle_id", "weight", ...}]}. Membership in a child tag does
    not roll up to its parents in the file, so we add every ancestor ourselves: a card tagged
    'removal-creature' also counts as 'removal'.
    """
    tags = [o for o in objs if o.get("slug") or o.get("label")]
    by_id = {t.get("id"): t for t in tags if t.get("id")}

    def ancestors(tag: dict[str, Any], seen: set[str]) -> set[str]:
        out: set[str] = set()
        for pid in tag.get("parent_ids") or []:
            parent = by_id.get(pid)
            if parent is None or pid in seen:
                continue
            seen.add(pid)
            out.add(parent.get("slug") or parent["label"])
            out |= ancestors(parent, seen)
        return out

    for tag in tags:
        slugs = {tag.get("slug") or tag["label"]} | ancestors(tag, set())
        for tagging in tag.get("taggings") or tag.get("oracle_ids") or []:
            oid = tagging.get("oracle_id") if isinstance(tagging, dict) else tagging
            if oid:
                for slug in slugs:
                    yield oid, slug


def faces_text(card: dict[str, Any], field: str) -> str:
    if card.get(field):
        return card[field]
    faces = card.get("card_faces") or []
    return " // ".join(f.get(field, "") for f in faces if f.get(field))


def image(card: dict[str, Any], size: str = "normal") -> str | None:
    if "image_uris" in card:
        return card["image_uris"].get(size)
    faces = card.get("card_faces") or []
    if faces and "image_uris" in faces[0]:
        return faces[0]["image_uris"].get(size)
    return None


def back_image(card: dict[str, Any], size: str = "normal") -> str | None:
    """Image of the back face for double-faced cards (transform, MDFC, ...), else None."""
    faces = card.get("card_faces") or []
    if "image_uris" not in card and len(faces) > 1 and "image_uris" in faces[1]:
        return faces[1]["image_uris"].get(size)
    return None


def price(v: Any) -> float | None:
    """A price figure as a float; missing, broken or 0 → None."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None
