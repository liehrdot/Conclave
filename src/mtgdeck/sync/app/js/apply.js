// The phone's optimistic view: what the read model will look like once the server has applied an operation.
// apply() mirrors sync/appops.py, recompute() the derived parts of sync/appdata.py (records, order, players).
// Pure: no DOM, no storage, so tests/test_phone_app.py runs it with node over docs/app-api/ops.json, the same
// cases the iPhone app's Optimistic is checked against.

import { uid } from "./util.js";

// one collection entry per printing and place: name, Scryfall id, proxy, foil, language, deck or place text
// (like collection._key on the PC)
export const collKey = (e) => [String(e.name || "").toLowerCase(), e.scryfall_id || "", !!e.proxy, !!e.foil, e.lang || "en",
  e.place_deck || "", e.place_deck ? "" : String(e.place || "").trim().toLowerCase()].join("|");
const COLL_KEYS = ["id", "name", "qty", "proxy", "foil", "lang", "set", "set_name", "collector_number", "scryfall_id", "price_eur",
  "place", "place_deck"];

function applyCollection(snap, op) {
  const p = op.payload || {};
  const list = (snap.collection ||= []);
  if (op.type === "collection.add") {
    const e = p.entry || {};
    const hit = list.find((x) => collKey(x) === collKey(e));
    if (hit) hit.qty += e.qty;
    else if (e.qty > 0) {
      const row = Object.fromEntries(COLL_KEYS.map((k) => [k, e[k] ?? null]));
      Object.assign(row, { id: e.id || op.id, proxy: !!e.proxy, foil: !!e.foil, lang: e.lang || "en", set: e.set ? String(e.set).toLowerCase() : null,
        place: String(e.place || "").trim(), place_deck: e.place_deck || "" });
      if (!row.scryfall_id && e.image) row.image = e.image;
      list.push(row);
    }
  } else {
    const e = list.find((x) => x.id === p.id);
    if (!e) return;
    if ("qty" in p) e.qty = p.qty;
    for (const k of ["proxy", "foil", "lang", "place", "place_deck"]) if (k in p) e[k] = p[k];
    const seen = new Map();  // entries that now describe the same thing become one
    for (const x of [...list]) {
      const k = collKey(x);
      if (seen.has(k)) { seen.get(k).qty += x.qty; list.splice(list.indexOf(x), 1); } else seen.set(k, x);
    }
  }
  snap.collection = list.filter((x) => x.qty > 0).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// the deck categories (deckedit.CATEGORIES / appops.CATEGORIES)
export const CATEGORIES = ["Ramp", "Draw", "Removal", "Board Wipe", "Counterspell", "Tutor", "Protection", "Synergy", "Win Condition", "Utility", "Land"];
const MAYBE_MAX = 150;  // maybe.MAYBE_MAX
const NOTES_MAX = 30;  // appdata.NOTES_MAX
const ISO = /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)?$/;

const text = (v, n) => String(v ?? "").trim().slice(0, n);  // appops._text
const intIn = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);  // appops._int
const wubrg = (colors) => [..."WUBRG"].filter((c) => String(colors || "").includes(c)).join("");
const commandersOf = (list) => (list || []).map((c) => text(c, 120)).filter(Boolean).slice(0, 2);
const keysOf = (pairs) => new Set((pairs || []).map(([k]) => k));
const note = (id, body, at, gameId = null, deckSlug = null) => ({ id, text: body.slice(0, 1000), at, game_id: gameId, deck_slug: deckSlug });

function findOpponent(snap, slot) {  // appops._match
  if (slot.id) {
    const o = snap.opponents.find((x) => x.id === slot.id);
    if (o) return o;
  }
  const name = text(slot.commander, 120).toLowerCase();
  if (!name) return null;
  const hits = snap.opponents.filter((x) => (x.commanders || []).some((c) => c.toLowerCase() === name));
  return hits.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0] || null;
}

function newOpponent(snap, fields, at) {  // appops._new_opponent; null without a commander
  const commanders = commandersOf(fields.commanders);
  if (!commanders.length) return null;
  const tags = keysOf(snap.options?.tags);
  return { id: fields.id || uid().slice(0, 8), commanders, colors: wubrg(fields.colors), label: text(fields.label, 80),
    player: text(fields.player, 80), bracket: null, tags: [...new Set(fields.tags || [])].filter((t) => tags.has(t)), notes: [],
    created: at, updated: at, record: { games: 0, wins: 0, losses: 0, draws: 0, last: null, per_deck: [] } };
}

/** Like games.clean_places: the user's place and the opponents' (1..N, N = everyone at the table; ties allowed). */
export const PLACES_MAX = 6;
export function cleanPlaces(place, oppPlaces, opponents) {
  const top = opponents ? Math.min(PLACES_MAX, 1 + opponents) : PLACES_MAX;
  const ok = (v) => (Number.isInteger(v) && v >= 1 && v <= top ? v : null);
  const theirs = Array.from({ length: opponents }, (_, i) => ok(oppPlaces?.[i]));
  return { place: ok(place), opponent_places: theirs.some((v) => v !== null) ? theirs : undefined };
}

function addGame(snap, op) {  // appops.apply, game.add
  const p = op.payload || {}, g = p.game || {}, options = snap.options || {};
  const deck = snap.decks.find((d) => d.slug === g.deck);
  if (!deck || snap.games.some((x) => x.id === g.id && x.deck === g.deck) || !(g.result in (options.results || {}))) return;
  const ids = [], names = [], places = [];
  for (const slot of (p.opponents || []).slice(0, 5)) {
    if (!slot || typeof slot !== "object") continue;
    let o = findOpponent(snap, slot);
    if (!o) {
      o = newOpponent(snap, { id: slot.new_id, commanders: [slot.commander], colors: slot.colors }, op.at);
      if (!o) continue;
      snap.opponents.push(o);
    }
    const said = text(slot.note, 1000);  // the server makes up the note's id
    if (said) o.notes = [note(`${op.id}-${o.id}`, said, op.at, g.id, g.deck), ...(o.notes || [])].slice(0, NOTES_MAX);
    o.updated = op.at;
    ids.push(o.id);
    names.push(text(slot.commander, 120) || o.commanders[0]);
    places.push(slot.place ?? null);
  }
  const issues = keysOf(options.issues);
  const game = { id: g.id, deck: g.deck, played: ISO.test(g.played || "") ? g.played : op.at, result: g.result, opponents: names,
    turn: intIn(g.turn, 1, 60), issues: [...new Set(g.issues || [])].filter((i) => issues.has(i)), mvp: text(g.mvp, 120) || null,
    note: text(g.note, 2000), version: deck.version ?? null };
  if (ids.length) game.opponent_ids = ids;
  if (keysOf(options.how).has(g.how)) game.how = g.how;
  if (g.started === "me" || intIn(g.started, 0, names.length - 1) !== null) game.started = g.started;
  const { place, opponent_places } = cleanPlaces(g.place, places, names.length);
  if (place) game.place = place;
  if (opponent_places) game.opponent_places = opponent_places;
  if (g.round) game.round = g.round;  // the server cleans it (appops._round); Conclave Table sends it clean
  snap.games.unshift(game);
}

function newDeck(snap, op) {  // appops._deck_new: an empty deck the PC checks after its next sync
  const d = op.payload?.deck || {};
  const commanders = (d.commanders || []).map((c) => text(c, 160)).filter(Boolean).slice(0, 2);
  if (!commanders.length || snap.decks.some((x) => x.slug === d.slug)) return;
  const bracket = intIn(d.bracket, 1, 5) || 3, level = `Bracket ${bracket}`, who = commanders.join(" + ");
  // Rule 0 comes from the server's next read model; until then the two rows the phone knows
  const rule0 = (stufe) => ({ rows: [{ flag: false, label: stufe, value: level }, { flag: false, label: "Commander", value: who }], text: "" });
  snap.decks.unshift({ slug: d.slug, name: text(d.name, 120) || who, commanders, colors: "", bracket, tier: null, level, level_en: level,
    proxy: false, legal: null, description: "", version: 1, updated: op.at, checking: true, rule0: rule0("Stufe"), rule0_en: rule0("Level"),
    speed: null, cards: [], maybe: [], record: recordOf([]), pinned: false, shelved: false, pin_rank: null });
}

function editDeck(snap, op) {  // appops._deck_edit + maybe.change; refused or nothing changed = nothing shown
  const p = op.payload || {};
  const d = snap.decks.find((x) => x.slug === p.deck);
  if (!d) return;
  const commanders = new Set(d.commanders || []);
  const category = (k) => (CATEGORIES.includes(k) ? k : null);
  const cards = new Map(d.cards.map((c) => [c.name, { ...c }]));
  for (const a of p.add || []) {
    const name = text(a?.name, 160), qty = Math.max(1, intIn(a?.qty ?? 1, 0, 99) ?? 1);
    if (!name || commanders.has(name)) return;
    const c = cards.get(name);
    if (c) c.qty = Math.min(99, c.qty + qty); else cards.set(name, { name, qty, category: category(a.category) || "Synergy" });
  }
  for (const n of p.remove || []) cards.delete(text(n, 160));
  for (const [n, q] of Object.entries(p.set_qty || {})) {
    const c = cards.get(n);
    if (c && q === 0) cards.delete(n); else if (c && intIn(q, 1, 99)) c.qty = q;
  }
  for (const [n, k] of Object.entries(p.set_category || {})) { const c = cards.get(n); if (c && category(k)) c.category = k; }
  const maybe = new Map((d.maybe || []).filter((m) => !cards.has(m.name)).map((m) => [m.name, { ...m }]));
  for (const n of p.maybe_remove || []) maybe.delete(text(n, 160));
  for (const m of p.maybe_add || []) {
    const name = text(m?.name, 160);
    if (!name || commanders.has(name)) return;
    const c = cards.get(name);
    cards.delete(name);
    if (maybe.has(name) && !c) continue;
    maybe.set(name, { name, category: category(m.category) || c?.category || "Synergy" });
  }
  if (maybe.size > MAYBE_MAX) return;
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);  // Python's sort by name
  const next = { cards: [...cards.values()].sort(byName), maybe: [...maybe.values()].sort(byName) };
  if (JSON.stringify(next) === JSON.stringify({ cards: d.cards, maybe: d.maybe || [] })) return;
  Object.assign(d, next, { checking: true, version: (d.version || 0) + 1, updated: op.at });
}

function changeOpponent(snap, op) {  // appops.apply, opponent.*
  const p = op.payload || {};
  if (op.type === "opponent.add") {
    if (snap.opponents.some((o) => o.id === p.opponent?.id)) return;
    const o = newOpponent(snap, p.opponent || {}, op.at);
    if (!o) return;
    const said = text(p.note, 1000);
    if (said) o.notes = [note(p.note_id || `${op.id}-n`, said, op.at)];
    snap.opponents.push(o);
    return;
  }
  if (op.type === "opponent.delete") {
    snap.opponents = snap.opponents.filter((o) => o.id !== p.id);
    return;
  }
  const o = snap.opponents.find((x) => x.id === p.id);
  if (!o) return;
  if (op.type === "opponent.update") {  // games stay linked by id, so the record survives a new name or commander
    if ("commanders" in p) {
      const commanders = commandersOf(p.commanders);
      if (!commanders.length) return;
      if (JSON.stringify(commanders) !== JSON.stringify(o.commanders)) Object.assign(o, { commanders, colors: wubrg(p.colors) });
    }
    if ("tags" in p) { const tags = keysOf(snap.options?.tags); o.tags = [...new Set(p.tags || [])].filter((t) => tags.has(t)); }
    for (const k of ["player", "label"]) if (k in p) o[k] = text(p[k], 80);
    if ("bracket" in p) o.bracket = intIn(p.bracket, 1, 5);
    o.updated = op.at;
  } else if (op.type === "opponent.note") {
    const said = text(p.text, 1000);
    if (!said || (o.notes || []).some((n) => n.id === p.note_id)) return;
    o.notes = [note(p.note_id, said, op.at), ...(o.notes || [])].slice(0, NOTES_MAX);
    o.updated = op.at;
  } else if (op.type === "opponent.note_delete") {
    o.notes = (o.notes || []).filter((n) => n.id !== p.note_id);
  }
}

export function apply(snap, op) {
  const p = op.payload || {};
  if (op.type.startsWith("collection.")) applyCollection(snap, op);
  else if (op.type.startsWith("opponent.")) changeOpponent(snap, op);
  else if (op.type === "game.add") addGame(snap, op);
  else if (op.type === "game.delete") snap.games = snap.games.filter((g) => !(g.id === p.id && g.deck === p.deck));
  else if (op.type === "deck.new") newDeck(snap, op);
  else if (op.type === "deck.edit") editDeck(snap, op);
  else if (op.type === "deck.flags") {  // like appops._deck_flags: pinned / shelved, no new version
    const d = snap.decks.find((x) => x.slug === p.deck);
    for (const k of ["pinned", "shelved"]) if (d && typeof p[k] === "boolean") d[k] = p[k];
    if (d && !d.pinned) d.pin_rank = null;
  } else if (op.type === "deck.pin_order") {  // like appops._pin_order
    (p.slugs || []).forEach((slug, i) => { const d = snap.decks.find((x) => x.slug === slug); if (d?.pinned) d.pin_rank = i; });
  }
}

function recordOf(games) {
  const r = { games: games.length, wins: 0, losses: 0, draws: 0, last: null };
  for (const g of games) {
    r.wins += g.result === "win"; r.losses += g.result === "loss"; r.draws += g.result === "draw";
    if (!r.last || (g.played || "") > r.last) r.last = g.played;
  }
  return r;
}

function faced(o, g) {
  if ((g.opponent_ids || []).includes(o.id)) return true;
  const linked = (g.opponent_ids || []).filter(Boolean);
  const names = new Set((o.commanders || []).map((c) => c.toLowerCase()));
  return !linked.length && (g.opponents || []).some((n) => names.has(String(n).toLowerCase()));
}

// pinned decks first (newly pinned on top, then in the dragged order), shelved ones last (like storage.list_rank)
const deckRank = (d) => [(d.shelved ? 2 : 0) + (d.pinned ? 0 : 1), d.pinned && d.pin_rank != null ? 1 : 0, d.pinned ? d.pin_rank ?? 0 : 0];
// newest last game first, then the newest change (appdata.snapshot sorts decks and opponents this way)
const newestFirst = (a, b) => String(b.record.last || "").localeCompare(String(a.record.last || ""))
  || String(b.updated || "").localeCompare(String(a.updated || ""));
const byRank = (a, b) => { const x = deckRank(a), y = deckRank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

export function recompute(snap, colorsOf = () => "") {
  for (const d of snap.decks) {  // a deck the PC has not checked yet has no colour identity: take the commanders'
    if (!d.colors) d.colors = [..."WUBRG"].filter((c) => d.commanders.some((n) => colorsOf(n).includes(c))).join("");
  }
  snap.games.sort((a, b) => String(b.played).localeCompare(String(a.played)));
  for (const d of snap.decks) d.record = recordOf(snap.games.filter((g) => g.deck === d.slug));
  snap.decks.sort((a, b) => byRank(a, b) || newestFirst(a, b));  // like appdata.snapshot: pinned/shelved, then the last game
  const names = Object.fromEntries(snap.decks.map((d) => [d.slug, d.name]));
  for (const o of snap.opponents) {
    const mine = snap.games.filter((g) => faced(o, g));
    const per = {};
    for (const g of mine) {
      const p = (per[g.deck] ||= { slug: g.deck, name: names[g.deck] || g.deck, games: 0, wins: 0, losses: 0 });
      p.games++; p.wins += g.result === "win"; p.losses += g.result === "loss";
    }
    o.record = { ...recordOf(mine), per_deck: Object.values(per).sort((a, b) => b.games - a.games) };
    o.title = o.label ? `${o.label} (${o.commanders.join(" + ") || "?"})` : o.commanders.join(" + ") || "?";  // opponents.title
  }
  snap.opponents.sort(newestFirst);
  snap.players = [...new Set(snap.opponents.map((o) => o.player).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
}
