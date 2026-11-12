"""Local web GUI: decks with images, stats and bracket check, the deck editor, games, opponents, the
collection, printing and sync.

Start: ``uv run mtg-gui`` -> http://127.0.0.1:8765
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import subprocess
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlunsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .. import opponents as opponents_mod
from ..jsonstore import ConflictError, StoreError
from .. import backup, blacklist, brackets, buylist, carddb, collection, deckedit, deckimport, dropcards, importers, games, glossary, health, openinghand, precons, printorders, proxy, rule0, scryfall, speed, storage, tablerules
from .. import paths
from .. import settings as settings_mod
from ..cards import card_text, deck_tokens, name_choices, resolve
from ..deck import DeckEntry, to_text
from ..http import HttpError
from ..power import TIER_LABELS, PowerProfile
from ..sync.remote import RemoteError
from . import desktop as desktop_mod, jobs, terminal, whatsnew
from . import sync as gui_sync
from .routes import backups as backup_routes, collection as collection_routes, describe as describe_routes, desktop as desktop_routes, selling as selling_routes

log = logging.getLogger(__name__)

STATIC = Path(__file__).parent / "static"
GUI_TOKEN = os.environ.get("MTG_GUI_TOKEN", "")  # set by the desktop shell: every request must carry it (cookie or Bearer)
TOKEN_COOKIE = "mtg_token"
VERSION = "0.3.0"


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    auto = os.environ.get("MTG_SYNC_AUTO", "1") != "0"
    tasks = [asyncio.create_task(gui_sync.loop())] if auto else []
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()


app = FastAPI(title="Conclave", lifespan=_lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "testserver"}
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_OPEN_PATHS = ("/api/health", "/static/", "/favicon")  # readable without the token (nothing personal in them)


def _token_ok(request: Request) -> bool:
    if not GUI_TOKEN:
        return True
    given = request.cookies.get(TOKEN_COOKIE) or request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    return secrets.compare_digest(given, GUI_TOKEN) if given else False


def _local_only() -> bool:
    """Only when bound to this computer: a GUI opened to the network (MTG_GUI_HOST=0.0.0.0) accepts any host."""
    return os.environ.get("MTG_GUI_HOST", "127.0.0.1") in ("127.0.0.1", "localhost", "::1")


@app.middleware("http")
async def _guard(request: Request, call_next: Any) -> Any:
    """Protection against web pages that talk to the local GUI (DNS rebinding, cross-site POSTs): the Host must
    be this computer, and changing requests must not come from another site's page."""
    if _local_only():
        from urllib.parse import urlsplit

        host = urlsplit("//" + request.headers.get("host", "")).hostname or ""
        if host not in _LOCAL_HOSTS:
            return JSONResponse({"detail": "Unbekannter Host"}, status_code=400)
        origin = request.headers.get("origin")
        if origin and request.method not in _SAFE_METHODS and (urlsplit(origin).hostname or "") not in _LOCAL_HOSTS:
            return JSONResponse({"detail": "Anfrage von einer fremden Seite abgelehnt"}, status_code=403)
    if GUI_TOKEN and not request.url.path.startswith(_OPEN_PATHS):
        if request.url.path == "/" and request.query_params.get("token"):  # the desktop shell's first link
            if not secrets.compare_digest(request.query_params["token"], GUI_TOKEN):
                return JSONResponse({"detail": "Ungültiges Zugriffstoken"}, status_code=401)
            response = RedirectResponse("/", status_code=303)
            # Lax, not Strict: the shell's start page lives on another site (tauri.localhost), and a Strict cookie
            # is not sent on the navigation that follows this redirect – the window would show the 401 JSON. Lax
            # still keeps the cookie out of cross-site POSTs and embedded requests; the Origin check covers the rest.
            # Secure whenever the page itself came over HTTPS; the desktop backend on 127.0.0.1 is plain HTTP, where a
            # Secure cookie would never be sent back
            response.set_cookie(TOKEN_COOKIE, GUI_TOKEN, httponly=True, samesite="lax", path="/", secure=request.url.scheme == "https")
            return response
        if not _token_ok(request):
            return JSONResponse({"detail": "Kein Zugriff: Die Oberfläche gehört zur Desktop-App. Bitte dort öffnen."}, status_code=401)
    response = await call_next(request)
    path = request.url.path
    if request.method not in _SAFE_METHODS and path.startswith("/api/") and not path.startswith("/api/sync") and response.status_code < 400:
        gui_sync.mark_dirty()
    return response


@app.exception_handler(StoreError)
async def _store_error(_request: Request, exc: StoreError) -> JSONResponse:
    """Damaged/locked data files and edit conflicts: a clear message instead of a bare 500."""
    return JSONResponse({"detail": str(exc)}, status_code=409 if isinstance(exc, ConflictError) else 503)


@app.exception_handler(RemoteError)
async def _remote_error(_request: Request, exc: RemoteError) -> JSONResponse:
    """The own sync server: a wrong code is the user's input, anything else the server/connection."""
    return JSONResponse({"detail": str(exc)}, status_code=400 if exc.status in (400, 403, 429) else 502)


@app.exception_handler(FileNotFoundError)
async def _not_found(_request: Request, exc: FileNotFoundError) -> JSONResponse:
    """A deck, order, version, backup … that doesn't exist: the domain modules raise this with a German message."""
    return JSONResponse({"detail": str(exc)}, status_code=404)


@app.exception_handler(ValueError)
async def _bad_request(_request: Request, exc: ValueError) -> JSONResponse:
    """Input the domain modules refuse (they raise ValueError with a German message): the user's mistake, not a bug."""
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(HttpError)
async def _http_error(_request: Request, exc: HttpError) -> JSONResponse:
    """Scryfall, EDHREC … unreachable or failing: say which service and what to do, not a bare 500."""
    return JSONResponse({"detail": exc.friendly}, status_code=502)


async def _set_table_rule(slug: str, rule_id: str | None, note: str = "") -> dict[str, Any]:
    """Give a saved deck a table rule (or none), re-validate and save it as a new version."""
    for attempt in range(3):
        try:
            return await _set_table_rule_once(slug, rule_id, note)
        except ConflictError:
            if attempt == 2:
                raise
    raise AssertionError("unreachable")


async def _set_table_rule_once(slug: str, rule_id: str | None, note: str) -> dict[str, Any]:
    deck = storage.load(slug)
    start_version = deck.get("version")
    rs = tablerules.get(rule_id) if rule_id else None
    if rule_id and rs is None:
        raise FileNotFoundError(f"Unbekannte Tischregel: {rule_id}")
    old = tablerules.get(deck.get("table_rule"))
    deck["table_rule"] = rs["id"] if rs else None
    await deckedit.revalidate(deck)
    deck["change_note"] = note or (f"Tischregel: {rs['name']}" if rs else "Tischregel entfernt" + (f" ({old['name']})" if old else ""))
    storage.save(deck, expect_version=start_version)
    return deck


# --- routes ------------------------------------------------------------------------------------


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
async def api_health() -> dict[str, Any]:
    """Readiness for the desktop shell (no token needed): the backend is up and serving this data folder."""
    return {"ok": True, "service": "mtgdeck-gui", "version": VERSION, "home": str(paths.home()), "frozen": paths.frozen()}


def _running_version() -> str:
    """The version the user runs: the desktop shell's (a preview build only changes the shell's number), else ours."""
    v = str((desktop_mod.shell() or {}).get("version") or "")
    return v if _VERSION_RE.fullmatch(v) else VERSION


_VERSION_RE = re.compile(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?")


@app.get("/api/whatsnew")
async def api_whatsnew(all: bool = False) -> dict[str, Any]:
    """„Was ist neu?“: once after an update the notes of the new version(s) (``show``); ``all=1`` every version's."""
    if all:
        version = _running_version()
        return {"version": version, "preview": "-" in version, "current": whatsnew.current(version), "releases": whatsnew.all_notes()}
    return whatsnew.state(_running_version())


class WhatsNewSeen(BaseModel):
    version: str = Field(pattern=f"^{_VERSION_RE.pattern}$", max_length=60)


@app.post("/api/whatsnew/seen")
async def api_whatsnew_seen(req: WhatsNewSeen) -> dict[str, Any]:
    whatsnew.mark_seen(req.version)
    return {"ok": True}


app.include_router(desktop_routes.router)



class NewDeckRequest(BaseModel):
    name: str = Field("", max_length=120)
    commander: str = Field(min_length=2)
    partner: str | None = None
    bracket: int = Field(2, ge=1, le=5)
    currency: str = "eur"


@app.post("/api/decks/new")
async def api_deck_new(req: NewDeckRequest) -> dict[str, Any]:
    """An empty deck with just its commander(s) – put together by hand (no AI needed)."""
    names = [n.strip() for n in (req.commander, req.partner) if n and n.strip()]
    cards, renames, missing = await resolve(names)
    if missing:
        raise HTTPException(404, f"Karte nicht gefunden: {', '.join(missing)}")
    commanders = [renames.get(n, n) for n in names]
    deck = await deckimport.save(name=req.name.strip() or " + ".join(commanders), commanders=commanders, cards=[],
                                 bracket=req.bracket, currency=req.currency, note="Leer angelegt")  # fmt: skip
    return {"slug": deck["slug"]}


@app.get("/api/brackets")
async def api_brackets() -> list[dict[str, Any]]:
    return brackets.BRACKETS


@app.get("/api/autocomplete")
async def api_autocomplete(q: str) -> list[str]:
    try:
        return await scryfall.autocomplete(q)
    except HttpError:
        return []


@app.get("/api/card")
async def api_card(name: str, choices: bool = False) -> dict[str, Any]:
    """One card by name; ``choices=1`` adds ``choices`` when the name also is a face of another card
    (a prepared spell), so the GUI can ask which one is meant."""
    try:
        cards, _, missing = await resolve([name])
    except Exception as exc:
        raise HTTPException(502, f"Kartendaten nicht erreichbar: {jobs.error_text(exc)}") from exc
    if missing or not cards:
        raise HTTPException(404, f"Karte nicht gefunden: {name}")
    card = next(iter(cards.values()))
    return {**card, "choices": await name_choices(name)} if choices else card


class DropRequest(BaseModel):
    uri_list: str = Field("", max_length=20_000)
    html: str = Field("", max_length=200_000)
    text: str = Field("", max_length=20_000)


@app.post("/api/cards/drop")
async def api_cards_drop(req: DropRequest) -> dict[str, Any]:
    """Cards dragged in from another window (scryfall.com links, card images or names)."""
    found = dropcards.refs(req.uri_list, req.html, req.text)
    if not found:
        raise HTTPException(400, "Das ist keine Karte. Zieh ein Kartenbild oder einen Kartenlink von scryfall.com herein.")
    return await dropcards.resolve(found)


app.include_router(describe_routes.router)



@app.get("/api/cards/text")
async def api_card_text(name: str, lang: str = "de") -> dict[str, Any]:
    try:
        data = await card_text(name, lang)
    except Exception as exc:
        raise HTTPException(502, f"Kartendaten nicht erreichbar: {jobs.error_text(exc)}") from exc
    if not data:
        raise HTTPException(404, f"Karte nicht gefunden: {name}")
    return data


@app.get("/api/glossary")
async def api_glossary() -> list[dict[str, Any]]:
    return glossary.entries()


class GameIn(BaseModel):
    result: str = Field(pattern="^(win|loss|draw)$")
    opponents: list[str] = Field(default_factory=list, max_length=5)
    opponent_ids: list[str | None] = Field(default_factory=list, max_length=5)  # chosen opponent decks, same order
    opponent_notes: list[str] = Field(default_factory=list, max_length=5)  # "what stood out", same order
    remember_opponents: bool = True
    turn: int | None = Field(default=None, ge=1, le=60)
    issues: list[str] = Field(default_factory=list)
    mvp: str | None = None
    note: str = Field(default="", max_length=2000)
    how: str | None = None  # games.HOW: how the game was decided
    place: int | None = Field(default=None, ge=1, le=games.PLACES_MAX)  # the user's finishing place
    opponent_places: list[int | None] = Field(default_factory=list, max_length=5)  # same order as opponents


@app.get("/api/decks/{slug}/games")
async def api_games(slug: str) -> dict[str, Any]:
    storage.load(slug)
    return games.summary(slug)


@app.post("/api/decks/{slug}/games")
async def api_game_add(slug: str, req: GameIn) -> dict[str, Any]:
    deck = storage.load(slug)
    slots = [{"commander": o.strip(), "id": (req.opponent_ids[i] if i < len(req.opponent_ids) else None),
              "note": (req.opponent_notes[i] if i < len(req.opponent_notes) else ""),
              "place": (req.opponent_places[i] if i < len(req.opponent_places) else None)}
             for i, o in enumerate(req.opponents) if o.strip()]  # fmt: skip
    mvp, opponents = req.mvp, [s["commander"] for s in slots]
    names = [n for n in [mvp or "", *opponents] if n.strip()]
    if names:  # English Oracle names where they resolve (German input works too)
        try:
            _, renames, _ = await resolve(names)
        except Exception:
            renames = {}
        mvp = renames.get(mvp or "", mvp)
        opponents = [renames.get(o, o) for o in opponents]
    if req.result not in games.RESULTS or any(i not in games.ISSUES for i in req.issues):
        raise HTTPException(400, "Ungültiges Ergebnis oder Problem")
    game_id = uuid.uuid4().hex[:10]
    for s, name in zip(slots, opponents):
        s["commander"] = name
    ids = await opponents_mod.link_game(slug, game_id, slots, remember=req.remember_opponents) if slots else []
    entry = games.add(slug, result=req.result, opponents=opponents, turn=req.turn, issues=req.issues, mvp=mvp,
                      note=req.note, version=deck.get("version"), entry_id=game_id, opponent_ids=ids, how=req.how or None,
                      place=req.place, opponent_places=[s["place"] for s in slots])  # fmt: skip
    return {"game": entry, **games.summary(slug)}


@app.delete("/api/decks/{slug}/games/{game_id}")
async def api_game_delete(slug: str, game_id: str) -> dict[str, Any]:
    if not games.delete(slug, game_id):
        raise HTTPException(404, "Partie nicht gefunden")
    return games.summary(slug)


@app.get("/api/decks/{slug}/rule0")
async def api_rule0(slug: str) -> dict[str, Any]:
    return rule0.build(storage.load(slug))


class ImportPreviewRequest(BaseModel):
    url: str | None = None
    text: str | None = None
    name: str | None = None


async def _import_url(url: str) -> dict[str, Any]:
    """A deck from a site link; a site that answers 404 usually means a private deck."""
    try:
        return await importers.import_url(url)
    except HttpError as exc:  # before RuntimeError: HttpError is one
        status = 404 if exc.status == 404 else 502
        raise HTTPException(status, "Deck nicht gefunden – ist es öffentlich?" if status == 404 else exc.friendly) from exc
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"Seite nicht erreichbar: {jobs.error_text(exc)}") from exc


@app.post("/api/import/preview")
async def api_import_preview(req: ImportPreviewRequest) -> dict[str, Any]:
    if req.url and req.url.strip():
        data = await _import_url(req.url)
    else:
        data = importers.import_text(req.text or "", req.name)
    if not data["cards"]:
        raise HTTPException(400, "Keine Karten gefunden.")
    return await deckimport.preview(data)


class ImportRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    commanders: list[str] = Field(min_length=1, max_length=2)
    cards: list[str] = Field(min_length=1)
    categories: dict[str, str] = Field(default_factory=dict)
    bracket: int | None = Field(None, ge=1, le=5)
    currency: str = Field("eur", pattern="^(eur|usd)$")
    site: str = ""
    source: str = ""


@app.post("/api/import")
async def api_import(req: ImportRequest) -> dict[str, Any]:
    where = f"{req.site}: {req.source}" if req.source else (req.site or "Liste")
    return await deckimport.save(
        name=req.name.strip(), commanders=req.commanders, cards=req.cards, categories=req.categories, bracket=req.bracket,
        currency=req.currency, description=f"Importiert von {where}." if req.source else "",
        note=f"Importiert ({req.site or 'Liste'})", extra={"imported_from": {"site": req.site, "source": req.source}},
    )  # fmt: skip


# --- collective print orders (Sammelbestellung) ------------------------------------------------------


class OrderCreate(BaseModel):
    name: str = ""


class OrderItem(BaseModel):
    kind: str = Field("card", pattern="^(card|token)$")
    name: str = Field(min_length=1, max_length=200)
    qty: int = Field(1, ge=1, le=printorders.MAX_QTY)
    source: str | None = None
    source_slug: str | None = None
    type_line: str | None = None
    token_id: str | None = Field(None, pattern="^[0-9a-f-]{36}$")
    image: str | None = None


class OrderAdd(BaseModel):
    items: list[OrderItem] = Field(default_factory=list)
    deck: str | None = None  # add cards of this deck ...
    names: list[str] | None = None  # ... only these
    only_missing: bool = False  # ... only what the collection lacks
    since_version: int | None = None  # ... only the cards that came in after this version of the deck
    compare_with: str | None = None  # ... only the cards it needs beyond this other deck (e.g. its rebuild source)
    text: str | None = None  # pasted list "2 Sol Ring"
    url: str | None = None  # deck link (Moxfield, Archidekt, ...): all its cards incl. commanders


@app.get("/api/orders")
async def api_orders() -> list[dict[str, Any]]:
    return printorders.orders()


@app.post("/api/orders")
async def api_order_create(req: OrderCreate) -> dict[str, Any]:
    return printorders.create(req.name)


@app.get("/api/orders/{oid}")
async def api_order(oid: str) -> dict[str, Any]:
    return printorders.summary(printorders.load(oid))


@app.patch("/api/orders/{oid}")
async def api_order_rename(oid: str, req: OrderCreate) -> dict[str, Any]:
    return printorders.rename(oid, req.name)


@app.delete("/api/orders/{oid}")
async def api_order_delete(oid: str) -> dict[str, bool]:
    printorders.delete(oid)
    return {"deleted": True}


@app.get("/api/orders/{oid}/export")
async def api_order_export(oid: str, download: bool = False) -> Response:
    """The order's cards as a Moxfield text list (tokens left out: Moxfield imports none)."""
    order = printorders.load(oid)
    text, tokens = printorders.to_moxfield(oid)
    headers = {"X-Tokens-Left-Out": str(tokens)}
    if download:
        from urllib.parse import quote

        name = re.sub(r"[^\w .-]+", "", order["name"]).strip() or "sammelbestellung"
        headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(name)}-moxfield.txt"
    return Response(text, media_type="text/plain; charset=utf-8", headers=headers)


@app.get("/api/decks/{slug}/compare")
async def api_deck_compare(slug: str, other: str | None = None) -> dict[str, Any]:
    """Compare a deck with another saved deck: what it needs beyond it (for a collective order), what becomes free.
    Without ``other`` the best match is used (the deck it was copied from, else the one sharing most cards)."""
    candidates = printorders.compare_candidates(slug)
    if not other:
        if not candidates:
            return {"candidates": [], "other": None}
        other = candidates[0]["slug"]
    diff = printorders.compare(slug, other)
    names = [i["name"] for i in diff["added"] + diff["removed"]]
    try:
        cards, renames, _ = await resolve(names) if names else ({}, {}, [])
    except Exception:  # images are a nice-to-have
        cards, renames = {}, {}
    for i in diff["added"] + diff["removed"]:
        c = cards.get(renames.get(i["name"], i["name"])) or {}
        i["image"], i["image_back"], i["price"] = c.get("image"), c.get("image_back"), c.get("price_eur")
    return {**diff, "candidates": candidates}


@app.post("/api/orders/{oid}/items")
async def api_order_add(oid: str, req: OrderAdd) -> dict[str, Any]:
    printorders.load(oid)
    items = [i.model_dump() for i in req.items]
    if req.deck and req.compare_with:
        items += printorders.compare_items(req.deck, req.compare_with, only_missing=req.only_missing, names=req.names)
    elif req.deck and req.since_version:
        items += printorders.added_since(req.deck, req.since_version, only_missing=req.only_missing)
    elif req.deck:
        deck = storage.load(req.deck)
        items += printorders.deck_items(deck, names=req.names, only_missing=req.only_missing)
    if req.text and req.text.strip():
        from ..deck import parse_decklist

        parsed = parse_decklist(req.text)
        items += [{"kind": "card", "name": n, "qty": 1, "source": "Liste"} for n in parsed.commanders]
        items += [{"kind": "card", "name": e.name, "qty": e.qty, "source": "Liste"} for e in parsed.entries]
    if req.url and req.url.strip():
        data = await _import_url(req.url)
        label = f"{data.get('name') or 'Deck'} ({data.get('site')})"
        items += [{"kind": "card", "name": n, "qty": 1, "source": label} for n in data["commanders"]]
        for line in data["cards"]:
            qty, name = line.split(" ", 1)
            items.append({"kind": "card", "name": name, "qty": int(qty), "source": label})
    if not items:
        raise HTTPException(400, "Nichts hinzuzufügen" + (" – die Sammlung hat schon alle Karten." if req.only_missing else "."))
    return await printorders.add(oid, items)


class OrderQty(BaseModel):
    qty: int = Field(ge=0, le=printorders.MAX_QTY)


@app.patch("/api/orders/{oid}/items/{item_id}")
async def api_order_item(oid: str, item_id: str, req: OrderQty) -> dict[str, Any]:
    return printorders.update_item(oid, item_id, req.qty)


@app.delete("/api/orders/{oid}/items")
async def api_order_remove(oid: str, item: str | None = None, source: str | None = None) -> dict[str, Any]:
    if not item and not source:
        raise HTTPException(400, "item oder source angeben")
    return printorders.remove(oid, item_id=item, source=source)


@app.get("/api/decks/{slug}/added")
async def api_deck_added(slug: str, since: int, only_missing: bool = False) -> dict[str, Any]:
    """Cards a rebuild brought in since version ``since`` (for "add to a collective order?")."""
    items = printorders.added_since(slug, since, only_missing=only_missing)
    return {"version": storage.load(slug).get("version"), "since": since, "items": items,
            "cards": sum(i["qty"] for i in items)}  # fmt: skip


@app.get("/api/tokens/search")
async def api_token_search(q: str) -> list[dict[str, Any]]:
    """Tokens and emblems by name (Scryfall), one entry per artwork: ``[{name, type_line, id, image}]``."""
    if len(q.strip()) < 2:
        return []
    res = await scryfall.search(f'(t:token or t:emblem) name:"{q.strip()}"', order="released", unique="art", max_results=60)
    out = []
    for c in res["cards"]:
        cid = c.get("id")
        if cid and c.get("name"):
            out.append({"name": c["name"], "type_line": c.get("type_line", ""), "id": cid,
                        "image": scryfall.compact(c).get("image"), "set_name": c.get("set_name")})  # fmt: skip
    return out


@app.get("/api/precons")
async def api_precons(q: str = "", limit: int = 60) -> list[dict[str, Any]]:
    try:
        return await precons.search(q, limit=min(limit, 200))
    except Exception as exc:  # offline or MTGJSON down
        raise HTTPException(502, f"MTGJSON nicht erreichbar: {jobs.error_text(exc)}") from exc


@app.get("/api/precons/{file_name}")
async def api_precon(file_name: str) -> dict[str, Any]:
    try:
        p = await precons.load(file_name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except HttpError as exc:
        raise HTTPException(404 if exc.status == 404 else 502, exc.friendly) from exc
    except Exception as exc:
        raise HTTPException(502, f"MTGJSON nicht erreichbar: {jobs.error_text(exc)}") from exc
    try:  # commander images for the preview
        data, _, _ = await resolve(p["commanders"])
        p["commander_images"] = {n: c.get("image") for n, c in data.items()}
    except Exception:
        p["commander_images"] = {}
    return p


class PreconImport(BaseModel):
    file: str
    bracket: int = Field(2, ge=1, le=5)
    currency: str = Field("eur", pattern="^(eur|usd)$")


@app.post("/api/precons/import")
async def api_precon_import(req: PreconImport) -> dict[str, Any]:
    try:
        return await precons.import_precon(req.file, bracket=req.bracket, currency=req.currency)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"MTGJSON nicht erreichbar: {jobs.error_text(exc)}") from exc


class BlacklistUpdate(BaseModel):
    add: list[str] = []
    remove: list[str] = []


class OpponentIn(BaseModel):
    commanders: list[str] | None = Field(None, max_length=2)
    label: str | None = None
    player: str | None = None
    bracket: int | None = Field(None, ge=1, le=5)
    table_rule: str | None = None
    tags: list[str] | None = None
    note: str = Field("", max_length=1000)
    remove_note: str | None = None


@app.get("/api/opponents")
async def api_opponents() -> dict[str, Any]:
    return {"opponents": opponents_mod.all_opponents(), "tags": {k: v[0] for k, v in opponents_mod.TAGS.items()}}


@app.post("/api/opponents")
async def api_opponent_create(req: OpponentIn) -> dict[str, Any]:
    changes = req.model_dump(exclude_unset=True, exclude={"commanders", "note", "remove_note"})
    o = await opponents_mod.create(req.commanders or [], note=req.note, **changes)
    return opponents_mod.describe(o)


@app.get("/api/opponents/{opp_id}")
async def api_opponent(opp_id: str) -> dict[str, Any]:
    o = opponents_mod.get(opp_id)
    if o is None:
        raise HTTPException(404, "Unbekanntes Gegnerdeck")
    return opponents_mod.describe(o)


@app.patch("/api/opponents/{opp_id}")
async def api_opponent_update(opp_id: str, req: OpponentIn) -> dict[str, Any]:
    changes = req.model_dump(exclude_unset=True, exclude={"commanders", "note", "remove_note"})
    o = await opponents_mod.update(opp_id, commanders=req.commanders, add_note=req.note, remove_note=req.remove_note, **changes)
    return opponents_mod.describe(o)


@app.delete("/api/opponents/{opp_id}")
async def api_opponent_delete(opp_id: str) -> dict[str, str]:
    opponents_mod.delete(opp_id)
    return {"deleted": opp_id}


class TableRuleIn(BaseModel):
    name: str | None = None
    description: str | None = None
    add: list[str] = []
    remove: list[str] = []
    max_bracket: int | None = Field(None, ge=1, le=5)
    max_game_changers: int | None = Field(None, ge=0)
    max_tutors: int | None = Field(None, ge=0)
    deck_budget: float | None = Field(None, ge=0)
    currency: str | None = None
    no_proxies: bool | None = None


def _table_changes(req: TableRuleIn) -> dict[str, Any]:
    return {k: v for k, v in req.model_dump(exclude_unset=True).items() if k not in ("add", "remove")}


@app.get("/api/tablerules")
async def api_tablerules() -> dict[str, Any]:
    counts: dict[str, int] = {}
    for d in storage.list_decks():
        if d.get("table_rule"):
            counts[d["table_rule"]] = counts.get(d["table_rule"], 0) + 1
    return {"sets": [{**s, "decks": counts.get(s["id"], 0)} for s in tablerules.all_sets()], "catalog": blacklist.catalog()}


@app.post("/api/tablerules")
async def api_tablerule_create(req: TableRuleIn) -> dict[str, Any]:
    changes = _table_changes(req)
    name = changes.pop("name", None) or ""
    return await tablerules.create(name, add=req.add, remove=req.remove, **changes)


@app.patch("/api/tablerules/{rule_id}")
async def api_tablerule_update(rule_id: str, req: TableRuleIn) -> dict[str, Any]:
    out = await tablerules.update(rule_id, add=req.add, remove=req.remove, **_table_changes(req))
    out["revalidated"] = await deckedit.revalidate_decks(rule_id)
    return out


@app.delete("/api/tablerules/{rule_id}")
async def api_tablerule_delete(rule_id: str) -> dict[str, Any]:
    rs = tablerules.get(rule_id)
    if rs is None:
        raise HTTPException(404, f"Unbekannte Tischregel: {rule_id}")
    cleared = []  # decks first: if this stops halfway, the rule still exists and no deck points to nothing
    for d in storage.list_decks():
        if d.get("table_rule") == rule_id:
            await _set_table_rule(d["slug"], None, f"Tischregel „{rs['name']}“ gelöscht")
            cleared.append(d["slug"])
    tablerules.delete(rule_id)
    return {"deleted": rule_id, "decks": cleared}


@app.get("/api/tablerules/{rule_id}/decks")
async def api_tablerule_decks(rule_id: str) -> list[dict[str, Any]]:
    return await tablerules.check_all(rule_id)


class DeckTableRule(BaseModel):
    table_rule: str | None = None


@app.put("/api/decks/{slug}/table-rule")
async def api_deck_table_rule(slug: str, req: DeckTableRule) -> dict[str, Any]:
    deck = await _set_table_rule(slug, req.table_rule or None)
    return {"slug": slug, "table_rule": deck.get("table_rule"), "validation": deck.get("validation")}


class PinOrder(BaseModel):
    slugs: list[str] = Field(max_length=500)


@app.put("/api/decks/pin-order")
async def api_pin_order(req: PinOrder) -> dict[str, Any]:
    """Order the pinned decks as the user dragged them (first = on top)."""
    return {"changed": storage.set_pin_order(req.slugs)}


class DeckFlags(BaseModel):
    pinned: bool | None = None
    shelved: bool | None = None


@app.put("/api/decks/{slug}/flags")
async def api_deck_flags(slug: str, req: DeckFlags) -> dict[str, Any]:
    """Pin a deck to the top of the lists or mark it as not played at the moment (no new version)."""
    flags = req.model_dump(exclude_none=True)
    if not flags:
        raise HTTPException(422, "Nichts zu ändern")
    try:
        deck = storage.set_flags(slug, **flags)
    except FileNotFoundError as exc:
        raise HTTPException(404, "Deck nicht gefunden") from exc
    return {"slug": slug, "pinned": bool(deck.get("pinned")), "shelved": bool(deck.get("shelved"))}


class DeckTarget(BaseModel):
    bracket: int = Field(ge=1, le=5)
    profile: PowerProfile | None = None


@app.put("/api/decks/{slug}/target")
async def api_deck_target(slug: str, req: DeckTarget) -> dict[str, Any]:
    """Set the power the deck aims for (bracket + sub-tier/house rules); the check measures the cards against it."""
    for attempt in range(3):
        deck = storage.load(slug)
        start_version = deck.get("version")
        profile = req.profile.model_dump(exclude_none=True) if req.profile else None
        deck["bracket"] = req.bracket
        deck["power_profile"] = profile or None
        await deckedit.revalidate(deck)
        tier = TIER_LABELS.get((profile or {}).get("tier"))
        deck["change_note"] = f"Ziel: {tier + ' ' if tier else ''}Bracket {req.bracket}"
        try:
            storage.save(deck, expect_version=start_version)
            break
        except ConflictError:
            if attempt == 2:
                raise
    return {"slug": slug, "bracket": deck["bracket"], "power_profile": deck.get("power_profile"), "validation": deck.get("validation")}


@app.get("/api/blacklist")
async def api_blacklist() -> dict[str, Any]:
    return {"cards": blacklist.load(), "rules": blacklist.rules(), "catalog": blacklist.catalog()}


@app.post("/api/blacklist")
async def api_blacklist_update(req: BlacklistUpdate) -> dict[str, Any]:
    return await blacklist.update(req.add, req.remove)


@app.get("/api/jobs/{job_id}/events")
async def api_job_events(job_id: str, request: Request) -> StreamingResponse:
    job = jobs.JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unbekannter Job")
    start = int(request.headers.get("last-event-id", -1)) + 1

    async def stream():
        i = start
        while True:
            while i < len(job.events):
                yield f"id: {i}\ndata: {json.dumps(job.events[i], ensure_ascii=False)}\n\n"
                i += 1
            if job.done or await request.is_disconnected():
                return
            job.changed.clear()
            try:
                await asyncio.wait_for(job.changed.wait(), timeout=15)
            except asyncio.TimeoutError:
                yield ": keep-alive\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.post("/api/jobs/{job_id}/cancel")
async def api_job_cancel(job_id: str) -> dict[str, bool]:
    job = jobs.JOBS.get(job_id)
    if job and isinstance(job.proc, terminal.Terminal):
        job.proc.terminate()
    if job and job.task and not job.done:
        job.task.cancel()
    return {"ok": True}


@app.get("/api/decks")
async def api_decks() -> list[dict[str, Any]]:
    return storage.list_decks()


@app.get("/api/decks/{slug}")
async def api_deck(slug: str) -> dict[str, Any]:
    deck = storage.load(slug)
    names = deck.get("commanders", []) + [c["name"] for c in deck.get("cards", [])] + [m["name"] for m in deck.get("maybe") or []]
    try:
        card_data, _, _ = await resolve(names)
    except Exception as exc:  # offline: show the list without images/prices
        card_data = {}
        deck["card_data_error"] = exc.friendly if isinstance(exc, HttpError) else "Kartendaten gerade nicht verfügbar"
    keep = ("image", "image_back", "layout", "type_line", "mana_cost", "cmc", "price_eur", "price_usd",
            "game_changer", "scryfall_uri", "color_identity", "roles")  # fmt: skip
    deck["card_data"] = {n: {k: c.get(k) for k in keep} for n, c in card_data.items()}
    colors = {col for n in deck.get("commanders", []) for col in (card_data.get(n) or {}).get("color_identity") or []}
    for n, c in card_data.items():  # rocks and dorks: the Spieltisch counts their mana
        if tap := openinghand.taps_for(c, colors):
            deck["card_data"][n]["taps_for"] = tap
    entries = [DeckEntry(c["name"], c.get("qty", 1)) for c in deck.get("cards", [])]
    deck["export_text"] = to_text(deck.get("commanders", []), entries)
    deck["health"] = health.check(deck)
    deck["speed"] = speed.rate(deck, _tempo_now(deck, card_data))
    rs = tablerules.get(deck.get("table_rule"))
    deck["table_rule_info"] = {"id": rs["id"], "name": rs["name"], "summary": tablerules.summary_lines(rs)} if rs else None
    against = [opponents_mod.get(i) for i in deck.get("built_against") or []]
    deck["built_against_info"] = [{"id": o["id"], "title": opponents_mod.title(o)} for o in against if o]
    return deck


def _tempo_now(deck: dict[str, Any], card_data: dict[str, Any]) -> dict[str, Any] | None:
    """The effective Tempo for a deck checked before ``speed.analyse()`` existed (None: use the stored one)."""
    v = deck.get("validation") or {}
    if not card_data or (v.get("stats") or {}).get("tempo") is not None or not v.get("stats"):
        return None
    cards = [card_data[c["name"]] for c in deck.get("cards", []) if c["name"] in card_data]
    qty = {c["name"]: c.get("qty", 1) for c in deck.get("cards", [])}
    commanders = [card_data[n] for n in deck.get("commanders", []) if n in card_data]
    return speed.analyse(cards, qty, commanders, (v.get("bracket") or {}).get("two_card_combos"))


@app.post("/api/decks/{slug}/validate")
async def api_validate(slug: str) -> dict[str, Any]:
    deck = storage.load(slug)
    result = await deckedit.revalidate(deck)
    storage.save(deck, expect_version=deck.get("version"))
    return result


class AddCard(BaseModel):
    name: str
    qty: int = Field(default=1, ge=1, le=99)
    category: str | None = None


class MaybeCard(BaseModel):
    name: str
    category: str | None = None


class EditRequest(BaseModel):
    add: list[AddCard] = []
    remove: list[str] = []
    set_qty: dict[str, int] = {}
    set_category: dict[str, str] = {}
    maybe_add: list[MaybeCard] = []
    maybe_remove: list[str] = []
    note: str = ""


@app.post("/api/decks/{slug}/cards")
async def api_edit_cards(slug: str, req: EditRequest) -> dict[str, Any]:
    """Change cards directly: re-validates and saves a new version."""
    return await deckedit.edit_deck(
        slug, add=[a.model_dump() for a in req.add], remove=req.remove, set_qty=req.set_qty,
        set_category=req.set_category, maybe_add=[m.model_dump() for m in req.maybe_add],
        maybe_remove=req.maybe_remove, note=req.note,
    )  # fmt: skip


@app.get("/api/decks/{slug}/similar")
async def api_similar(slug: str, card: str, limit: int = 12) -> list[dict[str, Any]]:
    return await deckedit.similar_cards(storage.load(slug), card, limit=min(limit, 30))


@app.get("/api/decks/{slug}/role-candidates")
async def api_role_candidates(slug: str, role: str, limit: int = 18) -> list[dict[str, Any]]:
    deck = storage.load(slug)
    budget = deck.get("budget") if not deck.get("proxy") else None
    # cards for one slot should not blow the budget: at most a tenth of it per card
    return await deckedit.role_candidates(deck, role, limit=min(limit, 40), max_price=budget / 10 if budget else None)


@app.get("/api/decks/{slug}/export/text")
async def api_export(slug: str) -> Response:
    """Download the decklist as a text file (Moxfield/Archidekt format)."""
    deck = storage.load(slug)
    entries = [DeckEntry(c["name"], c.get("qty", 1)) for c in deck.get("cards", [])]
    body = to_text(deck.get("commanders", []), entries)
    return Response(body, media_type="text/plain; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{deck["slug"]}.txt"'})


@app.get("/api/decks/{slug}/tokens")
async def api_tokens(slug: str) -> list[dict[str, Any]]:
    deck = storage.load(slug)
    return await deck_tokens(deck.get("commanders", []) + [c["name"] for c in deck.get("cards", [])])


class HandIn(BaseModel):
    cards: list[str] = Field(max_length=20)
    mulligans: int = Field(0, ge=0, le=7)
    on_draw: bool = False
    bottom: int = Field(0, ge=0, le=7)


_HAND_DECKS: dict[tuple[Any, ...], tuple[openinghand.Deck, dict[str, Any]]] = {}


@app.post("/api/decks/{slug}/hand")
async def api_rate_hand(slug: str, body: HandIn) -> dict[str, Any]:
    """Rate a test hand (Testen tab): keep, borderline or mulligan, with the reasons."""
    deck = storage.load(slug)
    validation = deck.get("validation") or {}
    combos = len((validation.get("combos") or {}).get("included") or [])
    key = (slug, int(deck.get("version") or 0), (validation.get("stats") or {}).get("total_mana_value"), combos, body.on_draw)
    if key not in _HAND_DECKS:
        names = deck.get("commanders", []) + [c["name"] for c in deck.get("cards", [])]
        card_data, _, _ = await resolve(names)
        built = openinghand.build_deck(deck, card_data)
        for old in [k for k in _HAND_DECKS if k[0] == slug]:
            del _HAND_DECKS[old]
        _HAND_DECKS[key] = (built, openinghand.deck_profile(built, on_draw=body.on_draw))
    built, profile = _HAND_DECKS[key]
    return openinghand.rate(body.cards, built, mulligans=body.mulligans, on_draw=body.on_draw,
                            to_bottom=body.bottom, profile=profile)  # fmt: skip


@app.get("/api/decks/{slug}/ownership")
async def api_ownership(slug: str) -> dict[str, Any]:
    deck = storage.load(slug)
    out = await collection.deck_ownership(deck)
    away = collection.stored_elsewhere(slug) if out["collection_size"] else {"cards": 0, "copies": 0, "played": 0}
    out["elsewhere"] = {k: away[k] for k in ("cards", "copies", "played")}  # the count on „Woanders gelagert“
    return out


@app.get("/api/decks/{slug}/elsewhere")
async def api_deck_elsewhere(slug: str) -> dict[str, Any]:
    """The deck's cards you own whose copies lie at another Ort (Bulk, a binder, another deck), to fetch them."""
    return collection.stored_elsewhere(slug)


@app.get("/api/decks/{slug}/copies")
async def api_deck_copies(slug: str, name: str) -> dict[str, Any]:
    """One card's collection copies: those in this deck and those at other places (to move them here)."""
    return collection.card_copies(name, slug)


class CopyMove(BaseModel):
    id: str = Field(max_length=40)
    qty: int | None = Field(default=None, ge=1, le=100000)


@app.post("/api/decks/{slug}/copies/move")
async def api_deck_copies_move(slug: str, req: CopyMove) -> dict[str, Any]:
    """Move copies of a collection entry into this deck (Ort = the deck); returns where they came from for undo."""
    try:
        return collection.move_to_deck(req.id, slug, req.qty)
    except KeyError as exc:
        raise HTTPException(404, "Eintrag nicht gefunden") from exc


@app.get("/api/decks/{slug}/buylist")
async def api_buylist(slug: str, owned: bool = True, proxies: bool = True) -> dict[str, Any]:
    """Einkaufsliste: the cards still to buy (``owned=false``: the whole deck, no collection check; proxies included
    unless ``proxies=false``), priced at Cardmarket's cheapest printing."""
    deck = storage.load(slug)
    return await buylist.build(deck, use_collection=owned, replace_proxies=proxies)


app.include_router(collection_routes.router)



app.include_router(selling_routes.router)



@app.get("/api/cards/prints")
async def api_prints(name: str, page: int = 1) -> dict[str, Any]:
    return await scryfall.prints(name, page=max(1, page))


@app.delete("/api/decks/{slug}")
async def api_delete(slug: str) -> dict[str, Any]:
    """Moves the deck (with versions, questions and games) to the trash."""
    return {"ok": True, "trash_id": storage.delete(slug)}


app.include_router(backup_routes.router)



@app.get("/api/decks/{slug}/versions")
async def api_versions(slug: str) -> list[dict[str, Any]]:
    return storage.versions(slug)


@app.get("/api/decks/{slug}/versions/{version}")
async def api_version(slug: str, version: int) -> dict[str, Any]:
    deck = storage.load_version(slug, version)
    entries = [DeckEntry(c["name"], c.get("qty", 1)) for c in deck.get("cards", [])]
    return {**deck, "export_text": to_text(deck.get("commanders", []), entries)}


@app.get("/api/decks/{slug}/diff")
async def api_diff(slug: str, a: int, b: int | None = None) -> dict[str, Any]:
    return storage.compare(slug, a, b)


@app.post("/api/decks/{slug}/versions/{version}/restore")
async def api_restore(slug: str, version: int) -> dict[str, Any]:
    return storage.restore(slug, version)


class CopyRequest(BaseModel):
    name: str | None = None
    version: int | None = None


@app.post("/api/decks/{slug}/copy")
async def api_copy(slug: str, req: CopyRequest) -> dict[str, Any]:
    return storage.copy(slug, req.name, req.version)


class RenameDeckRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@app.put("/api/decks/{slug}/name")
async def api_rename_deck(slug: str, req: RenameDeckRequest) -> dict[str, Any]:
    try:
        renamed = storage.rename(slug, req.name)
        return {"slug": renamed["slug"], "name": req.name.strip(), "version": renamed.get("version")}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


# --- proxies (MPC Autofill) & settings ---------------------------------------------------------


class SettingsUpdate(BaseModel):
    autofill_path: str | None = None
    mpcfill_server: str | None = None
    cardback_path: str | None = None
    browser: str | None = None
    site: str | None = None
    stock: str | None = None
    foil: bool | None = None
    paper: str | None = None
    mpcfill_cdn: str | None = None
    upscale: bool | None = None
    upscaler_path: str | None = None
    upscale_model: str | None = None
    descreen: str | None = None
    sync_interval: int | None = Field(default=None, ge=0, le=240)
    desktop_notify: bool | None = None
    desktop_preview: bool | None = None
    font: Literal["cascadia", "inter"] | None = None
    hover_preview: bool | None = None


def _settings_view(cfg: dict[str, Any]) -> dict[str, Any]:
    found, upscaler = proxy.find_autofill(cfg), proxy.find_upscaler(cfg)
    return {
        **cfg,
        "autofill_found": str(found) if found else None,
        "upscaler_found": str(upscaler) if upscaler else None,
        "upscale_models": proxy.upscale_models(upscaler) or ["realesrgan-x4plus"],
        "stocks": proxy.STOCKS,
        "platform": os.name,
    }


@app.get("/api/settings")
async def api_settings() -> dict[str, Any]:
    return _settings_view(settings_mod.load())


@app.post("/api/settings")
async def api_settings_update(req: SettingsUpdate) -> dict[str, Any]:
    return _settings_view(settings_mod.update(req.model_dump(exclude_none=True)))


class PrintRequest(BaseModel):
    source: str = "auto"
    stock: str | None = None
    foil: bool | None = None
    upscale: bool | None = None
    only_missing: bool = False
    tokens: int = Field(default=0, ge=0, le=20)
    version: int | None = None


def _print_deck(slug: str, version: int | None = None) -> dict[str, Any]:
    if printorders.is_order_slug(slug):
        return printorders.as_deck(slug)
    deck = storage.load_version(slug, version)
    deck["slug"] = storage.slug(slug)
    return deck


@app.get("/api/decks/{slug}/print/plan")
async def api_print_plan(slug: str, source: str = "auto", version: int | None = None, only_missing: bool = False,
                         tokens: int = 0) -> dict[str, Any]:  # fmt: skip
    return await proxy.plan(_print_deck(slug, version), source=source, only_missing=only_missing, tokens=min(max(tokens, 0), 20))


@app.post("/api/decks/{slug}/collection/add-printed")
async def api_add_printed(slug: str, req: PrintRequest) -> dict[str, Any]:
    """Add the printed proxies (with the chosen artwork) to the collection."""
    plan = await proxy.plan(_print_deck(slug, req.version), source=req.source, only_missing=req.only_missing)
    return await collection.add_printed(plan)


@app.get("/api/decks/{slug}/print/alternatives")
async def api_print_alternatives(slug: str, card: str, side: str = "front", token: bool = False, page: int = 1) -> dict[str, Any]:
    return await proxy.alternatives(_print_deck(slug), card, "back" if side == "back" else "front", token=token, page=max(1, page))


class ChooseRequest(BaseModel):
    face: str
    option: dict[str, Any] | None = None


@app.post("/api/decks/{slug}/print/choose")
async def api_print_choose(slug: str, req: ChooseRequest) -> dict[str, Any]:
    return proxy.choose(storage.slug(slug), req.face, req.option)


@app.post("/api/decks/{slug}/print/upload")
async def api_print_upload(slug: str, request: Request, face: str, filename: str = "", bleed: str = "auto",
                           choose: bool = True) -> dict[str, Any]:  # fmt: skip
    """Own image for one card face (raw image body): made print-ready, stored and – by default – chosen."""
    _print_deck(slug)  # 404 for unknown decks/orders
    if int(request.headers.get("content-length") or 0) > proxy.MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"Das Bild ist zu groß (höchstens {proxy.MAX_UPLOAD_BYTES // 1_000_000} MB).")
    data = await request.body()
    option = await asyncio.to_thread(proxy.save_upload, storage.slug(slug), face, data, filename, bleed)
    if choose:
        proxy.choose(storage.slug(slug), face, option)
    return option


@app.get("/api/decks/{slug}/print/uploads/{name}")
async def api_print_upload_file(slug: str, name: str) -> FileResponse:
    if not proxy.UPLOAD_NAME.match(name):
        raise HTTPException(404, "Kein Bild")
    path = paths.inside(proxy.order_dir(storage.slug(slug)), proxy.UPLOADS, name)
    if not path.is_file():
        raise HTTPException(404, "Bild nicht gefunden")
    return FileResponse(path, headers={"Cache-Control": "max-age=86400"})


@app.delete("/api/decks/{slug}/print/uploads/{key}")
async def api_print_upload_delete(slug: str, key: str) -> dict[str, bool]:
    if not re.fullmatch(r"[0-9a-f]{16}", key):
        raise HTTPException(404, "Kein Bild")
    proxy.delete_upload(storage.slug(slug), key)
    return {"ok": True}


class TokenQtyRequest(BaseModel):
    counts: dict[str, int | None] = Field(description="token face -> copies (0 = leave out, null = default)")


@app.post("/api/decks/{slug}/print/token-qty")
async def api_print_token_qty(slug: str, req: TokenQtyRequest) -> dict[str, int]:
    """Copies per token for this deck's print (collective orders keep their quantities in the order items)."""
    if slug.startswith(printorders.SLUG_PREFIX):
        raise HTTPException(400, "In einer Sammelbestellung änderst du die Token-Anzahl in der Positionsliste.")
    if any(v is not None and not 0 <= v <= proxy.TOKEN_QTY_MAX for v in req.counts.values()):
        raise HTTPException(400, f"Anzahl pro Token: 0 bis {proxy.TOKEN_QTY_MAX}.")
    return proxy.set_token_qty(storage.slug(slug), req.counts)


@app.post("/api/decks/{slug}/print/prepare")
async def api_print_prepare(slug: str, req: PrintRequest) -> dict[str, str]:
    deck = _print_deck(slug, req.version)

    async def runner(job: jobs.Job) -> None:
        job.emit(type="status", text="Plane Bilder …")

        def progress(done: int, total: int, name: str) -> None:
            job.emit(type="progress", done=done, total=total, text=name)

        try:
            result = await proxy.prepare(
                deck, source=req.source, stock=req.stock, foil=req.foil, upscale=req.upscale,
                only_missing=req.only_missing, tokens=req.tokens, progress=progress,
            )
        except ValueError as exc:
            job.emit(type="error", text=str(exc))
            job.emit(type="done", ok=False)
            return
        for w in result["warnings"]:
            job.emit(type="status", text=w)
        for e in result["errors"]:
            job.emit(type="error", text=e)
        job.emit(type="result", text=(
            f"{result['quantity']} Karten vorbereitet ({result['images_mpcfill']} MPC-Autofill-Scans, "
            f"{result['images_scryfall']} Scryfall-Scans"
            f"{', davon ' + str(result['images_upscaled']) + ' KI-hochskaliert' if result['upscaled'] else ''}) · {result['cardback']}"
        ))  # fmt: skip
        job.emit(type="print", result=result)
        job.emit(type="done", ok=not result["missing"])

    return jobs.start_runner(runner)


@app.get("/api/decks/{slug}/print/files")
async def api_print_files(slug: str) -> dict[str, bool]:
    s = storage.slug(slug)
    return {kind: paths.inside(proxy.order_dir(s), f"{s}.{kind}").exists() for kind in ("xml", "pdf")}


@app.api_route("/api/decks/{slug}/print/files/{kind}", methods=["GET", "HEAD"])
async def api_print_file(slug: str, kind: str) -> FileResponse:
    s = storage.slug(slug)
    path = paths.inside(proxy.order_dir(s), f"{s}.{'pdf' if kind == 'pdf' else 'xml'}")
    if not path.exists():
        raise HTTPException(404, "Datei noch nicht erstellt")
    return FileResponse(path, filename=path.name)


@app.get("/api/decks/{slug}/print/prepared")
async def api_print_prepared(slug: str) -> dict[str, Any]:
    info = proxy.load_prepared(storage.slug(slug))
    return info or {"faces": {}, "images_dir": None}


@app.get("/api/decks/{slug}/print/image")
async def api_print_image(slug: str, face: str, kind: str = "file") -> Response:
    """kind: original (as downloaded) | file (print file with bleed) | trim (print file without bleed)."""
    path = proxy.prepared_image(storage.slug(slug), face, kind)
    if kind != "trim":
        return FileResponse(path)

    def cropped() -> bytes:
        from io import BytesIO

        from PIL import Image

        from .. import imaging

        with Image.open(path) as im:
            buf = BytesIO()
            imaging.crop_bleed(im.convert("RGB")).save(buf, "JPEG", quality=92)
            return buf.getvalue()

    return Response(await asyncio.to_thread(cropped), media_type="image/jpeg")


def open_in_file_manager(path: Path) -> None:
    if sys.platform == "win32":
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


@app.post("/api/decks/{slug}/print/open-folder")
async def api_print_open_folder(slug: str) -> dict[str, Any]:
    folder = proxy.order_dir(storage.slug(slug)) / "images"
    if not folder.is_dir():
        raise HTTPException(404, "Noch keine Druckdateien – zuerst „Druckdateien vorbereiten“.")
    try:
        open_in_file_manager(folder)
    except OSError:
        return {"opened": False, "path": str(folder), "error": "Der Ordner ließ sich nicht öffnen."}
    return {"opened": True, "path": str(folder)}


class PdfRequest(BaseModel):
    paper: str = "A4"
    include_backs: bool = True
    cut_marks: bool = True


@app.post("/api/decks/{slug}/print/pdf")
async def api_print_pdf(slug: str, req: PdfRequest) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(
            proxy.export_pdf, storage.slug(slug), paper=req.paper, include_backs=req.include_backs, cut_marks=req.cut_marks
        )
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc


class AutofillRequest(BaseModel):
    mode: str = "mpc"
    window: bool = False  # True = own console window instead of the terminal in the GUI
    rows: int = 32
    cols: int = 110


@app.post("/api/decks/{slug}/print/autofill")
async def api_print_autofill(slug: str, req: AutofillRequest) -> dict[str, Any]:
    folder = proxy.order_dir(storage.slug(slug))
    mode = "pdf" if req.mode == "pdf" else "mpc"
    try:
        proxy._check_order(folder)
        if req.window or not terminal.available():
            started = proxy.launch_autofill(folder, mode=mode)
            return {**started, "window": True}
        cmd = proxy.autofill_command(folder, mode=mode)
    except (FileNotFoundError, RuntimeError) as exc:
        raise HTTPException(400, str(exc)) from exc

    async def runner(job: jobs.Job) -> None:
        job.emit(type="status", text="Starte MPC Autofill … Bedienung direkt im Terminal unten (Pfeiltasten + Enter).")
        term = terminal.Terminal(cmd, cwd=str(folder), rows=req.rows, cols=req.cols)
        job.proc = term
        job.emit(type="console", running=True)

        def pump() -> None:
            while data := term.read():
                job.emit_threadsafe(type="term", data=data)

        await asyncio.to_thread(pump)
        code = await asyncio.to_thread(term.exit_code)
        job.emit(type="console", running=False)
        job.emit(type="result", text=f"MPC Autofill beendet (Code {code}).")
        job.emit(type="done", ok=code == 0)

    return {**jobs.start_runner(runner), "window": False}


class InputRequest(BaseModel):
    text: str = ""
    raw: bool = False  # True: keystrokes from the terminal as-is; False: a line + Enter


@app.post("/api/jobs/{job_id}/input")
async def api_job_input(job_id: str, req: InputRequest) -> dict[str, bool]:
    job = jobs.JOBS.get(job_id)
    if not job or not isinstance(job.proc, terminal.Terminal) or not job.proc.alive():
        raise HTTPException(409, "Kein laufender Prozess für Eingaben")
    await asyncio.to_thread(job.proc.write, req.text if req.raw else req.text + "\r")
    return {"ok": True}


class ResizeRequest(BaseModel):
    rows: int = Field(ge=5, le=300)
    cols: int = Field(ge=20, le=500)


@app.post("/api/jobs/{job_id}/resize")
async def api_job_resize(job_id: str, req: ResizeRequest) -> dict[str, bool]:
    job = jobs.JOBS.get(job_id)
    if job and isinstance(job.proc, terminal.Terminal) and job.proc.alive():
        job.proc.resize(req.rows, req.cols)
    return {"ok": True}


@app.get("/api/carddb")
async def api_carddb() -> dict[str, Any]:
    return {**carddb.status(), "needs_refresh": carddb.needs_refresh(), "bulk_type": carddb.BULK_TYPE}


_db_task: asyncio.Task | None = None


@app.post("/api/carddb/refresh")
async def api_carddb_refresh() -> dict[str, Any]:
    global _db_task
    if _db_task is None or _db_task.done():
        _db_task = asyncio.create_task(carddb.refresh(force=True))
    return {"started": True}


@app.get("/api/carddb/refresh")
async def api_carddb_refresh_state() -> dict[str, Any]:
    if _db_task is None:
        return {"running": False}
    if not _db_task.done():
        return {"running": True}
    exc = _db_task.exception()
    return {"running": False, "error": str(exc) if exc else None}


app.include_router(gui_sync.router)



def serve() -> None:
    """Run the GUI. ``MTG_GUI_PORT=0`` takes a free port; the address (with the token) goes to stdout as one
    ``MTGDECK_URL=…`` line, which the desktop shell reads."""
    import socket

    import uvicorn

    host = os.environ.get("MTG_GUI_HOST", "127.0.0.1")
    port = int(os.environ.get("MTG_GUI_PORT", 8765))
    sock = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    port = sock.getsockname()[1]
    shown = f"[{host}]" if ":" in host else host
    # the local backend on loopback: plain HTTP, there is no certificate for 127.0.0.1
    url = urlunsplit(("http", f"{shown}:{port}", "/", f"token={GUI_TOKEN}" if GUI_TOKEN else "", ""))
    print(f"Conclave GUI: {url}")
    print(f"MTGDECK_URL={url}", flush=True)
    try:
        made = backup.auto_backup()
        if made:
            print(f"Automatische Sicherung: {backup.BACKUP_DIR / made['name']}")
    except Exception as exc:  # a failed backup must not stop the GUI
        print(f"Automatische Sicherung fehlgeschlagen: {exc}")
    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    uvicorn.Server(config).run(sockets=[sock])

