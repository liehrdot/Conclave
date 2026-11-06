// App state: the read model from the sync server plus the local operations on top of it (the outbox).
// Every change is an operation with its own id ("game.add", "opponent.add", …). It is applied locally at once
// (optimistic), kept in the outbox until the server confirms it, and the server applies the same operation to
// the synced documents (sync/appops.py) – sending one twice changes nothing there.
//
// Modes: "none" (not paired – the welcome screen), "demo" (example data, nothing leaves the phone), "live".

import { apply, recompute } from "./apply.js";
import { cached } from "./scry.js";
import { load, nowIso, save, uid } from "./util.js";

const KEY_DEVICE = "amtisch.device";
const KEY_BASE = "amtisch.base";
const KEY_OPS = "amtisch.ops";
const KEY_DEMO_OPS = "amtisch.demo.ops";
const KEY_MODE = "amtisch.mode";
const KEY_PREFS = "amtisch.prefs";
const SEND_DELAY_DEMO = 1500;
const TIMEOUT_MS = 12000;
const FLUSH_EVERY = 30000;
const STATUS_EVERY = 60000;

export const state = {
  mode: "none", device: null, base: null, snap: null, etag: null, ops: [], prefs: load(KEY_PREFS, {}),
  online: true, revoked: false, lastSync: null, pcs: [], syncing: false,
};
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn(state.snap));
export const isDemo = () => state.mode === "demo";

export function setPref(key, value) {
  state.prefs = { ...state.prefs, [key]: value };
  save(KEY_PREFS, state.prefs);
}

const opsKey = () => (state.mode === "demo" ? KEY_DEMO_OPS : KEY_OPS);
const saveOps = () => save(opsKey(), state.ops);

// ---------- start ------------------------------------------------------------------------------

export async function boot() {
  state.device = load(KEY_DEVICE, null);
  if (state.device) { bootLive(); return; }  // show the stored data at once; news come in the background
  if (load(KEY_MODE, null) === "demo") return bootDemo();
  state.mode = "none";
  emit();
}

// questions for Claude were removed: ones still queued from an older version of the app are dropped
const dropChat = (ops) => ops.filter((o) => !String(o.type).startsWith("chat."));

function bootLive() {
  state.mode = "live";
  state.ops = dropChat(load(KEY_OPS, []));
  const cached = load(KEY_BASE, null);
  state.base = cached?.data || null;
  state.etag = cached?.etag || null;
  rebuild();
  startTimers();
  return refresh().then(() => flush());
}

async function bootDemo() {
  state.mode = "demo";
  const res = await fetch("/app/demo.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("Beispieldaten fehlen");
  state.base = shiftDemoDates(await res.json());
  state.ops = dropChat(load(KEY_DEMO_OPS, []));
  rebuild();
  for (const o of state.ops.filter((x) => x.status === "pending")) demoSend(o);
}

export async function startDemo() { save(KEY_MODE, "demo"); await bootDemo(); }
export function endDemo() { save(KEY_MODE, null); Object.assign(state, { mode: "none", snap: null, base: null, ops: [] }); emit(); }

// demo data were written at a fixed time: move everything so the last game was "just now"
const DATE_KEYS = new Set(["played", "updated", "created", "at", "last"]);
function shiftDemoDates(base) {
  const ref = Date.parse(base.demo?.now || "");
  if (!ref) return base;
  const delta = Date.now() - ref;
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      if (DATE_KEYS.has(k) && typeof x === "string" && !Number.isNaN(Date.parse(x))) v[k] = new Date(Date.parse(x) + delta).toISOString();
      else walk(x);
    }
  };
  walk(base);
  return base;
}

function rebuild() {
  if (!state.base) { state.snap = null; emit(); return; }
  const snap = structuredClone(state.base);
  for (const op of state.ops) if (op.status !== "failed") apply(snap, op);
  recompute(snap, (name) => cached(name)?.colors || "");
  state.snap = snap;
  emit();
}

// ---------- talking to the sync server ---------------------------------------------------------

async function api(path, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeout || TIMEOUT_MS);
  try {
    const headers = { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) };
    if (state.device?.token) headers.Authorization = `Bearer ${state.device.token}`;
    const res = await fetch(path, { ...init, headers, signal: ctrl.signal, cache: "no-store" });
    if (res.status === 401 && state.mode === "live") revoked();
    return res;
  } finally { clearTimeout(timer); }
}
const detail = async (res) => { try { return (await res.json()).detail || `Fehler ${res.status}`; } catch { return `Fehler ${res.status}`; } };

/** Server calls that are no sync operations (AI card search): the JSON answer, or an Error with the German detail. */
export async function serverCall(path, { method = "GET", body, timeout } = {}) {
  if (state.mode !== "live") throw new Error("Nur mit deinem Server verbunden möglich – in der Vorschau geht das nicht.");
  let res;
  try {
    res = await api(path, { method, timeout, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error(state.online ? "Der Server antwortet nicht – bitte noch einmal versuchen." : "Ohne Netz geht das nicht.");
  }
  if (!res.ok) { const e = new Error(await detail(res)); e.status = res.status; throw e; }
  return res.json();
}

/** Pair this phone with a code from the PC; then load the data. */
export async function connect(code, name) {
  let res;
  try {
    res = await api("/api/pair/claim", { method: "POST", body: JSON.stringify({ code, name: (name || "Handy").slice(0, 60), kind: "phone" }) });
  } catch {
    throw new Error("Der Server ist gerade nicht erreichbar – Internetverbindung prüfen.");
  }
  if (!res.ok) throw new Error(await detail(res));
  const got = await res.json();
  state.device = { server: location.origin, token: got.token, device_id: got.device_id, name: got.name, paired_at: nowIso() };
  save(KEY_DEVICE, state.device);
  save(KEY_MODE, null);
  state.revoked = false;
  if (state.mode === "demo") { state.base = null; state.etag = null; }
  await bootLive();
  try { await navigator.storage?.persist?.(); } catch { /* not granted – the data is still kept while the app is used */ }
}

/** Sign this phone off on the server and forget everything that belongs to it here. */
export async function disconnect() {
  try { await api(`/api/devices/${encodeURIComponent(state.device?.device_id || "")}`, { method: "DELETE" }); } catch { /* offline: forget locally */ }
  stopTimers();
  for (const k of [KEY_DEVICE, KEY_BASE, KEY_OPS]) save(k, null);
  Object.assign(state, { mode: "none", device: null, base: null, snap: null, etag: null, ops: [], revoked: false, pcs: [] });
  emit();
}

function revoked() {
  stopTimers();
  state.revoked = true;
  state.device = null;
  save(KEY_DEVICE, null);  // the outbox stays: after pairing again it is sent
  state.mode = "none";
  emit();
}

// The ETag is "<server id>-<epoch>-<seq>". An HTTPS proxy in front may change it: Caddy's ``encode`` appends the
// compression ("…-5-zstd"), others make it weak (W/"…"). So only the three parts count – otherwise the seq reads
// as 0, confirmed operations never leave the outbox and a game deleted at the PC stays on the phone.
// "<server id>-<epoch>-<seq>", without W/, quotes and the "-zstd"/"-gzip" Caddy appends
const tagCore = (etag) => {
  const p = String(etag || "").replace(/^W\//, "").replaceAll('"', "").split("-");
  return p.length >= 3 && p.slice(0, 2).every((x) => /^[0-9a-f]+$/.test(x)) && /^\d+$/.test(p[2]) ? p.slice(0, 3).join("-") : "";
};
const seqOf = (etag) => Number(tagCore(etag).split("-").pop()) || 0;
let refreshing = null;

/** Load the read model (only when it changed – ETag). */
export function refresh() {
  if (state.mode !== "live") return Promise.resolve();
  if (refreshing) return refreshing;
  state.syncing = true;
  refreshing = (async () => {
    try {
      const res = await api("/api/app/data", { headers: state.etag && state.base ? { "If-None-Match": state.etag } : {} });
      if (res.status === 200) {
        state.base = await res.json();
        state.etag = res.headers.get("etag");
        save(KEY_BASE, { data: state.base, etag: state.etag });
      } else if (res.status !== 304) throw new Error(await detail(res));
      const have = seqOf(state.etag);
      state.ops = state.ops.filter((o) => !(o.status === "sent" && seqOf(o.ack) <= have));  // part of the read model now
      saveOps();
      state.online = true;
      state.lastSync = Date.now();
    } catch {
      state.online = false;
    } finally {
      state.syncing = false;
      refreshing = null;
      rebuild();
    }
  })();
  return refreshing;
}

let flushing = false, backoff = 0, nextTry = 0;
/** Send what waits in the outbox (in order). Confirmed operations stay applied until the next read. */
export async function flush(force = false) {
  if (state.mode !== "live" || flushing) return;
  const pending = state.ops.filter((o) => o.status === "pending");
  if (!pending.length || (!force && Date.now() < nextTry)) return;
  flushing = true;
  let more = false, ok = false;
  try {
    const batch = pending.slice(0, 50);
    const res = await api("/api/app/ops", { method: "POST", body: JSON.stringify({ ops: batch.map(({ id, type, payload, at }) => ({ id, type, payload, at })) }) });
    if (!res.ok) throw new Error(await detail(res));
    const out = await res.json();
    for (const r of out.results) {
      const o = state.ops.find((x) => x.id === r.id);
      if (!o) continue;
      if (r.ok) { o.status = "sent"; o.ack = out.etag; }
      else if (!r.retry) { o.status = "failed"; o.error = r.error; }
    }
    saveOps();
    backoff = 0; nextTry = 0;
    state.online = true;
    more = pending.length > batch.length;
    ok = true;
  } catch {
    if (state.mode === "live") {
      state.online = false;
      backoff = Math.min(backoff ? backoff * 2 : 5000, 300000);
      nextTry = Date.now() + backoff;
    }
  } finally {
    flushing = false;
  }
  if (ok) await refresh(); else rebuild();
  if (more) setTimeout(() => flush(true), 50);
}

async function pollStatus() {
  if (state.mode !== "live") return;
  try {
    const res = await api("/api/app/status");
    if (!res.ok) return;
    const st = await res.json();
    const shown = () => JSON.stringify([state.pcs.map(({ last_seen, ...p }) => p), state.online]);  // last_seen ticks on every request
    const before = shown();
    state.pcs = st.pcs || [];
    state.online = true;
    if (tagCore(st.etag) !== tagCore(state.etag)) await refresh();
    else if (shown() !== before) emit();  // redraw only when something visible changed
  } catch { state.online = false; emit(); }
}

let timers = [];
function startTimers() {
  stopTimers();
  const visible = () => document.visibilityState === "visible";
  timers.push(setInterval(() => { if (visible()) void flush(); }, FLUSH_EVERY));
  timers.push(setInterval(() => { if (visible()) void pollStatus(); }, STATUS_EVERY));
  void pollStatus();
}
function stopTimers() { timers.forEach(clearInterval); timers = []; }
/** Look for news now (app shown again, network back, "Jetzt aktualisieren"). */
export function wake() { if (state.mode === "live") { void flush(true); void pollStatus(); } }
addEventListener("online", wake);
addEventListener("offline", () => { state.online = false; emit(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wake(); });  // iOS: no background sync
addEventListener("pageshow", (e) => { if (e.persisted) wake(); });

// ---------- operations -------------------------------------------------------------------------

export const pendingCount = () => state.ops.filter((o) => o.status === "pending").length;
export const failedOps = () => state.ops.filter((o) => o.status === "failed");

export function op(type, payload) {
  const entry = { id: uid(), type, payload, at: nowIso(), status: "pending" };
  state.ops.push(entry);
  saveOps();
  rebuild();
  if (state.mode === "demo") demoSend(entry); else void flush(true);
  return entry;
}

function demoSend(entry) {  // the demo "server" accepts after a moment
  setTimeout(() => {
    const o = state.ops.find((x) => x.id === entry.id);
    if (!o || o.status !== "pending" || !navigator.onLine || state.mode !== "demo") return;
    o.status = "sent";
    saveOps();
    rebuild();
  }, SEND_DELAY_DEMO);
}

const INVERSE = {
  "game.add": (p) => ({ type: "game.delete", payload: { deck: p.game.deck, id: p.game.id } }),
  "game.delete": (p) => (p.restore ? { type: "game.add", payload: p.restore } : null),
  "opponent.add": (p) => ({ type: "opponent.delete", payload: { id: p.opponent.id } }),
  "opponent.note": (p) => ({ type: "opponent.note_delete", payload: { id: p.id, note_id: p.note_id } }),
  "opponent.update": (p) => (p.prev ? { type: "opponent.update", payload: { id: p.id, ...p.prev } } : null),
  "deck.flags": (p) => (p.prev ? { type: "deck.flags", payload: { deck: p.deck, ...p.prev } } : null),
  "deck.pin_order": (p) => (p.prev?.length ? { type: "deck.pin_order", payload: { slugs: p.prev } } : null),
  "collection.add": (p) => ({ type: "collection.add", payload: { entry: { ...p.entry, qty: -p.entry.qty } } }),
  "collection.update": (p) => (p.restore ? { type: "collection.add", payload: { entry: p.restore } }
    : p.prev ? { type: "collection.update", payload: { id: p.id, ...p.prev } } : null),
};

/** Take an operation back: not sent yet → it disappears; already sent (or already in the read model) → its
 *  opposite is sent. ``entry`` is the operation as ``op()`` returned it. */
export function undo(entry) {
  const o = state.ops.find((x) => x.id === entry.id);
  if (o && (o.status !== "sent" || state.mode === "demo")) {
    state.ops = state.ops.filter((x) => x.id !== entry.id);
    saveOps();
    rebuild();
    return;
  }
  if (!o && state.mode === "demo") return;
  const inv = INVERSE[entry.type]?.(entry.payload);
  if (inv) op(inv.type, inv.payload);
}

export function dropOp(opId) {
  state.ops = state.ops.filter((x) => x.id !== opId);
  saveOps();
  rebuild();
}

export function resetDemo() {
  state.ops = [];
  saveOps();
  rebuild();
}

// ---------- lookups ----------------------------------------------------------------------------

export const deckBy = (slug) => state.snap?.decks.find((d) => d.slug === slug) || null;
export const oppBy = (id) => state.snap?.opponents.find((o) => o.id === id) || null;
export const shortName = (name) => String(name || "?").split(/,| \/\/ /)[0].trim();
export function oppName(o) {
  if (!o) return "?";
  if (o.label) return o.label;
  const c = o.commanders || [];
  return c.length > 1 ? `${shortName(c[0])} & ${shortName(c[1])}` : shortName(c[0]);
}
export const oppSub = (o) => [o.player, (o.commanders || []).join(" + ")].filter(Boolean).join(" · ");
export function currentDeck() {
  const s = state.snap;
  if (!s?.decks.length) return null;
  return deckBy(state.prefs.deck) || deckBy(s.games[0]?.deck) || s.decks[0];
}
export const gamesOf = (slug) => state.snap.games.filter((g) => g.deck === slug);
export const isPending = (gameId) => state.ops.some((o) => o.status === "pending" && o.type === "game.add" && o.payload?.game?.id === gameId);

export { PLACES_MAX, cleanPlaces, collKey } from "./apply.js";
