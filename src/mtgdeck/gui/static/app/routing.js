"use strict";
// The desktop GUI, part 2 of 21: the state, the hash router and the sidebar's deck list.
// index.html loads the parts in order; they share one global scope.

let brackets = [];
let currentDeck = null;
let deckIndex = [];
const VIEWS = ["new", "deck", "collection", "sell", "orders", "glossary", "opponents", "tables", "blacklist", "settings", "about"];
const TABS = ["karten", "testen", "partien", "verlauf", "drucken"];
let lastView = null;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const view = VIEWS.includes(parts[0]) ? parts[0] : "new";
  return { view, slug: parts[1] || null, tab: parts[2] || null, bare: raw === "" };
}

function homeHash() {
  const slug = store.get("lastdeck");
  if (slug && deckIndex.some((d) => d.slug === slug)) return `#/deck/${enc(slug)}`;
  if (deckIndex[0]) return `#/deck/${enc(deckIndex[0].slug)}`;
  return "#/new";
}
for (const a of $$("a.brand")) a.addEventListener("click", (e) => { e.preventDefault(); go(homeHash()); });

function go(hash) {
  if (location.hash === hash) void route();
  else location.hash = hash;
}

async function route() {
  const r = parseHash();
  preview.hidden = true;
  if (r.bare) return go(homeHash());
  if (r.view === "deck" && !r.slug) return go(homeHash());
  if (r.view === "deck" && (!currentDeck || currentDeck.slug !== r.slug)) {
    if (!(await openDeck(r.slug))) return;
  }
  for (const v of $$(".view")) v.hidden = v.dataset.view !== r.view;
  if (r.view === "deck") selectTab(r.tab || "karten", false);
  if (r.view === "settings") { void showVersion(); void refreshDbStatus(); void refreshBackups(); void refreshSync({ quiet: true }); void refreshDesktop(); }
  if (r.view === "collection") void loadCollection();
  if (r.view === "sell") void showSell();
  if (r.view === "glossary") void showGlossary(r.slug);
  if (r.view === "about") void showAbout();
  if (r.view === "orders") void showOrders(r.slug);
  if (r.view === "tables") void showTables(r.slug);
  if (r.view === "opponents") void showOpponents(r.slug);
  placeJobPanel();
  setNavOpen(false);
  markNav(r);
  const key = r.view + (r.slug || "");
  if (key !== lastView) {
    window.scrollTo(0, 0);
    if (lastView !== null) $("#main").focus({ preventScroll: true });  // screen readers start at the new content
    lastView = key;
  }
  document.title = (r.view === "deck" && currentDeck ? currentDeck.name
    : { new: "Neues Deck", collection: "Meine Sammlung", sell: "Verkaufen", orders: "Sammelbestellungen", glossary: "Glossar", opponents: "Gegnerdecks", tables: "Tischregeln", blacklist: "Blacklist", settings: "Einstellungen", about: "Über Conclave" }[r.view]) + " · Conclave";
}
window.addEventListener("hashchange", route);

function markNav(r = parseHash()) {
  for (const a of $$("#deck-list a")) {
    if (r.view === "deck" && a.dataset.slug === r.slug) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  for (const a of $$(".nav-bottom a")) {
    if (a.dataset.nav === (r.view === "about" ? "settings" : r.view)) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (r.view === "new") $("#nav-new").setAttribute("aria-current", "page");
  else $("#nav-new").removeAttribute("aria-current");
}

// mobile: the sidebar becomes a drawer
function setNavOpen(open) {
  document.body.classList.toggle("nav-open", open);
  $("#scrim").hidden = !open;
  $("#nav-toggle").setAttribute("aria-expanded", String(open));
  $("#nav-toggle").setAttribute("aria-label", open ? "Menü schließen" : "Menü öffnen");
}
$("#nav-toggle").addEventListener("click", () => setNavOpen(!document.body.classList.contains("nav-open")));
$("#scrim").addEventListener("click", () => setNavOpen(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("nav-open")) setNavOpen(false); });

// ============================================================================================
// sidebar: saved decks
// ============================================================================================
async function refreshDeckList() {
  deckIndex = await api("/api/decks").catch(() => []);
  $("#deck-count").textContent = deckIndex.length || "";
  $("#deck-filter").hidden = deckIndex.length < 8;
  renderDeckList();
  await refreshTrash();
}

function renderDeckList() {
  const q = $("#deck-filter").value.trim().toLowerCase();
  const list = deckIndex.filter((d) => !q || `${d.name} ${d.commanders.join(" ")}`.toLowerCase().includes(q));
  const firstShelved = list.findIndex((d) => d.shelved);  // the backend lists pinned decks first, shelved ones last
  const sortable = !q;  // drag a deck into the pinned ones on top (or a pinned one out of them)
  $("#deck-list").innerHTML = list.length ? list.map((d, i) => `${i === firstShelved ? `<li class="deck-list-group" title="Karten daraus kannst du für andere Decks nehmen">Pausiert</li>` : ""}<li${d.shelved ? ' class="shelved"' : ""}${sortable && !d.shelved ? ` draggable="true" data-pin="${esc(d.slug)}" title="${d.pinned ? "Ziehen, um die Reihenfolge zu ändern" : "Nach oben ziehen, um es anzuheften"}"` : ""}>
      <a href="#/deck/${enc(d.slug)}" data-slug="${esc(d.slug)}">
        <span class="name">${d.valid === false ? '<span class="dot bad" title="nicht legal"></span><span class="sr-only">nicht legal:</span>' : ""}<span class="label">${esc(d.name)}</span>${d.pinned ? `<svg class="icon pin" aria-label="angeheftet"><title>Angeheftet</title><use href="#i-pin"/></svg>` : ""}</span>
        ${d.updated ? `<span class="meta">${esc(fmtDate(d.updated))}</span>` : ""}
      </a></li>`).join("")
    : `<li class="empty-inline">${deckIndex.length ? "Kein Treffer." : "Noch keine Decks – starte mit „Neues Deck“."}</li>`;
  markNav();
}

// pin a deck to the top of the list, or shelve it (not played at the moment: its cards may go into other decks)
async function setDeckFlag(d, key, on) {
  try {
    const r = await api(`/api/decks/${enc(d.slug)}/flags`, { method: "PUT", body: { [key]: on } });
    if (currentDeck?.slug === d.slug) { currentDeck.pinned = r.pinned; currentDeck.shelved = r.shelved; renderDeckFlags(currentDeck); }
    await refreshDeckList();
    const text = key === "pinned" ? (on ? "oben angeheftet" : "nicht mehr angeheftet") : on ? "pausiert – seine Karten sind für andere Decks frei" : "wird wieder gespielt";
    toast(`„${d.name}“ ${text}.`, "ok", 5000, { label: "Rückgängig", run: () => setDeckFlag(d, key, !on) });
  } catch (err) { fail(err); }
}

function renderDeckFlags(d) {
  const pin = $("#pin-btn");
  pin.setAttribute("aria-pressed", String(!!d.pinned));
  pin.title = d.pinned ? "Angeheftet – klicken zum Lösen" : "Oben anheften";
  pin.setAttribute("aria-label", d.pinned ? "Angeheftet, lösen" : "Oben anheften");
  $("#shelve-btn").textContent = d.shelved ? "Wieder spielen" : "Pausieren (gerade nicht gespielt)";
  $("#deck-shelved").hidden = !d.shelved;
  $("#view-deck").classList.toggle("is-shelved", !!d.shelved);
}
$("#pin-btn").addEventListener("click", () => currentDeck && setDeckFlag(currentDeck, "pinned", !currentDeck.pinned));
$("#shelve-btn").addEventListener("click", () => { $("#deck-menu").open = false; if (currentDeck) void setDeckFlag(currentDeck, "shelved", !currentDeck.shelved); });
$("#unshelve-btn").addEventListener("click", () => currentDeck && setDeckFlag(currentDeck, "shelved", false));
$("#deck-filter").addEventListener("input", renderDeckList);

// drag a deck among the pinned ones on top (it gets pinned there) or a pinned one below them (it gets unpinned)
let pinDrag = null;
const pinTarget = (e) => e.target.closest?.("#deck-list li[data-pin]");
const pinnedSlugs = () => deckIndex.filter((d) => d.pinned && !d.shelved).map((d) => d.slug);

// What dropping the dragged deck above or below `li` does: {order} = the pinned decks in their new order (the
// dragged one included), {unpin: true}, or null (no change, e.g. one unpinned deck onto another).
function pinDrop(li, below) {
  const pinned = pinnedSlugs();
  const target = li.dataset.pin;
  if (target === pinDrag) return null;
  const others = pinned.filter((s) => s !== pinDrag);
  let at = others.indexOf(target);
  if (at >= 0) at += below ? 1 : 0;
  else if (!below && target === deckIndex.find((d) => !d.pinned && !d.shelved)?.slug) at = others.length;  // just under the pinned ones
  else return pinned.includes(pinDrag) ? { unpin: true } : null;
  const order = [...others];
  order.splice(at, 0, pinDrag);
  return order.join() === pinned.join() ? null : { order };
}

$("#deck-list").addEventListener("dragstart", (e) => {
  const li = pinTarget(e);
  if (!li) return;
  pinDrag = li.dataset.pin;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/x-conclave-pin", pinDrag);
  li.classList.add("dragging");
});
$("#deck-list").addEventListener("dragover", (e) => {
  const li = pinTarget(e);
  if (!pinDrag || !li) return;
  const below = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
  const plan = pinDrop(li, below);
  if (plan) e.preventDefault();
  for (const x of $$("#deck-list li[data-pin]")) x.classList.toggle("drop-above", !!plan && x === li && !below), x.classList.toggle("drop-below", !!plan && x === li && below);
});
$("#deck-list").addEventListener("drop", async (e) => {
  const li = pinTarget(e);
  if (!pinDrag || !li) return;
  e.preventDefault();
  const dragged = deckIndex.find((d) => d.slug === pinDrag);
  const plan = pinDrop(li, li.classList.contains("drop-below"));
  if (!plan || !dragged) return;
  if (plan.unpin) return setDeckFlag(dragged, "pinned", false);
  const before = pinnedSlugs();
  if (!dragged.pinned) {
    try { await api(`/api/decks/${enc(dragged.slug)}/flags`, { method: "PUT", body: { pinned: true } }); }
    catch (err) { return fail(err); }
    dragged.pinned = true;
    if (currentDeck?.slug === dragged.slug) { currentDeck.pinned = true; renderDeckFlags(currentDeck); }
  }
  await setPinOrder(plan.order, before, before.includes(dragged.slug) ? null : dragged);
});
$("#deck-list").addEventListener("dragend", () => {
  pinDrag = null;
  for (const x of $$("#deck-list li")) x.classList.remove("dragging", "drop-above", "drop-below");
});

// `pinnedNow` = a deck the drag just pinned: "Rückgängig" unpins it again instead of reordering
async function setPinOrder(slugs, before, pinnedNow = null) {
  const pos = new Map(slugs.map((s, i) => [s, i]));
  deckIndex.forEach((d) => { if (pos.has(d.slug)) d.pin_rank = pos.get(d.slug); });
  const pinned = deckIndex.filter((d) => pos.has(d.slug)).sort((a, b) => pos.get(a.slug) - pos.get(b.slug));
  deckIndex = [...pinned, ...deckIndex.filter((d) => !pos.has(d.slug))];  // shown at once, the server agrees
  renderDeckList();
  try {
    await api("/api/decks/pin-order", { method: "PUT", body: { slugs } });
    if (pinnedNow) toast(`„${pinnedNow.name}“ oben angeheftet.`, "ok", 5000, { label: "Rückgängig", run: () => setDeckFlag(pinnedNow, "pinned", false) });
    else toast("Reihenfolge gespeichert.", "ok", 4000, { label: "Rückgängig", run: () => setPinOrder(before, slugs) });
  } catch (err) { fail(err); }
  await refreshDeckList();
}
