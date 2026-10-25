# The phone app API

What a phone app needs from the sync server (`src/mtgdeck/sync/server.py`): pairing, the read model, sending
changes. The phone web app (`src/mtgdeck/sync/app/`) uses it, and so do the native apps (Conclave for iPhone,
github.com/liehrdot/Conclave-iOS, later Android). Conclave Cloud answers the same routes per account. This page is the
contract: a native app must never need a server change of its own, so anything new starts here.

User-facing messages from the server (`detail`, `error`) are German and meant to be shown as they are.

## Connecting

Every route except pairing needs `Authorization: Bearer <token>`. A **401** on any route means the device was signed
off (on the PC: Einstellungen › Sync › Geräte): forget the token and the local data, go back to the welcome screen.

**Pairing link and code.** The PC shows a code like `ABCD-EFGH` (8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`,
no 0/O or 1/I, case and dash don't matter) and a link `https://<server>/koppeln#ABCD-EFGH`. A code is valid for 15
minutes and only once. Opening the link in a browser redirects to `/app/#ABCD-EFGH` (the fragment stays in the browser).

`POST /api/pair/claim` (no token) with `{"code": "ABCD-EFGH", "name": "Flos iPhone", "kind": "phone"}`
(`name` 1–60 characters; `kind` `pc` | `phone` | `other`) →
`{"token", "device_id", "name", "server", "server_id"}`. The token is shown only this once; keep it in the Keychain.
`server` is the server's public address. **403** wrong or expired code, **429** too many wrong codes (20 per 10 minutes
for the whole server).

`POST /api/pair/start?qr=1` → `{"code", "expires", "minutes", "link", "server", "qr"}`: a fresh code to pair another
device from this one ("Gerät verbinden"); `qr` is the link as an inline SVG.

`DELETE /api/devices/{device_id}` signs a device off; with the own `device_id` that is "Abmelden" (`{"ok", "self"}`).
`GET /api/devices` lists them (`{devices: [{id, name, kind, last_seen, online, this, …}], now}`).

`GET /api/health` (no token) → `{ok, service, protocol, server_id, epoch}`.

## Reading: the read model

`GET /api/app/data` → one JSON with everything the phone shows (`appdata.snapshot`), with an `ETag` header.
Send it back as `If-None-Match` and an unchanged model answers **304** with no body.

The ETag is `"<server_id>-<epoch>-<seq>"`; `seq` grows with every change on the server. Behind Caddy (both the
self-hosted server and Conclave Cloud) the header arrives as `"…-<seq>-zstd"` or `-gzip`: strip that suffix before
reading `seq` (`data.js` `tagCore()` / `seqOf()`). A different `server_id` or `epoch` means another or a restored server.

`GET /api/app/status` → `{etag, pcs: [{name, online, last_seen}], device: {id, name}, now}`: cheap, poll it (the web app
every minute while visible) and fetch `/api/app/data` only when `etag` changed.

Top-level keys of the read model (version 1):

- `decks`: in the order to show them (pinned first in their dragged order, shelved last, then the most recently
  played). Each `{slug, name, commanders, colors, bracket, tier, level, level_en, proxy, legal, description, version,
  updated, checking, rule0: {rows, text}, rule0_en: {rows, text}, speed, cards: [{name, qty, category}], maybe: [{name, category}], record: {games,
  wins, losses, draws, last}, pinned, shelved, pin_rank}`. `checking` = the PC has not checked the latest version yet.
  `speed` = `{total, effective, key, label, text, complete, cards, label_en, text_en}` or null before the first check.
  Card data (images, text, prices) is never in here: the apps get it from Scryfall by name.
- `opponents`: `{id, title, label, player, commanders, colors, bracket, tags, notes: [{id, text, at, game_id,
  deck_slug}], record: {games, wins, losses, draws, last, per_deck}, updated, created}`, newest notes first.
- `games`: all decks' games, newest first, at most 400: `{id, deck, played, result, opponents, opponent_ids, turn,
  issues, mvp, note, version, how?, started?, place?, opponent_places?, round?}`.
- `collection`: one row per printing and place, by name: `{id, name, qty, proxy, foil, lang, set, set_name,
  collector_number, scryfall_id, price_eur, place, place_deck, image?}` (`image` only without a Scryfall id).
- `players`: player names used on opponent decks. `options`: the quick-pick lists `{results, issues, tags, how}` as
  `[key, German label]` pairs (`results` is `{key: label}`). `version`: 1.
- English for the native apps (whose UI is English; the web app stays German): `options_en` has the same keys in the
  same order with English labels, and each deck has `level_en`, `rule0_en` (same rows and flags, English labels and
  texts) and `speed.label_en` / `speed.text_en`. What the user typed (deck description, notes) stays as written.
  Older servers send none of these, so fall back to the German fields.

## Writing: operations

Changes are operations, sent in batches: `POST /api/app/ops` with `{"ops": [...]}` (at most 100; the web app sends 50)
→ `{"results": [{"id", "ok", "error"?, "retry"?}], "etag"}`.

An operation is `{"id", "type", "payload", "at"}`:

- `id`: 6–40 characters `[A-Za-z0-9_-]`, made by the app. The server remembers applied ids, so sending one again (the
  answer got lost) changes nothing and returns the first result.
- `at`: when it happened on the phone, ISO 8601 (`2026-10-10T20:00:00+00:00` or `…Z`).
- A result with `ok: false` and `retry: true` was not applied (the server was busy): send it again later. Without
  `retry` the operation failed for good; show `error` and drop it.

**The outbox.** The apps apply an operation to their own copy of the read model at once ("optimistic") and keep it in an
outbox until it is sent. After a successful send, keep it applied until a read model arrives whose `seq` is at least the
`seq` of the `etag` in that answer; then the server's model contains it and it can go. (Dropping it earlier makes the
change flicker away and back; never dropping it was the PR #5 bug.) Retry with backoff (the web app: 5 s up to 5 min).

**Undo** sends the opposite operation (`data.js` `INVERSE`): `game.add` ↔ `game.delete` (with `restore` = the game's
payload), `opponent.add` → `opponent.delete`, `opponent.note` → `opponent.note_delete`, `opponent.update` /
`deck.flags` / `collection.update` with `prev` (the old values), `deck.pin_order` with the old `slugs`, `collection.add`
→ the same entry with a negative `qty`. An operation still in the outbox is simply dropped.

Types (`appops.py` has the details, `ops.json` below shows each one's effect):

| type | payload |
|---|---|
| `game.add` | `game: {id, deck, result: win\|loss\|draw, turn?, issues?, mvp?, note?, how?, started?: "me"\|opponent index, place?, played?, round?}`, `opponents: [{id?, commander, new_id?, colors?, image?, note?, place?}]` (≤ 5). An opponent is matched by `id`, else the newest one with that commander, else made new with `new_id`. |
| `game.delete` | `deck, id` |
| `opponent.add` | `opponent: {id, commanders, colors?, label?, player?, tags?, image?}`, `note?`, `note_id?` |
| `opponent.update` | `id` and any of `label, player, bracket, tags, commanders` (+ `colors`, `image`) |
| `opponent.note` / `opponent.note_delete` | `id, note_id, text` / `id, note_id` |
| `opponent.delete` | `id` |
| `deck.new` | `deck: {slug, name?, commanders, bracket?}`; the slug must be free |
| `deck.edit` | `deck` and any of `add: [{name, qty, category}]`, `remove: [names]`, `set_qty: {name: qty}`, `set_category: {name: category}`, `maybe_add: [{name, category}]`, `maybe_remove: [names]`, `note?` (≤ 200 changes) |
| `deck.flags` | `deck`, `pinned?`, `shelved?` (booleans) |
| `deck.pin_order` | `slugs` (the pinned decks in their new order) |
| `collection.add` | `entry: {id?, name, qty (−99…99, not 0), proxy, foil, lang, scryfall_id, set, set_name, collector_number, image, price_eur, place, place_deck}` |
| `collection.update` | `id` and any of `qty` (0 deletes), `proxy, foil, lang, place, place_deck` |

Categories: `Ramp, Draw, Removal, Board Wipe, Counterspell, Tutor, Protection, Synergy, Win Condition, Utility, Land`.
Languages: `en, de, fr, it, es, pt, ja, ko, ru, zhs, zht, ph`. A deck edit, a new deck or a game never needs card data:
the PC checks the deck after its next sync.

## The test cases: `docs/app-api/ops.json`

`scripts/app_fixtures.py` runs every operation type (31 cases, errors included) through the server's own code and writes
what came out: `bases` are read models, and each case is `{name, about, base, op}` plus either `after` (the top-level
keys of the read model the server changed, with their new value; `{}` = nothing changed) or `error` (the German
message). An app's tests apply `op` to `bases[base]` with its own optimistic code and compare the keys in `after`; what
an optimistic apply cannot know yet (Rule 0 rows, records, `checking`) a test may leave out, as long as it says so.
`tests/test_app_fixtures.py` fails when `appops` changes and the file was not written again.

## Card search by description

The one AI feature (Flo's exception): `GET /api/app/ai` → whether it is set up and which models there are (the key never
comes back); `PUT /api/app/ai` with `{key?, model?}` (`""` removes); `POST /api/app/cards/describe` with
`{text, colors, types}` → `{query, broader, explain, cached}`, a Scryfall query to run on Scryfall. **409** not set up,
**429** too many searches in a minute.

## Not for phones

`/api/sync/changes`, `PUT /api/sync/doc` and `/api/presence` are the PC's file sync (`sync/client.py`); a phone app
never uses them. CORS is only open for the Conclave Table web app; native apps don't need it.
