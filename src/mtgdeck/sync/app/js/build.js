// Deck bauen (#/bauen/<slug>): card search on one side, the deck on the other – side by side on an iPad, with a
// switch on a phone. Every tap goes into a draft on this device (survives closing the app, works offline); "Speichern"
// sends the draft as one "deck.edit" operation, so the deck gets one new version, like a saved edit at the PC. The
// check (legality, bracket, price) runs on the PC after its next sync – card data never goes through the server.
// The maybe list ("Vielleicht") collects cards the user is unsure about; they never count towards the deck. A card is in
// the deck or on its maybe list, never both (sync/../maybe.py does the same on the server).

import { deckBy, onChange, op, serverCall, state } from "./data.js";
import { cardSheet } from "./forms.js";
import * as scry from "./scry.js";
import { art, CAT_LABELS, CATS, paint } from "./screens.js";
import { closeSheet, openSheet, redraw as redrawSheet, toast } from "./ui.js";
import { $, $$, debounce, esc, icon, load, mana, pips, plural, reducedMotion, save, vibrate } from "./util.js";

const KEY = "amtisch.build";
// slug -> {cards: {name: {qty, category}}, maybe: {name: {on, category}}} – only the cards touched, with their new state
const drafts = load(KEY, {});
const keep = () => save(KEY, drafts);
const BASICS = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes", "Snow-Covered Plains", "Snow-Covered Island",
  "Snow-Covered Swamp", "Snow-Covered Mountain", "Snow-Covered Forest", "Snow-Covered Wastes"]);
const BASIC_OF = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };
const FILTERS = [["", "Beliebt"], ["otag:ramp", "Ramp"], ["otag:draw", "Kartenzug"], ["otag:removal", "Removal"], ["otag:sweeper", "Board Wipes"],
  ["otag:counterspell", "Counter"], ["otag:tutor", "Tutoren"], ["t:creature", "Kreaturen"], ["t:land -t:basic", "Länder"]];
const SHOW_STEP = 30;

/** The builder is for tablets only (iPad Air 11": 820 × 1180), never on a phone – also not a phone turned sideways,
 *  so the shorter side of the screen decides. */
export const tabletSized = () => Math.min(screen.width, screen.height) >= 700;

// ---------- the draft ------------------------------------------------------------------------------------------

/** Several copies allowed: basic lands and cards that say so (Relentless Rats, Shadowborn Apostle …). */
const manyAllowed = (name) => BASICS.has(name) || /a deck can have any number of cards named/i.test(scry.cached(name)?.text || "");

/** The category the desktop app would guess (deckedit.guess_category), from type line and rules text. */
export function guessCategory(name) {
  if (BASICS.has(name)) return "Land";
  const c = scry.cached(name);
  const type = (c?.type || "").split("//")[0];
  const text = (c?.text || "").toLowerCase();
  if (/\bLand\b/.test(type)) return "Land";
  if (/(destroy|exile) all |all creatures get -|each creature gets -|return all (nonland|creatures)/.test(text)) return "Board Wipe";
  if (/counter target|(destroy|exile) target|return target (creature|nonland|permanent)[^.]* to its owner's hand/.test(text)) return "Removal";
  if (/add \{|add (one|two|three) mana|search your library for (a|up to \w+) (basic )?lands?/.test(text)) return "Ramp";
  if (/draws? (a|an additional|two|three|four|x|that many) cards?/.test(text)) return "Draw";
  if (/(hexproof|indestructible|protection from|phase out)/.test(text) && /(you control|target creature)/.test(text)) return "Protection";
  return "Synergy";
}

const current = (d) => Object.fromEntries(d.cards.map((c) => [c.name, { qty: c.qty, category: c.category || "Synergy" }]));

/** The cards as they will be: the deck from the server with the draft on top (``was`` = the server's quantity). */
function merged(d) {
  const cur = current(d);
  const draft = drafts[d.slug]?.cards || {};
  const out = {};
  for (const [name, c] of Object.entries(cur)) out[name] = { name, ...c, was: c.qty, wasCat: c.category };
  for (const [name, c] of Object.entries(draft)) out[name] = { name, was: 0, wasCat: null, ...out[name], ...c };
  return Object.values(out);
}

const savedMaybe = (d) => Object.fromEntries((d.maybe || []).map((m) => [m.name, m]));

/** The maybe list as it will be: saved entries minus what goes into the deck or is taken off, plus the draft's. */
function maybeList(d) {
  const draft = drafts[d.slug]?.maybe || {};
  const inDeck = new Set(merged(d).filter((c) => c.qty > 0).map((c) => c.name));
  const out = {};
  for (const m of d.maybe || []) if (draft[m.name]?.on !== false) out[m.name] = { name: m.name, category: m.category || "Synergy", isNew: false };
  for (const [name, m] of Object.entries(draft)) if (m.on && !out[name]) out[name] = { name, category: m.category, isNew: true, fromDeck: !!current(d)[name] };
  return Object.values(out).filter((m) => !inDeck.has(m.name)).sort((a, b) => a.name.localeCompare(b.name));
}
const isMaybe = (d, name) => maybeList(d).some((m) => m.name === name);

/** What the draft changes compared with the deck from the server (also after the PC changed the deck meanwhile). */
export function changes(d) {
  const cur = current(d);
  const draft = drafts[d.slug]?.cards || {};
  const saved = savedMaybe(d);
  const maybeAdd = Object.entries(drafts[d.slug]?.maybe || {}).filter(([n, m]) => m.on && !saved[n] && !(draft[n]?.qty > 0)).map(([name, m]) => ({ name, category: m.category }));
  const maybeRemove = Object.entries(drafts[d.slug]?.maybe || {}).filter(([n, m]) => !m.on && saved[n]).map(([n]) => n);
  const moving = new Set(maybeAdd.map((m) => m.name));  // deck → maybe: the server moves it, no separate removal
  const add = [], setQty = {}, setCat = {};
  for (const [name, c] of Object.entries(draft)) {
    const was = cur[name];
    if (!was) { if (c.qty > 0) add.push({ name, qty: c.qty, category: c.category }); continue; }
    if (c.qty !== was.qty && !(c.qty === 0 && moving.has(name))) setQty[name] = c.qty;
    if (c.qty > 0 && c.category !== was.category) setCat[name] = c.category;
  }
  const count = add.length + Object.keys(setQty).length + Object.keys(setCat).filter((n) => !(n in setQty)).length + maybeAdd.length + maybeRemove.length;
  return { add, set_qty: setQty, set_category: setCat, maybe_add: maybeAdd, maybe_remove: maybeRemove, count };
}
export const draftCount = (d) => (d && drafts[d.slug] ? changes(d).count : 0);

function setCard(d, name, patch) {
  const was = current(d)[name];
  const draft = (drafts[d.slug] ||= { cards: {} });
  draft.cards ||= {};
  const now = { qty: was?.qty || 0, category: was?.category || guessCategory(name), ...draft.cards[name], ...patch };
  if (was && now.qty === was.qty && now.category === was.category) delete draft.cards[name];
  else if (!was && now.qty <= 0) delete draft.cards[name];
  else draft.cards[name] = now;
  if (now.qty > 0 && draft.maybe?.[name]) delete draft.maybe[name];  // into the deck: off the maybe list
  tidy(d);
  keep();
  changed();
}

function tidy(d) {
  const draft = drafts[d.slug];
  if (!draft) return;
  if (draft.maybe && !Object.keys(draft.maybe).length) delete draft.maybe;
  if (!Object.keys(draft.cards || {}).length && !draft.maybe) delete drafts[d.slug];
}

/** Put a card on the maybe list; a card in the deck moves there (it leaves the deck). */
function toMaybe(d, name, { quiet = false } = {}) {
  if (d.commanders.includes(name)) { toast(`${name} ist dein Commander.`); return; }
  if (isMaybe(d, name)) { if (!quiet) toast(`${name} steht schon auf „Vielleicht“`); return; }
  const have = qtyOf(d, name);
  const before = JSON.stringify(drafts[d.slug] || null);
  const draft = (drafts[d.slug] ||= { cards: {} });
  const category = merged(d).find((c) => c.name === name)?.category || guessCategory(name);
  draft.maybe = { ...draft.maybe, [name]: { on: true, category } };
  if (have) setCard(d, name, { qty: 0 }); else { keep(); changed(); }
  vibrate(10);
  if (!quiet) toast(have ? `${name} → Vielleicht` : `${name} auf „Vielleicht“`, { ok: true, ms: 2200, sub: "Zählt nicht zum Deck.",
    action: { label: "Rückgängig", run: () => { const old = JSON.parse(before); if (old) drafts[d.slug] = old; else delete drafts[d.slug]; keep(); changed(); } } });
}

/** Take a card off the maybe list (not into the deck). */
function offMaybe(d, name) {
  const draft = (drafts[d.slug] ||= { cards: {} });
  draft.maybe ||= {};
  if (draft.maybe[name]?.on) delete draft.maybe[name];
  else if (savedMaybe(d)[name]) draft.maybe[name] = { on: false };
  tidy(d);
  keep();
  changed();
}

/** From the maybe list into the deck, with the category it had there. */
function maybeToDeck(d, name) {
  const m = maybeList(d).find((x) => x.name === name);
  if (!m) return;
  const draft = drafts[d.slug];
  if (draft?.maybe?.[name]?.on) delete draft.maybe[name];
  if (m.fromDeck) { const was = current(d)[name]; setCard(d, name, { qty: was.qty, category: was.category }); return; }
  setCard(d, name, { qty: 1, category: m.category });
  vibrate(10);
  toast(`${name} ins Deck`, { ok: true, ms: 2200, action: { label: "Rückgängig", run: () => setCard(d, name, { qty: 0 }) } });
}

const qtyOf = (d, name) => merged(d).find((c) => c.name === name)?.qty || 0;

function addCard(d, name) {
  if (d.commanders.includes(name)) { toast(`${name} ist dein Commander.`); return; }
  const have = qtyOf(d, name);
  if (have && !manyAllowed(name)) { toast(`${name} ist schon im Deck`, { sub: "In Commander gibt es jede Karte nur einmal." }); return; }
  setCard(d, name, { qty: have + 1 });
  vibrate(10);
  toast(have ? `${name}: jetzt ${have + 1}×` : `${name} hinzugefügt`, { ok: true, ms: 2200, action: { label: "Rückgängig", run: () => setCard(d, name, { qty: have }) } });
}

function saveDraft(d) {
  const c = changes(d);
  if (!c.count) return;
  const payload = { deck: d.slug };
  if (c.add.length) payload.add = c.add;
  if (Object.keys(c.set_qty).length) payload.set_qty = c.set_qty;
  if (Object.keys(c.set_category).length) payload.set_category = c.set_category;
  if (c.maybe_add.length) payload.maybe_add = c.maybe_add;
  if (c.maybe_remove.length) payload.maybe_remove = c.maybe_remove;
  op("deck.edit", payload);
  delete drafts[d.slug];
  keep();
  vibrate(18);
  toast(`${plural(c.count, "Änderung", "Änderungen")} gespeichert`, { ok: true, sub: "Dein PC prüft das Deck beim nächsten Abgleich." });
  changed();
}

function discard(d) {
  const before = drafts[d.slug];
  if (!before) return;
  delete drafts[d.slug];
  keep();
  changed();
  toast("Änderungen verworfen", { action: { label: "Rückgängig", run: () => { drafts[d.slug] = before; keep(); changed(); } } });
}

// ---------- the screen -----------------------------------------------------------------------------------------

// what the search shows; kept while the app runs, so a redraw (data from the server) changes nothing on screen
const S = { slug: null, pane: "search", mode: "name", q: "", filter: "", desc: "", result: null, busy: false, error: null, seq: 0 };
let mounted = null;  // the slug of the builder on screen

export function builder(wanted) {
  const d = deckBy(wanted);
  if (!tabletSized()) {
    mounted = null;
    return { html: `<div class="empty">${icon("decks")}<h3>Decks baust du auf dem iPad</h3><p>Auf dem Handy siehst du deine Decks – bauen geht auf dem iPad oder am PC.</p>
      <div class="btn-col"><a class="btn tint" href="#/decks">Zu den Decks</a></div></div>`, bar: { title: "Deck bauen", back: { href: "#/decks", label: "Decks" }, always: true } };
  }
  if (!d) {
    mounted = null;
    return { html: `<div class="empty">${icon("decks")}<h3>Deck nicht gefunden</h3><p>Vielleicht wurde es am PC gelöscht.</p></div>`,
      bar: { title: "Deck bauen", back: { href: "#/decks", label: "Decks" }, always: true } };
  }
  const slug = d.slug;  // the deck's own slug, not the text from the address
  if (S.slug !== slug) Object.assign(S, { slug, pane: "search", q: "", filter: "", desc: "", result: null, busy: false, error: null });
  const html = `
    <div class="build-head">
      <a class="icon-btn filled" href="#/decks/${esc(slug)}/karten" aria-label="Zurück zum Deck">${icon("chev-l")}</a>
      <div class="build-title"><span class="kicker">Deck bauen</span><span class="t">${esc(d.name)}</span></div>
      <span class="build-count" id="b-count"></span>
    </div>
    <div class="segmented build-switch" role="tablist" aria-label="Ansicht">
      <button type="button" role="tab" data-pane="search">${icon("search", "xs")}Suchen</button>
      <button type="button" role="tab" data-pane="deck">${icon("decks", "xs")}Deck <span id="b-pane-count"></span></button>
    </div>
    <div class="builder" id="builder" data-pane="${S.pane}">
      <section class="pane pane-search" aria-label="Karten suchen">
        <div class="segmented card-mode" role="tablist" aria-label="Suchart">
          <button type="button" role="tab" data-mode="name">${icon("search", "xs")}Name</button>
          <button type="button" role="tab" data-mode="describe">${icon("sparkle", "xs")}Beschreiben</button></div>
        <form id="b-name" class="b-form">
          <label class="search"><span class="sr">Karte suchen</span>${icon("search")}<input class="input" id="b-q" type="search" placeholder="Kartenname, deutsch oder englisch" value="${esc(S.q)}" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          <div class="chips scroll b-filters" id="b-filters">${FILTERS.map(([q, l]) => `<button class="chip" type="button" data-filter="${esc(q)}">${esc(l)}</button>`).join("")}</div>
        </form>
        <form id="b-describe" class="b-form describe">
          <label class="sr" for="b-desc">Was soll die Karte tun?</label>
          <textarea class="textarea" id="b-desc" maxlength="400" enterkeyhint="search" placeholder="Was soll die Karte tun? z. B. „holt Kreaturen aus dem Friedhof zurück“">${esc(S.desc)}</textarea>
          <button class="btn primary big" type="submit">${icon("sparkle", "sm")}Karten finden</button>
          <p class="hint-small">Nur Karten in den Farben deines Commanders (${pips(d.colors)}).</p>
        </form>
        <div id="b-results" aria-live="polite"></div>
      </section>
      <section class="pane pane-deck" aria-label="Dein Deck" id="b-deck"></section>
    </div>
    <div class="build-bar" id="b-bar" hidden></div>`;
  return {
    html, immersive: true, wide: true,
    bar: { title: d.name, back: { href: `#/decks/${encodeURIComponent(slug)}/karten`, label: "Deck" }, watch: ".build-title" },
    bind(el) { mounted = slug; bindBuilder(el, d); },
  };
}

// the draft or the deck changed (a tap here, the server's answer, a sync): update the parts that show it
function changed() {
  const el = document.getElementById("builder");
  const d = deckBy(mounted);
  if (!el || !d) return;
  renderDeck(d);
  renderBar(d);
  markTiles(d);
}
onChange(() => { if (mounted && location.hash.startsWith("#/bauen/")) changed(); else mounted = null; });

function bindBuilder(el, d) {
  const root = $("#builder", el);
  const setPane = (pane) => {
    S.pane = pane;
    root.dataset.pane = pane;
    for (const b of $$("[data-pane]", el)) { const on = b.dataset.pane === pane; b.setAttribute("aria-pressed", on); b.setAttribute("aria-selected", on); }
    scrollTo({ top: 0 });
  };
  for (const b of $$(".build-switch [data-pane]", el)) b.addEventListener("click", () => setPane(b.dataset.pane));
  setPane(S.pane);

  const setMode = (mode) => {
    S.mode = mode;
    for (const b of $$("[data-mode]", el)) { const on = b.dataset.mode === mode; b.setAttribute("aria-pressed", on); b.setAttribute("aria-selected", on); }
    $("#b-name", el).hidden = mode !== "name";
    $("#b-describe", el).hidden = mode !== "describe";
  };
  for (const b of $$("[data-mode]", el)) b.addEventListener("click", () => setMode(b.dataset.mode));
  setMode(S.mode);

  // by name (and/or a filter chip): Scryfall search, most played in Commander first
  const input = $("#b-q", el);
  const markFilters = () => { for (const b of $$("[data-filter]", el)) b.setAttribute("aria-pressed", b.dataset.filter === S.filter); };
  markFilters();
  const go = debounce(() => runName(d), 320);
  input.addEventListener("input", () => { S.q = input.value; go(); });
  $("#b-name", el).addEventListener("submit", (e) => { e.preventDefault(); input.blur(); void runName(d); });
  for (const b of $$("[data-filter]", el)) b.addEventListener("click", () => { S.filter = S.filter === b.dataset.filter && b.dataset.filter ? "" : b.dataset.filter; markFilters(); void runName(d); });

  // by description: the AI turns it into a Scryfall search (in the commander's colours), then the same grid
  const text = $("#b-desc", el);
  text.addEventListener("input", () => { S.desc = text.value; });
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#b-describe", el).requestSubmit(); } });
  $("#b-describe", el).addEventListener("submit", (e) => { e.preventDefault(); void runDescribe(d, text); });

  if (!S.result && !S.busy && !S.error) void runName(d); else renderResults(d);
  renderDeck(d);
  renderBar(d);
}

const identity = (d) => [..."WUBRG"].filter((c) => d.colors.includes(c)).join("") || "c";
const inColors = (d, name) => {
  const c = scry.cached(name);
  return !c || [...(c.colors || "")].every((x) => d.colors.includes(x));
};

async function search(d, query, extra = {}) {
  const mine = ++S.seq;
  S.busy = extra.busy || "Suche …"; S.error = null;
  renderResults(d);
  try {
    let page = await scry.searchQuery(query);
    if (!page.total && extra.broader) { page = await scry.searchQuery(extra.broader); query = extra.broader; extra.wider = true; }
    if (!page.total && extra.multilingual) page = await scry.searchQuery(query, 1, { multilingual: true });
    if (mine !== S.seq) return;
    S.result = { query, cards: extra.first ? scry.exactFirst(page.cards, extra.first) : page.cards, total: page.total, next: page.next, show: SHOW_STEP, explain: extra.explain || "", wider: !!extra.wider, title: extra.title || "" };
  } catch (e) {
    if (mine !== S.seq) return;
    S.error = e;
  }
  S.busy = false;
  renderResults(d);
}

function runName(d) {
  const q = S.q.trim();
  const label = FILTERS.find(([f]) => f === S.filter)?.[1];
  // typed name: everything with that name (cards outside the colours are shown, but greyed out); else the colours
  const query = q ? `${q} ${S.filter} f:commander` : `${S.filter} f:commander id<=${identity(d)} -t:basic`;
  const title = q ? "Treffer" : S.filter ? `${label} in deinen Farben` : "Beliebt in deinen Farben";
  return search(d, query.replace(/\s+/g, " ").trim(), { title, multilingual: !!q, first: q });
}

async function runDescribe(d, text) {
  S.desc = text.value;
  if (S.desc.trim().length < 3) { text.focus(); toast("Beschreib kurz, was die Karte tun soll."); return; }
  text.blur();
  const mine = ++S.seq;
  S.busy = "Die KI übersetzt deine Beschreibung …"; S.error = null;
  renderResults(d);
  try {
    const colors = [...identity(d).toUpperCase(), "C"].filter((c, i, a) => a.indexOf(c) === i);  // colourless cards fit every deck
    const got = await serverCall("/api/app/cards/describe", { method: "POST", body: { text: S.desc.trim(), colors, types: [] }, timeout: 60000 });
    if (mine !== S.seq) return;
    await search(d, got.query, { explain: got.explain, broader: got.broader, busy: "Scryfall wird gefragt …", title: "Passende Karten" });
  } catch (e) {
    if (mine !== S.seq) return;
    S.busy = false; S.error = e; renderResults(d);
  }
}

function tile(d, c) {
  const off = !inColors(d, c.name);
  return `<div class="tile${off ? " off" : ""}" data-tile="${esc(c.name)}">
    <button class="tile-img" type="button" data-open="${esc(c.name)}" aria-label="${esc(c.name)} ansehen">${art(c.name, "image", "tile-pic")}<span class="tile-name">${esc(c.name)}</span></button>
    ${off ? `<span class="tile-off">Nicht in deinen Farben</span>`
      : `<button class="tile-maybe" type="button" data-maybe="${esc(c.name)}" aria-label="${esc(c.name)} auf die Vielleicht-Liste">${icon("maybe")}</button>
         <button class="tile-add" type="button" data-add="${esc(c.name)}" aria-label="${esc(c.name)} ins Deck">${icon("plus")}</button>`}
    <span class="tile-have" aria-hidden="true"></span>
  </div>`;
}

function renderResults(d) {
  const out = document.getElementById("b-results");
  if (!out) return;
  if (S.busy) {
    out.innerHTML = `<div class="ai-busy" role="status"><span class="ai-dots" aria-hidden="true"><span></span><span></span><span></span></span><span>${esc(S.busy)}</span></div>`;
    return;
  }
  if (S.error) {
    const setup = S.error.status === 409;
    out.innerHTML = `<div class="empty">${icon(setup ? "sparkle" : "alert")}<h3>${setup ? "Noch nicht eingerichtet" : "Das hat nicht geklappt"}</h3>
      <p>${esc(setup ? "Für die Suche mit KI braucht der Server einmal deinen Claude-API-Schlüssel." : S.error.message)}</p>
      ${setup ? `<div class="btn-col"><button class="btn primary" type="button" id="b-ai-setup">Jetzt einrichten</button></div>` : ""}</div>`;
    $("#b-ai-setup", out)?.addEventListener("click", () => import("./forms.js").then((m) => m.aiSheet({ onSaved: () => { S.error = null; renderResults(d); } })));
    return;
  }
  const r = S.result;
  if (!r) { out.innerHTML = ""; return; }
  out.innerHTML = `${r.explain ? `<div class="query-box"><div class="query-head"><span>${icon("sparkle", "xs")} ${esc(r.explain)}</span></div><code class="query">${esc(r.query)}</code>
      ${r.wider ? `<p class="hint-small">Genau so gab es nichts – das ist die breitere Suche.</p>` : ""}</div>` : ""}
    ${r.total ? `<div class="section-head"><h2>${esc(r.title)}</h2><span class="hint-small">${plural(r.total, "Karte", "Karten")}</span></div>
      <div class="tiles">${r.cards.slice(0, r.show).map((c) => tile(d, c)).join("")}</div>
      ${r.cards.length > r.show || r.next ? `<div class="btn-col"><button class="btn" type="button" id="b-more">Mehr zeigen</button></div>` : ""}`
      : `<div class="empty">${icon("search")}<h3>Keine Karte gefunden</h3><p>${r.explain ? "Beschreib es etwas allgemeiner." : "Anders schreiben oder den Filter weglassen."}</p></div>`}`;
  for (const b of $$("[data-add]", out)) b.addEventListener("click", () => addCard(deckBy(d.slug) || d, b.dataset.add));
  for (const b of $$("[data-maybe]", out)) b.addEventListener("click", () => toMaybe(deckBy(d.slug) || d, b.dataset.maybe));
  for (const b of $$("[data-open]", out)) b.addEventListener("click", () => openCard(d.slug, b.dataset.open));
  $("#b-more", out)?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    if (r.cards.length <= r.show && r.next) {
      try { const page = await scry.searchQuery(r.query, r.next); r.cards.push(...page.cards); r.next = page.next; } catch (err) { toast(err.message); }
    }
    r.show += SHOW_STEP;
    renderResults(d);
  });
  scry.hydrate(out);
  markTiles(d);
}

// a check and the count on the cards that are in the deck already
function markTiles(d) {
  d = deckBy(d.slug) || d;
  const have = Object.fromEntries(merged(d).filter((c) => c.qty > 0).map((c) => [c.name, c.qty]));
  for (const c of d.commanders) have[c] = "C";
  for (const m of maybeList(d)) have[m.name] = "?";
  for (const t of $$("[data-tile]")) {
    const n = have[t.dataset.tile];
    t.classList.toggle("in", !!n && n !== "?");
    t.classList.toggle("maybe", n === "?");
    t.querySelector(".tile-have").innerHTML = n === "?" ? `${icon("maybe", "xs")}Vielleicht` : n ? `${icon("check", "xs")}${n === "C" ? "Commander" : n > 1 ? `${n}×` : "Im Deck"}` : "";
  }
}

function count(d) {
  return merged(d).reduce((n, c) => n + c.qty, 0) + d.commanders.length;
}

function renderDeck(d) {
  d = deckBy(d.slug) || d;
  const box = document.getElementById("b-deck");
  if (!box) return;
  const cards = merged(d);
  const live = cards.filter((c) => c.qty > 0);
  const maybe = maybeList(d);
  const gone = cards.filter((c) => c.qty === 0 && c.was > 0 && !maybe.some((m) => m.name === c.name));
  // basic lands get steppers of their own (Scryfall's search leaves them out), one per colour of the commander
  const basicNames = [...new Set([...[..."WUBRG"].filter((c) => d.colors.includes(c)).map((c) => BASIC_OF[c]), ...live.filter((c) => BASICS.has(c.name)).map((c) => c.name)])];
  if (!basicNames.length) basicNames.push("Wastes");
  const groups = {};
  for (const c of live) if (!BASICS.has(c.name)) (groups[c.category] ||= []).push(c);
  const order = [...CATS, ...Object.keys(groups).filter((k) => !CATS.includes(k))].filter((k) => groups[k]);
  const total = count(d);
  const lands = live.filter((c) => c.category === "Land").reduce((n, c) => n + c.qty, 0);
  const row = (c) => {
    const tag = !c.was ? `<span class="b-tag new">neu</span>` : c.qty !== c.was ? `<span class="b-tag">${c.was}→${c.qty}</span>` : c.category !== c.wasCat ? `<span class="b-tag">verschoben</span>` : "";
    return `<div class="row b-row"><button class="b-open" type="button" data-deck-card="${esc(c.name)}">
        <span class="thumb card-thumb">${art(c.name, "small", "thumb card-thumb")}</span>
        <span class="main"><span class="title">${esc(c.name)}</span>${tag ? `<span class="subtitle">${tag}</span>` : ""}</span></button>
      ${c.qty > 1 || manyAllowed(c.name) ? `<span class="b-qty">${c.qty}×</span>` : ""}
      <button class="icon-btn b-minus" type="button" data-minus="${esc(c.name)}" aria-label="${esc(c.name)} ${c.qty > 1 ? "einmal weniger" : "herausnehmen"}">${icon(c.qty > 1 ? "minus" : "x", "sm")}</button></div>`;
  };
  box.innerHTML = `
    <div class="b-sum">
      <div class="b-meter" role="img" aria-label="${total} von 100 Karten"><span data-meter></span></div>
      <div class="b-sum-text"><b>${total}</b><span>/ 100 Karten</span>${total === 100 ? `<span class="b-ok">${icon("check", "xs")}voll</span>` : ""}</div>
      <div class="b-sum-sub">${plural(lands, "Land", "Länder")}${d.checking && !draftCount(d) ? ` · wird am PC geprüft` : d.legal === false ? ` · <span class="flag">am PC nicht legal</span>` : ""}</div>
    </div>
    <div class="cat-head"><span>Commander</span></div>
    <div class="group cards-group">${d.commanders.map((c) => `<button class="row b-open" type="button" data-open-card="${esc(c)}">
      <span class="thumb card-thumb">${art(c, "small", "thumb card-thumb")}</span><span class="main"><span class="title">${esc(c)}</span></span></button>`).join("")}</div>
    ${order.map((k) => `<div class="cat-head"><span>${esc(CAT_LABELS[k] || k)}</span><span>${groups[k].reduce((n, c) => n + c.qty, 0)}</span></div>
      <div class="group cards-group">${groups[k].sort((a, b) => a.name.localeCompare(b.name)).map(row).join("")}</div>`).join("")}
    <div class="cat-head"><span>Standardländer</span><span>${live.filter((c) => BASICS.has(c.name)).reduce((n, c) => n + c.qty, 0)}</span></div>
    <div class="group cards-group">${basicNames.map((n) => { const q = qtyOf(d, n); return `<div class="row b-row b-basic"><span class="pip-big ${n === "Wastes" ? "C" : Object.keys(BASIC_OF).find((k) => BASIC_OF[k] === n) || "C"}" aria-hidden="true"></span>
      <span class="main"><span class="title">${esc(n)}</span></span>
      <div class="stepper"><button type="button" data-basic="${esc(n)}" data-step="-1" aria-label="Ein ${esc(n)} weniger"${q ? "" : " disabled"}>−</button><output>${q}</output><button type="button" data-basic="${esc(n)}" data-step="1" aria-label="Ein ${esc(n)} mehr">+</button></div></div>`; }).join("")}</div>
    ${live.length ? "" : `<div class="empty small">${icon("plus")}<h3>Noch keine Karten</h3><p>Tipp auf das Plus bei einer Karte links – oder such sie zuerst.</p></div>`}
    ${gone.length ? `<div class="cat-head"><span>Herausgenommen</span><span>${gone.length}</span></div>
      <div class="group cards-group">${gone.map((c) => `<div class="row b-row gone"><span class="thumb card-thumb">${art(c.name, "small", "thumb card-thumb")}</span>
        <span class="main"><span class="title">${esc(c.name)}</span></span>
        <button class="btn plain small" type="button" data-back="${esc(c.name)}">Zurück</button></div>`).join("")}</div>` : ""}
    <div class="cat-head maybe-head"><span>${icon("maybe", "xs")}Vielleicht</span><span>${maybe.length ? `${maybe.length} · zählt nicht` : ""}</span></div>
    ${maybe.length ? `<div class="group cards-group maybe-group">${maybe.map((m) => `<div class="row b-row"><button class="b-open" type="button" data-maybe-card="${esc(m.name)}">
        <span class="thumb card-thumb">${art(m.name, "small", "thumb card-thumb")}</span>
        <span class="main"><span class="title">${esc(m.name)}</span><span class="subtitle">${m.isNew ? `<span class="b-tag new">${m.fromDeck ? "aus dem Deck" : "neu"}</span> ` : ""}${esc(CAT_LABELS[m.category] || m.category)}${inColors(d, m.name) ? "" : ` · <span class="flag">nicht in deinen Farben</span>`}</span></span></button>
        <button class="icon-btn b-in" type="button" data-maybe-in="${esc(m.name)}" aria-label="${esc(m.name)} ins Deck">${icon("plus", "sm")}</button>
        <button class="icon-btn b-minus" type="button" data-maybe-off="${esc(m.name)}" aria-label="${esc(m.name)} von der Vielleicht-Liste nehmen">${icon("x", "sm")}</button></div>`).join("")}</div>`
      : `<p class="hint-small maybe-empty">Unsicher bei einer Karte? Tipp auf ${icon("maybe", "xs")} – sie kommt auf die Vielleicht-Liste und zählt nicht zum Deck.</p>`}`;
  box.querySelector("[data-meter]").style.width = `${Math.min(100, total)}%`;
  box.querySelector(".b-meter").classList.toggle("over", total > 100);
  for (const b of $$("[data-minus]", box)) b.addEventListener("click", () => { const n = b.dataset.minus; setCard(d, n, { qty: qtyOf(d, n) - 1 }); });
  for (const b of $$("[data-basic]", box)) b.addEventListener("click", () => { const n = b.dataset.basic; setCard(d, n, { qty: Math.max(0, qtyOf(d, n) + Number(b.dataset.step)), category: "Land" }); });
  for (const b of $$("[data-back]", box)) b.addEventListener("click", () => { const c = gone.find((x) => x.name === b.dataset.back); setCard(d, c.name, { qty: c.was, category: c.wasCat }); });
  for (const b of $$("[data-deck-card]", box)) b.addEventListener("click", () => deckCardSheet(d.slug, b.dataset.deckCard));
  for (const b of $$("[data-open-card]", box)) b.addEventListener("click", () => cardSheet(b.dataset.openCard));
  for (const b of $$("[data-maybe-in]", box)) b.addEventListener("click", () => maybeToDeck(deckBy(d.slug) || d, b.dataset.maybeIn));
  for (const b of $$("[data-maybe-off]", box)) b.addEventListener("click", () => offMaybe(deckBy(d.slug) || d, b.dataset.maybeOff));
  for (const b of $$("[data-maybe-card]", box)) b.addEventListener("click", () => openCard(d.slug, b.dataset.maybeCard));
  scry.hydrate(box);
  paint(box);
  const head = `${total}/100`;
  $("#b-count").textContent = head;
  $("#b-pane-count").textContent = `· ${total}`;
}

function renderBar(d) {
  d = deckBy(d.slug) || d;
  const bar = document.getElementById("b-bar");
  if (!bar) return;
  const n = draftCount(d);
  bar.hidden = !n;
  document.body.classList.toggle("has-build-bar", !!n);
  if (!n) { bar.innerHTML = ""; return; }
  bar.innerHTML = `<div class="build-bar-inner"><span class="main"><b>${plural(n, "Änderung", "Änderungen")}</b><small>auf diesem Gerät gemerkt</small></span>
    <button class="btn plain" type="button" id="b-discard">Verwerfen</button>
    <button class="btn primary" type="button" id="b-save">${icon("check", "sm")}Speichern</button></div>`;
  $("#b-save", bar).addEventListener("click", () => saveDraft(deckBy(d.slug) || d));
  $("#b-discard", bar).addEventListener("click", () => discard(deckBy(d.slug) || d));
}

// a card from the results or the maybe list: look at it (German text), with "Ins Deck" and "Vielleicht" at the bottom
function openCard(slug, name) {
  const d = deckBy(slug);
  if (!d) return;
  const ok = inColors(d, name) && !d.commanders.includes(name);
  const onMaybe = isMaybe(d, name);
  const inDeck = qtyOf(d, name) && !manyAllowed(name);
  cardSheet(name, ok ? {
    label: inDeck ? null : "Ins Deck",
    run: () => { closeSheet(); if (onMaybe) maybeToDeck(deckBy(slug), name); else addCard(deckBy(slug), name); },
    alt: onMaybe || qtyOf(d, name) ? null : { label: "Vielleicht", icon: "maybe", run: () => { closeSheet(); toMaybe(deckBy(slug), name); } },
  } : null);
}

// a card in the deck: category, quantity, take it out
function deckCardSheet(slug, name) {
  openSheet(({ close }) => {
    const d = deckBy(slug);
    const c = d && merged(d).find((x) => x.name === name);
    if (!c) return { title: name, body: "" };
    const info = scry.cached(name);
    return {
      title: name, left: "", right: `<button class="btn plain" type="button" data-sheet-close><b>Fertig</b></button>`,
      body: `<div class="b-card">
          <div class="card-image small">${info?.image ? `<img src="${esc(info.image)}" alt="${esc(name)}">` : ""}</div>
          <div class="b-card-side">
            <div class="tl">${esc(info?.type || "")} <span class="mana">${mana(info?.cost || "")}</span></div>
            ${manyAllowed(name) || c.qty > 1 ? `<div class="field-label">Anzahl</div>
              <div class="stepper"><button type="button" data-step="-1" aria-label="Eine weniger">−</button><output>${c.qty}</output><button type="button" data-step="1" aria-label="Eine mehr">+</button></div>` : ""}
            <button class="btn plain small" type="button" id="b-text">${icon("cards", "xs")}Kartentext lesen</button>
          </div></div>
        <div class="field-label">Kategorie</div>
        <div class="chips" id="b-cats">${CATS.map((k) => `<button class="chip" type="button" data-cat="${esc(k)}" aria-pressed="${c.category === k}">${esc(CAT_LABELS[k])}</button>`).join("")}</div>
        <div class="btn-col"><button class="btn" type="button" id="b-to-maybe">${icon("maybe", "sm")}Auf die Vielleicht-Liste</button>
          <button class="btn danger" type="button" id="b-remove">${icon("trash", "sm")}Aus dem Deck nehmen</button></div>`,
      bind(el) {
        for (const b of $$("[data-cat]", el)) b.addEventListener("click", () => { setCard(d, name, { category: b.dataset.cat }); redrawSheet(); });
        for (const b of $$("[data-step]", el)) b.addEventListener("click", () => { setCard(d, name, { qty: Math.max(0, Math.min(99, c.qty + Number(b.dataset.step))) }); redrawSheet(); });
        $("#b-remove", el).addEventListener("click", () => { setCard(d, name, { qty: 0 }); close(); });
        $("#b-to-maybe", el).addEventListener("click", () => { close(); toMaybe(d, name); });
        $("#b-text", el).addEventListener("click", () => { close(); setTimeout(() => cardSheet(name), 260); });
      },
    };
  });
}

// ---------- a new deck ---------------------------------------------------------------------------------------------

export const slugify = (name) => name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]+/g, "-").split("-").filter(Boolean).join("-").slice(0, 70) || "deck";

export function freeSlug(name) {
  const base = slugify(name);
  const taken = new Set(state.snap.decks.map((d) => d.slug));
  let slug = base, n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  return slug;
}

/** After "Deck anlegen": the deck exists at once (offline too); the builder opens with it. */
export function createDeck({ name, commanders, colors, bracket }) {
  const slug = freeSlug(name);
  op("deck.new", { deck: { slug, name, commanders, bracket, colors } });
  vibrate(18);
  location.hash = `#/bauen/${slug}`;
  if (!reducedMotion()) scrollTo({ top: 0 });
}
