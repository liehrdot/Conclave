"use strict";

// ============================================================================================
// helpers
// ============================================================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = encodeURIComponent;

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error("Keine Verbindung zur App – läuft mtg-gui noch? Bitte neu starten und die Seite neu laden.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(errorText(res, data)), { status: res.status });
  return data;
}

// a readable German message for a failed request
function errorText(res, data) {
  const d = data?.detail;
  if (typeof d === "string" && d) return d;
  if (Array.isArray(d) && d.length) {  // pydantic: [{loc, msg}]
    return "Ungültige Eingabe: " + d.map((e) => `${(e.loc || []).filter((x) => x !== "body").join(".")} ${e.msg || ""}`.trim()).join("; ");
  }
  if (res.status >= 500) return `Interner Fehler (${res.status}) – Details stehen im Fenster, in dem mtg-gui läuft.`;
  if (res.status === 404) return "Nicht gefunden – vielleicht wurde es inzwischen gelöscht.";
  return `Anfrage fehlgeschlagen (${res.status})`;
}

// follow a job's events; onLost(text) when the job is gone (app restarted) – null while reconnecting
function jobStream(jobId, onEvent, onLost) {
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  es.onopen = () => onLost(false);
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      onLost("Die Verbindung zum Auftrag ist weg – vermutlich wurde die App neu gestartet. Bitte den Auftrag noch einmal starten.");
    } else onLost(null);  // the browser reconnects; the server resumes via Last-Event-ID
  };
  return es;
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const store = {  // per-browser conveniences only (view mode); failures are harmless
  get(k) { try { return localStorage.getItem("mtgdeck." + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("mtgdeck." + k, v); } catch { /* ignore */ } },
};

// German number format everywhere: 32,00 € · 3,8 · 1.234
const fmtNum = (v, suffix = "", digits = null) => {
  if (v === null || v === undefined || v === "" || Number.isNaN(Number(v))) return v === null || v === undefined || v === "" ? "–" : `${v}${suffix}`;
  const opts = digits === null ? { maximumFractionDigits: 2 } : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  return `${Number(v).toLocaleString("de-DE", opts)}${suffix}`;
};
const fmtPower = (v) => fmtNum(v, "", 1);
const CURRENCY_SIGNS = { eur: "€", usd: "$", "€": "€", "$": "$" };
const fmtPrice = (v, cur = "") => fmtNum(v, cur ? " " + (CURRENCY_SIGNS[String(cur).toLowerCase()] || cur) : "", 2);
const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.replace("T", " ").slice(0, 16) : d.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
};
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// non-blocking notifications (success, hints, errors)
function toast(text, kind = "info", ms = 4500, action = null) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === "error" ? "alert" : "check")}<span>${esc(text)}</span>`;
  if (action) {  // e.g. { label: "Rückgängig", run: () => … }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-action";
    b.textContent = action.label;
    b.addEventListener("click", () => { el.remove(); action.run(); });
    el.appendChild(b);
  }
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? ms + 3000 : ms);
  return el;
}
const fail = (err) => toast(err.message || String(err), "error");

// confirm / prompt as a proper dialog. Returns true (confirm), the entered text (prompt) or null.
function ask({ title, text = "", value = null, ok = "OK", danger = false }) {
  const dlg = $("#ask-dialog"), input = $("#ask-input");
  $("#ask-title").textContent = title;
  $("#ask-text").textContent = text;
  $("#ask-text").hidden = !text;
  input.hidden = value === null;
  input.value = value ?? "";
  $("#ask-ok").textContent = ok;
  $("#ask-ok").classList.toggle("danger-fill", danger);
  return new Promise((resolve) => {
    const done = (result) => { resolve(result); if (dlg.open) dlg.close(); };
    $("#ask-cancel").onclick = () => done(null);
    $("#ask-form").onsubmit = (e) => { e.preventDefault(); done(value === null ? true : input.value.trim() || null); };
    dlg.onclose = () => resolve(null);
    dlg.showModal();
    if (value !== null) { input.focus(); input.select(); } else $("#ask-ok").focus();
  });
}

// dialogs close on a click outside their box (Esc works natively)
for (const dlg of $$("dialog")) {
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
}

// ============================================================================================
// state + routing  (#/new · #/deck/<slug>/<tab> · #/blacklist · #/settings)
// ============================================================================================
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
  const sortable = !q && deckIndex.filter((d) => d.pinned && !d.shelved).length > 1;  // pinned decks: drag into your own order
  $("#deck-list").innerHTML = list.length ? list.map((d, i) => `${i === firstShelved ? `<li class="deck-list-group" title="Karten daraus kannst du für andere Decks nehmen">Pausiert</li>` : ""}<li${d.shelved ? ' class="shelved"' : ""}${sortable && d.pinned && !d.shelved ? ` draggable="true" data-pin="${esc(d.slug)}" title="Ziehen, um die Reihenfolge zu ändern"` : ""}>
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

// drag a pinned deck above or below another pinned one
let pinDrag = null;
const pinTarget = (e) => e.target.closest?.("#deck-list li[data-pin]");
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
  e.preventDefault();
  const below = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
  for (const x of $$("#deck-list li[data-pin]")) x.classList.toggle("drop-above", x === li && !below), x.classList.toggle("drop-below", x === li && below);
});
$("#deck-list").addEventListener("drop", async (e) => {
  const li = pinTarget(e);
  if (!pinDrag || !li) return;
  e.preventDefault();
  const before = deckIndex.filter((d) => d.pinned && !d.shelved).map((d) => d.slug);
  const slugs = before.filter((s) => s !== pinDrag);
  const at = slugs.indexOf(li.dataset.pin);
  if (at < 0) return;
  slugs.splice(li.classList.contains("drop-below") ? at + 1 : at, 0, pinDrag);
  if (slugs.join() !== before.join()) await setPinOrder(slugs, before);
});
$("#deck-list").addEventListener("dragend", () => {
  pinDrag = null;
  for (const x of $$("#deck-list li")) x.classList.remove("dragging", "drop-above", "drop-below");
});

async function setPinOrder(slugs, before) {
  const pos = new Map(slugs.map((s, i) => [s, i]));
  deckIndex.forEach((d) => { if (pos.has(d.slug)) d.pin_rank = pos.get(d.slug); });
  const pinned = deckIndex.filter((d) => pos.has(d.slug)).sort((a, b) => pos.get(a.slug) - pos.get(b.slug));
  deckIndex = [...pinned, ...deckIndex.filter((d) => !pos.has(d.slug))];  // shown at once, the server agrees
  renderDeckList();
  try {
    await api("/api/decks/pin-order", { method: "PUT", body: { slugs } });
    toast("Reihenfolge gespeichert.", "ok", 4000, { label: "Rückgängig", run: () => setPinOrder(before, slugs) });
  } catch (err) { fail(err); }
  await refreshDeckList();
}

// ============================================================================================
// new deck / commander finder
// ============================================================================================
const newForm = $("#new-form");

async function initBrackets() {
  brackets = await api("/api/brackets");
  $("#retune-brackets").innerHTML = brackets.map((b) => `
    <label title="${esc(b.summary)}"><input type="radio" name="rbracket" value="${b.number}">
    <span><b>${b.number}</b><small>${esc(b.name)}</small></span></label>`).join("");
}

newForm.addEventListener("submit", (e) => {  // Enter in the link or search field
  e.preventDefault();
  const im = $("#import-box").dataset.imode;
  if (im === "link") void loadImport({ url: $("#import-url").value });
  else if (im === "precon") void searchPrecons();
});

function wireAutocomplete(input, list, onPick) {
  input.addEventListener("input", debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return;
    try {
      const names = await api(`/api/autocomplete?q=${enc(q)}`);
      list.innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
    } catch { /* ignore */ }
  }, 200));
  input.addEventListener("change", () => onPick && onPick(input.value));
}

// ---------- import an existing deck: link, pasted list or starter deck ----------
let importData = null;
function setImportMode(mode) {
  $("#import-box").dataset.imode = mode;
  $(`#import-box [name=imode][value="${mode}"]`).checked = true;
  $("#import-msg").textContent = "";
  if (mode === "precon" && !preconItems) void searchPrecons();
}
$("#import-box").addEventListener("change", (e) => { if (e.target.name === "imode") setImportMode(e.target.value); });
$("#import-url-btn").addEventListener("click", () => loadImport({ url: $("#import-url").value }));
wireAutocomplete($("#manual-cmd"), $("#ac-manual"));
wireAutocomplete($("#manual-partner"), $("#ac-manual-p"));
$("#manual-btn").addEventListener("click", async () => {
  const commander = $("#manual-cmd").value.trim();
  if (commander.length < 2) { toast("Gib zuerst den Commander ein.", "error"); $("#manual-cmd").focus(); return; }
  const b = $("#manual-btn");
  b.disabled = true;
  b.textContent = "Lege an …";
  try {
    const r = await api("/api/decks/new", { method: "POST", body: { commander, partner: $("#manual-partner").value.trim() || null,
      name: $("#manual-name").value.trim(), bracket: Number($("#manual-bracket").value), currency: $("#new-currency").value } });
    await refreshDeckList();
    for (const id of ["#manual-cmd", "#manual-partner", "#manual-name"]) $(id).value = "";
    go(`#/deck/${enc(r.slug)}/karten`);
    for (let k = 0; k < 50 && currentDeck?.slug !== r.slug; k++) await new Promise((res) => setTimeout(res, 100));  // deck view loads
    if (currentDeck?.slug === r.slug && !edit) setEditing(true);
    toast("Deck angelegt – füge jetzt Karten hinzu.", "info", 6000);
  } catch (err) { fail(err); }
  finally { b.disabled = false; b.textContent = "Leeres Deck anlegen"; }
});
$("#import-text-btn").addEventListener("click", () => loadImport({ text: $("#import-text").value }));
$("#import-clip-btn").addEventListener("click", importFromClipboard);

// Reads a copied decklist (e.g. Moxfield „Export“ → „Copy for MTGA“) and checks it right away.
async function importFromClipboard() {
  let text = "";
  try { text = (await navigator.clipboard.readText()).trim(); }
  catch {
    toast("Die Zwischenablage ließ sich nicht lesen – füge die Liste mit Strg+V ein.", "error");
    $("#import-text").focus();
    return;
  }
  if (!text) { toast("Die Zwischenablage ist leer. Kopiere zuerst die Liste, z. B. in Moxfield mit „Copy for MTGA“.", "error"); return; }
  $("#import-text").value = text;
  void loadImport({ text });
}

async function loadImport(body) {
  if (body.url !== undefined && !body.url.trim()) { toast("Füge zuerst einen Link ein.", "error"); $("#import-url").focus(); return; }
  const mox = body.url?.match(/moxfield\.com\/decks\/([A-Za-z0-9_-]+)/i);
  if (mox && await moxfieldWindow()) return openMoxfield(mox[1]);
  const msg = $("#import-msg");
  msg.className = "small muted";
  msg.textContent = body.url ? "Lade das Deck …" : "Prüfe die Liste …";
  $("#import-preview").hidden = true;
  try {
    importData = await api("/api/import/preview", { method: "POST", body });
    msg.textContent = "";
    renderImportPreview(importData);
  } catch (err) {
    if (mox) return moxfieldFallback(mox[1]);
    msg.className = "small bad";
    msg.textContent = err.message;
  }
}

// Moxfield blocks programs (Cloudflare, HTTP 403), so a link usually fails: switch to „Liste einfügen“
// and show the two clicks that get the list out of Moxfield.
function moxfieldFallback(id) {
  setImportMode("text");
  const msg = $("#import-msg");
  msg.className = "small";
  msg.innerHTML = `Moxfield lässt keine Programme an seine Decks, darum geht es hier über die Liste:
    öffne das Deck, wähle „Export“ → „Copy for MTGA“ und klicke dann „Aus Zwischenablage einfügen“.
    <a href="https://moxfield.com/decks/${esc(id)}" target="_blank" rel="noopener">Deck in Moxfield öffnen</a>`;
  $("#import-text").focus();
}

// The desktop app opens moxfield.com links in its own window (desktop/src-tauri/src/moxfield.rs): you log in
// there, „In Conclave importieren“ on the deck page sends the deck the page loaded back to conclaveMoxfield().
async function moxfieldWindow() {
  try { desktopShell = (await api("/api/desktop")).shell; } catch { /* keep the last answer */ }
  return !!desktopShell?.features?.includes("moxfield");
}

function openMoxfield(id) {
  const msg = $("#import-msg");
  msg.className = "small muted";
  msg.textContent = "Moxfield öffnet sich in einem eigenen Fenster. Melde dich dort an, falls nötig, und klicke auf der Deckseite „In Conclave importieren“.";
  location.href = `https://moxfield.com/decks/${encodeURIComponent(id)}`;  // the shell catches this and opens its window
}

window.conclaveMoxfield = (d) => {
  const cards = Array.isArray(d?.cards) ? d.cards.filter((c) => Array.isArray(c) && typeof c[0] === "string") : [];
  const commanders = Array.isArray(d?.commanders) ? d.commanders.filter((c) => typeof c === "string") : [];
  if (!cards.length) { toast("Moxfield hat kein Deck geliefert.", "error"); return; }
  const lines = [...(commanders.length ? ["Commander", ...commanders.map((n) => `1 ${n}`), "", "Deck"] : []),
    ...cards.map(([n, q]) => `${Math.max(1, Number(q) || 1)} ${n}`)];
  if (parseHash().view !== "new") go("#/new");
  setImportMode("text");
  $("#import-text").value = lines.join("\n");
  void loadImport({ text: lines.join("\n"), name: typeof d.name === "string" ? d.name.slice(0, 120) : undefined });
};

// commander picker of the import preview: a filterable list of the legendary cards, those whose
// colours cover the whole deck first (a native <select> of 30+ names was unreadable)
let impPick = [];  // [commander, partner]
function cmdRowHtml(c) {
  const [cmd, partner] = impPick;
  const role = c.name === cmd ? "Commander" : c.name === partner ? "Partner" : "";
  const main = cmd && cmd !== c.name ? impCandidate(cmd) : null;
  const canPartner = main?.pairs && c.pairs && !role;
  const art = c.image ? c.image.replace("/normal/", "/art_crop/") : "";
  return `<div class="cmd-opt${role ? " picked" : ""}" data-name="${esc(c.name)}">
    <button type="button" class="cmd-main" role="option" aria-selected="${role === "Commander"}">
      ${art ? `<img src="${esc(art)}" alt="" loading="lazy">` : `<span class="cmd-noart"></span>`}
      <span class="cmd-text"><b>${esc(c.name)}</b><span class="muted small">${esc(c.type_line || "")}</span></span>
      <span class="cmd-ci">${(c.color_identity || []).map((x) => manaHtml(`{${x}}`)).join("") || manaHtml("{C}")}</span>
      ${role ? `<span class="cmd-role">${role}</span>` : ""}
    </button>
    ${canPartner ? `<button type="button" class="btn small cmd-partner" title="Als zweiten Commander (Partner, Background …) dazunehmen">+ Partner</button>` : ""}
  </div>`;
}
function impCandidate(name) { return importData?.commander_candidates.find((c) => c.name === name); }
function renderCmdList() {
  const list = $("#imp-cmd-list");
  if (!list || !importData) return;
  const q = ($("#imp-cmd-q")?.value || "").trim().toLowerCase();
  const all = importData.commander_candidates.filter((c) => !q || `${c.name} ${c.type_line || ""}`.toLowerCase().includes(q));
  const fit = all.filter((c) => c.fits), rest = all.filter((c) => !c.fits);
  const group = (title, items) => items.length ? `<p class="cmd-group">${title}</p>${items.map(cmdRowHtml).join("")}` : "";
  list.innerHTML = all.length ? (fit.length && rest.length
    ? group("Passen zu den Farben des Decks", fit) + group("Weitere legendäre Karten", rest)
    : all.map(cmdRowHtml).join(""))
    : `<p class="muted small cmd-empty">Keine Karte passt zu „${esc(q)}“.</p>`;
  const [cmd, partner] = impPick;
  $("#imp-cmd-chosen").innerHTML = cmd
    ? `Commander: <b>${esc(cmd)}</b>${partner ? ` + <b>${esc(partner)}</b>` : ""}`
    : `<span class="warn">Noch kein Commander gewählt</span>`;
  const src = impCandidate(cmd)?.image;
  $("#imp-cmd-img").hidden = !src;
  if (src) $("#imp-cmd-img").src = src;
}
function pickCommander(name, asPartner) {
  const [cmd, partner] = impPick;
  if (asPartner) impPick = [cmd, name];
  else if (name === cmd) impPick = partner ? [partner] : [];
  else if (name === partner) impPick = [cmd];
  else impPick = [name, ...(partner && impCandidate(name)?.pairs ? [partner] : [])];
  const nameField = $("#imp-name");
  if (nameField && !nameField.dataset.typed && impPick[0]) nameField.value = impPick[0];
  renderCmdList();
}

function renderImportPreview(d) {
  const box = $("#import-preview");
  const known = d.commanders.length > 0;
  impPick = known ? [] : [...d.suggested];
  const img = (known ? d.commander_images?.[d.commanders[0]] : null)
    || d.commander_candidates.find((c) => c.name === d.suggested[0])?.image;
  const count = d.card_count === 100 ? "100 Karten" : `<span class="warn">${d.card_count} Karten (Commander-Decks haben 100)</span>`;
  const n = d.commander_candidates.length;
  let cmd;
  if (known) cmd = `<p>Commander: <b>${d.commanders.map(esc).join(" + ")}</b></p>`;
  else if (n) {
    cmd = `<div class="field cmd-pick"><span>Commander</span>
      <p class="small cmd-chosen" id="imp-cmd-chosen" aria-live="polite"></p>
      ${n > 6 ? `<input type="search" id="imp-cmd-q" placeholder="${n} legendäre Karten durchsuchen …" autocomplete="off" aria-label="Commander suchen">` : ""}
      <div class="cmd-list" id="imp-cmd-list" role="listbox" aria-label="Commander wählen"></div></div>`;
  } else {
    cmd = `<label class="field"><span>Commander <span class="muted">(die Seite markiert ihn nicht)</span></span>
      <input id="imp-cmd-text" list="ac-imp-cmd" placeholder="Name des Commanders"><datalist id="ac-imp-cmd"></datalist></label>`;
  }
  box.innerHTML = `<img id="imp-cmd-img" src="${esc(img || "")}" alt=""${img ? "" : " hidden"}>
    <div class="grow">
      <label class="field"><span>Name</span><input id="imp-name" value="${esc(d.name || (d.commanders[0] || d.suggested[0] || "Importiertes Deck"))}" maxlength="120"></label>
      <p class="muted small">${esc(d.site)}${d.source ? ` · <a href="${esc(d.source)}" target="_blank" rel="noopener">Quelle</a>` : ""} · ${count}
        ${d.unresolved?.length ? `<br><span class="warn">Nicht erkannt: ${d.unresolved.slice(0, 8).map(esc).join(", ")}${d.unresolved.length > 8 ? " …" : ""}</span>` : ""}</p>
      ${cmd}
      <label class="field"><span>Bracket</span><select id="imp-bracket"><option value="">automatisch schätzen</option>
        ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n} – ${esc(brackets.find((b) => b.number === n)?.name || "")}</option>`).join("")}</select></label>
      <div><button type="button" class="btn primary" id="imp-save">Importieren &amp; prüfen</button></div>
    </div>`;
  box.hidden = false;
  if (d.name || known) $("#imp-name").dataset.typed = "1";  // a real deck name stays, a commander name follows the pick
  $("#imp-name").addEventListener("input", (e) => { e.target.dataset.typed = "1"; });
  if ($("#imp-cmd-text")) wireAutocomplete($("#imp-cmd-text"), $("#ac-imp-cmd"));
  if ($("#imp-cmd-list")) {
    renderCmdList();
    $("#imp-cmd-q")?.addEventListener("input", renderCmdList);
    $("#imp-cmd-q")?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); $("#imp-cmd-list .cmd-main")?.focus(); }
      if (e.key === "Enter") { e.preventDefault(); const first = $("#imp-cmd-list .cmd-opt"); if (first) pickCommander(first.dataset.name); }
    });
    $("#imp-cmd-list").addEventListener("click", (e) => {
      const row = e.target.closest(".cmd-opt");
      if (!row) return;
      const asPartner = !!e.target.closest(".cmd-partner");
      if (!asPartner && !e.target.closest(".cmd-main")) return;
      pickCommander(row.dataset.name, asPartner);
      $(`#imp-cmd-list .cmd-opt[data-name="${CSS.escape(row.dataset.name)}"] .cmd-main`)?.focus();
    });
    $("#imp-cmd-list").addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const rows = $$("#imp-cmd-list .cmd-main");
      const i = rows.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      if (e.key === "ArrowUp" && i === 0) $("#imp-cmd-q")?.focus();
      else rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].focus();
    });
  }
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("#import-preview").addEventListener("click", async (e) => {
  const b = e.target.closest("#imp-save");
  if (!b || !importData) return;
  const d = importData;
  const commanders = d.commanders.length ? d.commanders
    : $("#imp-cmd-text") ? [$("#imp-cmd-text").value.trim()].filter(Boolean)
    : impPick.filter(Boolean);
  if (!commanders.length) { toast("Wähle den Commander des Decks.", "error"); return; }
  const bracket = $("#imp-bracket").value;
  const body = { name: $("#imp-name").value.trim() || "Importiertes Deck", commanders, cards: d.cards, categories: d.categories,
    bracket: bracket ? Number(bracket) : null, currency: $("#new-currency").value, site: d.site, source: d.source || "" };
  b.disabled = true;
  b.textContent = "Importiere und prüfe …";
  try {
    const r = await api("/api/import", { method: "POST", body });
    await refreshDeckList();
    go(`#/deck/${enc(r.slug)}/karten`);
    toast(`Deck importiert (Bracket ${r.bracket}${bracket ? "" : ", geschätzt"}).${r.legal ? "" : " Die Prüfung hat Probleme gefunden – siehe rechts."}`, r.legal ? "info" : "error", 7000);
    importData = null;
    $("#import-preview").hidden = true;
    $("#import-url").value = "";
    $("#import-text").value = "";
  } catch (err) { b.disabled = false; b.textContent = "Importieren & prüfen"; fail(err); }
});

// ---------- starter deck (precon) import ----------
let preconItems = null;
async function searchPrecons() {
  const q = $("#precon-q").value.trim();
  $("#precon-msg").textContent = "Suche …";
  try {
    const items = await api(`/api/precons?q=${enc(q)}`);
    if ($("#precon-q").value.trim() !== q) return;
    preconItems = items;
    $("#precon-msg").textContent = items.length ? (q ? `${items.length} Treffer` : "Die neuesten Commander-Decks – oder oben suchen.") : "Kein Starterdeck gefunden.";
    $("#precon-list").innerHTML = items.map((p, i) => `<li><button type="button" data-i="${i}">
      <span>${esc(p.name)}</span><span class="muted small">${esc(p.code)} · ${esc(p.released.slice(0, 4))}</span></button></li>`).join("");
  } catch (err) { $("#precon-msg").textContent = err.message; $("#precon-list").innerHTML = ""; }
}
$("#precon-q").addEventListener("input", debounce(searchPrecons, 300));
$("#precon-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-i]");
  if (!b) return;
  const item = preconItems[Number(b.dataset.i)];
  const box = $("#precon-pick");
  box.hidden = false;
  box.innerHTML = `<p class="muted small">Lade ${esc(item.name)} …</p>`;
  try {
    const p = await api(`/api/precons/${enc(item.file)}`);
    const img = p.commander_images?.[p.commanders[0]];
    box.innerHTML = `${img ? `<img src="${esc(img)}" alt="${esc(p.commanders[0])}">` : ""}
      <div><h3>${esc(p.name)}</h3>
        <p class="muted small">${esc(p.code)} · ${esc(p.released)} · ${p.card_count} Karten</p>
        <p>Commander: <b>${p.commanders.map(esc).join(" + ")}</b></p>
        <button type="button" class="btn primary" id="precon-import" data-file="${esc(p.file)}">Importieren &amp; prüfen</button></div>`;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) { box.innerHTML = `<p class="bad small">${esc(err.message)}</p>`; }
});
$("#precon-pick").addEventListener("click", async (e) => {
  const b = e.target.closest("#precon-import");
  if (!b) return;
  b.disabled = true;
  b.textContent = "Importiere und prüfe …";
  try {
    const r = await api("/api/precons/import", { method: "POST", body: { file: b.dataset.file, currency: $("#new-currency").value } });
    await refreshDeckList();
    go(`#/deck/${enc(r.slug)}/karten`);
    toast("Starterdeck importiert.", "info", 6000);
  } catch (err) { b.disabled = false; b.textContent = "Importieren & prüfen"; fail(err); }
});

// ---------- power profile (sub-tier, house rules, style) ----------
const TIER_LABELS = { low: "unteres", mid: "mittleres", high: "oberes" };
const TIER_ORDER = ["low", "mid", "high"];
const TIER_CENTER = { low: 0.17, mid: 0.5, high: 0.83 };

$$(".profile-fields").forEach((el) => el.appendChild($("#profile-template").content.cloneNode(true)));

function readProfile(root) {
  const q = (n) => root.querySelector(`[name="${n}"]`);
  const num = (n) => (q(n).value === "" ? null : Number(q(n).value));
  const p = {
    tier: root.querySelector('[name="tier"]:checked')?.value || null,
    max_game_changers: num("max_game_changers"),
    max_tutors: num("max_tutors"),
    allow_two_card_combos: q("no_combos").checked ? false : null,
    allow_extra_turns: q("no_extra_turns").checked ? false : null,
    allow_mass_land_denial: q("no_mld").checked ? false : null,
    style: q("style").value.trim(),
  };
  return Object.values(p).some((v) => v !== null && v !== "") ? p : null;
}

function setProfile(root, p = {}) {
  p = p || {};
  const q = (n) => root.querySelector(`[name="${n}"]`);
  root.querySelector(`[name="tier"][value="${p.tier || ""}"]`).checked = true;
  q("max_game_changers").value = p.max_game_changers ?? "";
  q("max_tutors").value = p.max_tutors ?? "";
  q("no_combos").checked = p.allow_two_card_combos === false;
  q("no_extra_turns").checked = p.allow_extra_turns === false;
  q("no_mld").checked = p.allow_mass_land_denial === false;
  q("style").value = p.style || "";
}

function levelText(bracket, tier) {
  return tier ? `${TIER_LABELS[tier]} Bracket ${bracket}` : `Bracket ${bracket}`;
}

// ============================================================================================
// jobs: one print or MPC Autofill run at a time, streamed via SSE
// ============================================================================================
let currentJob = null;   // id of the running job
let jobInfo = null;      // { id, kind, slot, route, slug, title, started, error, dismissed }
let eventSource = null;
let elapsedTimer = null;

function startJob(jobId, title, { kind, slot, route: home, slug = null }) {
  currentJob = jobId;
  jobInfo = { id: jobId, kind, slot, route: home, slug, title, started: Date.now(), error: null, dismissed: false };
  const panel = $("#job");
  panel.classList.remove("finished", "failed");
  $("#job-title").textContent = title;
  setJobStatus("Starte …");
  $("#log").innerHTML = "";
  $("#progress").hidden = true;
  $("#console-form").hidden = true;
  $("#job-details").open = false;
  $("#cancel-btn").textContent = "Abbrechen";
  resetTerminal();
  placeJobPanel();
  setBusy(true);
  tickElapsed();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(tickElapsed, 1000);
  if (eventSource) eventSource.close();
  eventSource = jobStream(jobId, handleEvent, (lost) => {
    if (currentJob !== jobId) return;
    if (lost) { handleEvent({ type: "error", text: lost }); handleEvent({ type: "done", ok: false }); }
    else if (lost === null) setJobStatus("Verbindung unterbrochen – verbinde neu …");
  });
}

// the job panel lives in the slot of the view that started it (deck print tab, order page, settings)
function placeJobPanel() {
  const panel = $("#job");
  const visible = jobInfo && !jobInfo.dismissed && (!jobInfo.slug || (currentDeck && currentDeck.slug === jobInfo.slug)
    || (parseHash().view === "orders" && currentOrder?.slug === jobInfo.slug));
  if (visible) { $(jobInfo.slot).appendChild(panel); panel.hidden = false; }
  else { document.body.appendChild(panel); panel.hidden = true; }
  for (const ind of [$("#job-indicator"), $("#job-indicator-top")]) {
    ind.hidden = !currentJob;
    if (currentJob) { ind.href = jobInfo.route; ind.title = jobInfo.title; }
  }
  if (currentJob) $("#job-indicator-text").textContent = jobInfo.title;
}

function setJobStatus(text) { $("#job-status").textContent = text; }

function tickElapsed() {
  if (!jobInfo) return;
  const s = Math.round((Date.now() - jobInfo.started) / 1000);
  $("#job-elapsed").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function setBusy(busy) {
  for (const sel of ["#prepare-btn", "#mpc-btn"]) {
    const b = $(sel);
    b.disabled = busy;
    b.title = busy ? "Es läuft gerade ein Auftrag" : "";
  }
}

function logLine(cls, text) {
  const log = $("#log");
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function handleEvent(ev) {
  switch (ev.type) {
    case "text": logLine("text", ev.text); setJobStatus(ev.text); break;
    case "status": logLine("tool", ev.text); setJobStatus(ev.text); break;
    case "error": logLine("error", "Fehler: " + ev.text); if (jobInfo) jobInfo.error = ev.text; break;
    case "result": logLine("result", ev.text); break;
    case "progress": {
      const bar = $("#progress");
      bar.hidden = false;
      bar.querySelector("div").style.width = `${(ev.done / Math.max(ev.total, 1)) * 100}%`;
      bar.querySelector("span").textContent = `${ev.done} / ${ev.total} · ${ev.text || ""}`;
      setJobStatus(`Bild ${ev.done} von ${ev.total}`);
      break;
    }
    case "print": void onPrepared(ev.result); break;
    case "console":
      if (ev.running) { openTerminal(); setJobStatus("MPC Autofill läuft – bediene es im Terminal."); }
      else if (term) term.options.disableStdin = true;
      break;
    case "term":
      if (term) term.write(ev.data);
      else logLine("text", ev.data.replace(ANSI_RE, "").trimEnd());
      break;
    case "done": void finishJob(ev); break;
  }
}

async function finishJob(ev) {
  eventSource.close();
  clearInterval(elapsedTimer);
  const info = jobInfo;
  currentJob = null;
  setBusy(false);
  $("#job").classList.add(ev.ok ? "finished" : "failed");
  $("#cancel-btn").textContent = "Schließen";
  if (!ev.ok) {
    setJobStatus(info.error || "Beendet, ohne Ergebnis. Details unten.");
    placeJobPanel();
    return;
  }
  switch (info.kind) {
    case "print":
      info.dismissed = true;
      toast("Druckdateien sind fertig.");
      break;
    default:  // autofill: keep the terminal output visible until closed
      setJobStatus("MPC Autofill ist beendet.");
  }
  placeJobPanel();
}

$("#cancel-btn").addEventListener("click", async () => {
  if (currentJob) {
    await api(`/api/jobs/${currentJob}/cancel`, { method: "POST" }).catch(() => {});
    return;
  }
  if (jobInfo) jobInfo.dismissed = true;
  placeJobPanel();
});

// ============================================================================================
// deck view
// ============================================================================================
let printLoadedFor = null;

async function openDeck(slug) {
  let d;
  try { d = await api(`/api/decks/${enc(slug)}`); }
  catch (err) { toast(`Deck „${slug}“ nicht gefunden.`, "error"); go("#/new"); return false; }
  if (edit && edit.slug !== d.slug) {
    if (editChanges()) toast("Ungespeicherte Kartenänderungen wurden verworfen.", "error");
    edit = null;
    $("#edit-toggle").setAttribute("aria-pressed", "false");
    $("#edit-toggle span").textContent = "Bearbeiten";
    $("#add-card-form").hidden = true;
  }
  currentDeck = d;
  store.set("lastdeck", d.slug);
  if (ownership && ownership.slug !== d.slug) ownership = null;
  printLoadedFor = null;
  rule0For = null;
  renderDeckHead(d);
  renderDeckTable(d);
  renderValidation(d.validation);
  renderHealth(d);
  renderStats(d.validation?.stats, d.validation);
  renderCards(d);
  $("#retune-form").querySelector(`[name="rbracket"][value="${d.bracket || 3}"]`).checked = true;
  setProfile($("#retune-form .profile-fields"), d.power_profile);
  renderPower(d);
  renderSpeed(d);
  void renderHistory(d);
  renderSheetTitle(d);
  void loadGames(d);
  void loadOwnership(d);
  void loadTokens(d);
  resetHand();
  renderOdds(d);
  $("#deck-menu").open = false;
  return true;
}

function deckFacts(d) {
  const v = d.validation || {};
  const cur = (d.currency || "eur").toUpperCase();
  const bits = [];
  const val = deckValue(d);
  if (d.proxy) bits.push("Proxy");
  else if (val) bits.push(`Wert ${fmtPrice(val.total, cur)}${d.budget ? ` / ${fmtPrice(d.budget, cur)}` : ""}`);
  else if (v.price_total != null) bits.push(`${fmtPrice(v.price_total, cur)}${d.budget ? ` / ${fmtPrice(d.budget, cur)}` : ""}`);
  if (d.speed) bits.push(`Tempo: ${d.speed.label}`);
  if (d.version) bits.push(`v${d.version}`);
  if (d.power_profile?.style) bits.push(d.power_profile.style);
  return bits.filter(Boolean).join(" · ");
}

// One sentence for the head, the check and the sticky line. Table-rule card names stay at the select.
function deckVerdict(d) {
  const v = d?.validation;
  if (!v) return { text: "Noch nicht geprüft", cls: "" };
  const br = v.bracket || {};
  const goal = br.target_text || levelText(d.bracket ?? "?", d.power_profile?.tier);
  let text, cls = "";
  if (v.legal === false) { text = "Nicht legal"; cls = "bad"; }
  else if (br.compliant === false) { text = "Legal, Ziel verfehlt"; cls = "warn"; }
  else text = `Legal, passt zu ${goal}`;
  const table = v.table_rule;
  if (table && table.compliant === false && table.name) {
    text += ` · Tischregel „${table.name}“ verletzt`;
    cls = "bad";
  }
  return { text, cls };
}

// Legal and on bracket: a green check and the bracket number. Otherwise the verdict sentence stays.
function deckFits(d) {
  const v = d?.validation;
  if (!v || v.legal !== true || d.bracket == null) return false;
  if ((v.bracket || {}).compliant === false) return false;
  const table = v.table_rule;
  return !(table && table.compliant === false);
}

function deckMark(bracket) {
  const label = `Legal, Bracket ${bracket}`;
  return `<span class="deck-mark" title="${esc(label)}">${icon("check")}<span class="num">${esc(bracket)}</span><span class="sr-only">${esc(label)}</span></span>`;
}

function renderDeckHead(d) {
  const fits = deckFits(d);
  $("#deck-name").innerHTML = `${esc(d.name)}${fits ? deckMark(d.bracket) : ""}`;
  const thumb = shownCopy(d.commanders[0])?.image || d.card_data?.[d.commanders[0]]?.image;
  $("#deck-thumb").hidden = !thumb;
  if (thumb) $("#deck-thumb").src = thumb;
  $("#deck-commanders").textContent = d.commanders.join(" + ");
  $("#deck-facts").textContent = deckFacts(d);
  $("#deck-facts").title = deckValueTip(d);
  const verdict = deckVerdict(d);
  const line = $("#deck-verdict");
  line.hidden = fits;
  line.textContent = fits ? "" : verdict.text;
  line.className = `verdict${verdict.cls ? ` ${verdict.cls}` : ""}`;
  const desc = (d.description || "").startsWith("Vorgefertigtes Commander-Deck") ? "" : (d.description || "");
  $("#deck-desc").textContent = desc;
  $("#deck-desc").hidden = !desc;
  const against = d.built_against_info || [];
  $("#deck-against").hidden = !against.length;
  $("#deck-against").innerHTML = against.length ? `${icon("swords")} Gebaut gegen ${against.map((o) => `<a href="#/opponents/${enc(o.id)}">${esc(o.title)}</a>`).join(", ")}` : "";
  $("#export-txt").href = `/api/decks/${enc(d.slug)}/export/text`;
  renderDeckFlags(d);
  renderDeckStatus(d);
}

function renderDeckStatus(d) {
  const verdict = deckVerdict(d);
  $("#deck-status-text").textContent = `${verdict.text} · Zum Deck-Check`;
  $("#deck-status").classList.toggle("bad", verdict.cls === "bad");
  $("#deck-status").classList.toggle("warn", verdict.cls === "warn");
}
$("#deck-status").addEventListener("click", () => $("#check-panel").scrollIntoView({ behavior: "smooth", block: "start" }));

// tabs (WAI-ARIA APG pattern: arrow keys move between tabs)
function selectTab(tab, updateHash = true, focus = false) {
  const legacy = tab === "anpassen" ? "target" : tab === "anleitung" ? "rule0" : null;
  if (!TABS.includes(tab)) tab = "karten";
  for (const t of $$("#deck-tabs [role=tab]")) {
    const on = t.dataset.tab === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  }
  for (const p of $$("#view-deck [role=tabpanel]")) p.hidden = p.id !== `panel-${tab}`;
  if ((updateHash || legacy) && currentDeck) history.replaceState(null, "", `#/deck/${enc(currentDeck.slug)}/${tab}`);
  if (tab === "drucken") mountPrintStudio("#panel-drucken");
  if (tab === "drucken" && currentDeck && printLoadedFor !== currentDeck.slug) {
    printLoadedFor = currentDeck.slug;
    void loadPlan();
  }
  if (legacy === "target") requestAnimationFrame(() => $("#deck-target").scrollIntoView({ behavior: "smooth", block: "start" }));
  if (legacy === "rule0") void openRule0();
}
$("#deck-tabs").addEventListener("click", (e) => {
  const t = e.target.closest("[role=tab]");
  if (t) selectTab(t.dataset.tab);
});
$("#deck-tabs").addEventListener("keydown", (e) => {
  const i = TABS.indexOf(document.activeElement?.dataset?.tab);
  if (i < 0) return;
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectTab(TABS[(next + TABS.length) % TABS.length], true, true);
});

// overflow menu: closes on outside click, item click and Esc
document.addEventListener("click", (e) => {
  for (const m of $$("details.menu[open]")) if (!m.contains(e.target)) m.open = false;
});
$("#deck-menu").addEventListener("click", (e) => { if (e.target.closest(".menu-list button, .menu-list a")) $("#deck-menu").open = false; });
$("#deck-menu").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("#deck-menu").open = false; $("#deck-menu summary").focus(); }
});

function renderValidation(v) {
  const box = $("#validation");
  if (!v) { box.innerHTML = '<p class="muted">Noch nicht geprüft – „⋯ → Neu prüfen“.</p>'; return; }
  const br = v.bracket || {};
  const table = v.table_rule || {};
  const skip = new Set([...(table.violations || []), ...(table.warnings || [])]);
  const issues = [...(v.errors || []).map((t) => ["bad", t]), ...(br.violations || []).map((t) => ["warn", t]), ...(v.warnings || []).map((t) => ["warn", t])]
    .filter(([, t]) => !skip.has(t));
  const li = ([cls, t]) => `<li class="${cls}">${esc(t)}</li>`;
  const shown = issues.slice(0, 4), rest = issues.slice(4);
  const list = (items) => (items.length ? `<ul class="issues">${items.map(li).join("")}</ul>` : "");
  const kv = (label, items) => `<dt>${label}</dt><dd>${esc(items.length ? items.join(", ") : "–")}</dd>`;
  const verdict = deckVerdict(currentDeck);
  box.innerHTML = `
    <p class="verdict${verdict.cls ? ` ${verdict.cls}` : ""}">${esc(verdict.text)}</p>
    ${br.estimated ? `<p class="muted small">Commander Spellbook schätzt Bracket ${esc(br.estimated)}.</p>` : ""}
    ${list(shown)}
    ${rest.length ? `<details class="more"><summary>${rest.length} weitere Hinweise</summary>${list(rest)}</details>` : ""}
    <details class="more"><summary>Bracket-Details</summary>
      <dl class="kv">
        ${kv("Game Changer", br.game_changers || [])}
        ${kv("2-Karten-Combos", (br.two_card_combos || []).map((c) => c.cards.join(" + ")))}
        ${kv("Extra-Züge", br.extra_turns || [])}
        ${kv("Massen-Landzerstörung", br.mass_land_denial || [])}
        ${kv("Tutoren", br.tutors || [])}
      </dl>
    </details>`;
}

const ROLE_LABELS = { ramp: "Ramp", card_draw: "Kartenzug", removal: "Removal", board_wipe: "Board Wipes",
  tutor: "Tutoren", extra_turn: "Extra-Züge", counterspell: "Counter", protection: "Schutz" };

function renderStats(s, v = {}) {
  const box = $("#stats");
  if (!s) { box.innerHTML = '<p class="muted">Keine Statistik.</p>'; return; }
  const curve = s.mana_curve || {};
  const max = Math.max(1, ...Object.values(curve));
  const keys = ["0", "1", "2", "3", "4", "5", "6", "7+"];
  const priceKey = Object.keys(s).find((k) => k.startsWith("total_price_"));
  const cur = priceKey ? priceKey.replace("total_price_", "").toUpperCase() : "";
  box.innerHTML = `
    <div class="curve" role="img" aria-label="Manakurve: ${keys.map((k) => `${k}: ${curve[k] || 0}`).join(", ")}">
      ${keys.map((k) => `<div><span>${curve[k] || 0}</span><div class="bar" style="height:${((curve[k] || 0) / max) * 78}%"></div><span>${k}</span></div>`).join("")}</div>
    <dl class="kv">
      <dt>Karten</dt><dd>${s.card_count}</dd>
      <dt>Ø Manawert</dt><dd>${s.avg_cmc_nonland}</dd>
      ${s.total_mana_value != null ? `<dt>Gesamt-Manawert</dt><dd>${fmtNum(s.total_mana_value)}</dd>` : ""}
      <dt>Typen</dt><dd>${esc(Object.entries(s.types || {}).map(([k, n]) => `${k} ${n}`).join(" · "))}</dd>
      <dt>Rollen</dt><dd>${esc(Object.entries(s.role_counts || {}).map(([k, n]) => `${ROLE_LABELS[k] || k} ${n}`).join(" · "))}</dd>
      <dt>Preis</dt><dd>${priceKey ? `${esc(v.price_total ?? s[priceKey])} ${cur}` : "–"}${v.proxy ? " · Proxy" : v.budget ? ` <span class="muted">/ Budget ${esc(v.budget)}</span>` : ""}</dd>
    </dl>`;
}

// ---------- card list: grouped + sorted, as text list or image grid, with an edit mode ----------
let cardView = store.get("cardview") === "grid" ? "grid" : "list";
let cardGroup = store.get("cardgroup") || "category";
let cardSort = store.get("cardsort") || "name";
document.querySelector(`[name="cardview"][value="${cardView}"]`).checked = true;
$("#card-group").value = cardGroup;
$("#card-sort").value = cardSort;
$$('[name="cardview"]').forEach((r) => r.addEventListener("change", () => {
  cardView = r.value;
  store.set("cardview", cardView);
  if (currentDeck) renderCards(currentDeck);
}));
$("#card-group").addEventListener("change", (e) => { cardGroup = e.target.value; store.set("cardgroup", cardGroup); renderCards(currentDeck); });
$("#card-sort").addEventListener("change", (e) => { cardSort = e.target.value; store.set("cardsort", cardSort); renderCards(currentDeck); });

const CATEGORY_ORDER = ["Commander", "Ramp", "Draw", "Removal", "Board Wipe", "Protection", "Synergy", "Win Condition", "Utility", "Land"];
// stored category values stay English (skill contract, references/deck-template.md); the GUI shows German names
const CATEGORY_LABELS = { Draw: "Kartenzug", "Board Wipe": "Board Wipes", Protection: "Schutz", Synergy: "Synergie",
  "Win Condition": "Siegbedingung", Utility: "Sonstiges", Land: "Länder", Tutor: "Tutoren", Counterspell: "Counterspells" };
const catLabel = (c) => CATEGORY_LABELS[c] || c;
const TYPE_ORDER = ["Commander", "Creature", "Planeswalker", "Battle", "Artifact", "Enchantment", "Instant", "Sorcery", "Land", "Sonstiges"];
const TYPE_LABELS = { Creature: "Kreaturen", Planeswalker: "Planeswalker", Battle: "Schlachten", Artifact: "Artefakte",
  Enchantment: "Verzauberungen", Instant: "Spontanzauber", Sorcery: "Hexereien", Land: "Länder", Sonstiges: "Sonstiges" };
const COLOR_GROUPS = { W: "Weiß", U: "Blau", B: "Schwarz", R: "Rot", G: "Grün" };

function typeOf(cd) {
  const t = (cd?.type_line || "").split("//")[0];
  for (const k of ["Land", "Creature", "Planeswalker", "Battle", "Artifact", "Enchantment", "Instant", "Sorcery"]) if (t.includes(k)) return k;
  return "Sonstiges";
}
const priceOf = (cd, d) => Number(cd?.[d.currency === "usd" ? "price_usd" : "price_eur"]) || 0;

function groupOf(c, cd) {
  if (c.commander) return "Commander";
  switch (cardGroup) {
    case "type": return TYPE_LABELS[typeOf(cd)];
    case "cmc": return typeOf(cd) === "Land" ? "Länder" : `Manawert ${cd?.cmc >= 7 ? "7+" : Math.round(cd?.cmc || 0)}`;
    case "color": {
      if (typeOf(cd) === "Land") return "Länder";
      const ci = cd?.color_identity || [];
      return ci.length === 0 ? "Farblos" : ci.length > 1 ? "Mehrfarbig" : COLOR_GROUPS[ci[0]];
    }
    case "owned": return ownershipLabel(c.name);
    default: return c.category ? catLabel(c.category) : TYPE_LABELS[typeOf(cd)] || "Sonstiges";
  }
}

function groupRank(g) {
  const order = cardGroup === "type" ? TYPE_ORDER.map((t) => TYPE_LABELS[t] || t)
    : cardGroup === "color" ? ["Commander", "Weiß", "Blau", "Schwarz", "Rot", "Grün", "Mehrfarbig", "Farblos", "Länder"]
    : cardGroup === "owned" ? ["Commander", ...OWNED_ORDER]
    : CATEGORY_ORDER.map(catLabel);
  const i = order.indexOf(g);
  if (cardGroup === "cmc" && g.startsWith("Manawert")) return 1 + (g.endsWith("7+") ? 7 : Number(g.split(" ")[1]));
  if (cardGroup === "cmc") return g === "Commander" ? 0 : 99;
  return i < 0 ? 50 : i;
}

// pending edits (saved together as one new version)
// { slug, add: Map(name -> {qty, category, data}), qty: Map(name -> qty), remove: Set, cat: Map(name -> category),
//   maybeAdd: Map(name -> {category, data, fromDeck}), maybeRemove: Set } – the maybe list never counts towards the deck
let edit = null;
const movedToMaybe = (name) => !!edit?.maybeAdd.get(name)?.fromDeck;
const editChanges = () => edit ? edit.add.size + edit.qty.size + [...edit.remove].filter((n) => !movedToMaybe(n)).length + edit.cat.size
  + edit.maybeAdd.size + edit.maybeRemove.size : 0;

function deckRows(d) {
  const rows = d.commanders.map((n) => ({ name: n, qty: 1, commander: true, cd: d.card_data?.[n] || {} }));
  for (const c of d.cards) {
    if (movedToMaybe(c.name)) continue;  // shown on the maybe list
    const row = { ...c, cd: d.card_data?.[c.name] || {} };
    if (edit) {
      if (edit.remove.has(c.name)) row.status = "removed";
      else if (edit.qty.has(c.name)) { row.qty = edit.qty.get(c.name); row.status = "changed"; }
      if (edit.cat.has(c.name)) { row.category = edit.cat.get(c.name); row.status ||= "changed"; }
    }
    rows.push(row);
  }
  if (edit) for (const [name, a] of edit.add) rows.push({ name, qty: a.qty, category: a.category || "", cd: a.data || {}, status: "new" });
  return rows;
}

// the maybe list ("Vielleicht"): saved entries (minus the ones going into the deck) plus pending ones
function maybeRows(d) {
  const rows = (d.maybe || []).filter((m) => !edit?.add.has(m.name))
    .map((m) => ({ ...m, cd: d.card_data?.[m.name] || {}, status: edit?.maybeRemove.has(m.name) ? "removed" : "" }));
  if (edit) for (const [name, m] of edit.maybeAdd) rows.push({ name, category: m.category || "", cd: m.data || {}, status: m.fromDeck ? "moved" : "new" });
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function maybeHtml(d, grid, editing) {
  const rows = maybeRows(d);
  if (!rows.length && !editing) return "";
  const live = rows.filter((r) => r.status !== "removed").length;
  const html = rows.map((c) => {
    const cd = c.cd;
    const data = `data-img="${esc(cd.image || "")}" data-img-back="${esc(cd.image_back || "")}" data-name="${esc(c.name)}" data-maybe="1"`;
    if (grid) {
      return `<div class="card" role="button" tabindex="0" ${data} aria-label="${esc(c.name)} – große Ansicht">
        ${cd.image ? `<img src="${esc(cd.image)}" alt="" loading="lazy">` : `<div class="noimg">${esc(c.name)}</div>`}</div>`;
    }
    const name = `${esc(c.name)}${cd.game_changer ? '<span class="gc" title="Game Changer">GC</span>' : ""}`;
    const ci = d.validation?.color_identity;
    const off = typeof ci === "string" && (cd.color_identity || []).some((x) => !ci.includes(x));
    const cat = off ? `<span class="maybe-cat bad" title="Passt nicht zur Farbidentität deines Commanders">nicht in deinen Farben</span>`
      : c.category ? `<span class="maybe-cat">${esc(catLabel(c.category))}</span>` : "";
    if (!editing) {
      return `<div class="card" role="button" tabindex="0" ${data} aria-label="${esc(c.name)} – große Ansicht"><span>${name}</span>${cat}</div>`;
    }
    if (c.status === "removed") {
      return `<div class="card removed" ${data}><span class="card-name"><s>${esc(c.name)}</s></span>
        <span class="edit-ctrls"><button type="button" class="mini" data-act="undo-maybe" title="Rückgängig">↶ zurück</button></span></div>`;
    }
    const tag = c.status === "new" ? ' <span class="tag-new">neu</span>' : c.status === "moved" ? ' <span class="tag-new moved">aus dem Deck</span>' : "";
    return `<div class="card ${c.status === "new" ? "new" : c.status === "moved" ? "changed" : ""}" ${data}>
      <button type="button" class="card-name" data-act="view">${name}${tag}</button>
      <span class="edit-ctrls">${cat}
        <button type="button" class="mini to-deck" data-act="to-deck" title="Ins Deck nehmen">${icon("plus")}Ins Deck</button>
        <button type="button" class="mini danger" data-act="unmaybe" title="Von der Liste nehmen" aria-label="${esc(c.name)} von der Vielleicht-Liste nehmen">✕</button>
      </span></div>`;
  }).join("");
  const empty = `<p class="maybe-empty">Karten, bei denen du noch unsicher bist. Klick bei einer Karte auf ${icon("maybe")} oder zieh sie von Scryfall auf „Vielleicht“.</p>`;
  return `<section class="group maybe-group"><h3>${icon("maybe")}Vielleicht <span class="count">${live}</span><span class="maybe-note">zählt nicht zum Deck</span></h3>
    ${rows.length ? (grid ? `<div class="group-cards">${html}</div>` : html) : empty}</section>`;
}

function renderCards(d) {
  if (!d) return;
  const editing = !!edit;
  const grid = cardView === "grid" && !editing;
  const rows = deckRows(d);
  const groups = {};
  for (const r of rows) (groups[groupOf(r, r.cd)] ||= []).push(r);
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name),
    cmc: (a, b) => (a.cd.cmc || 0) - (b.cd.cmc || 0) || a.name.localeCompare(b.name),
    price: (a, b) => priceOf(b.cd, d) - priceOf(a.cd, d) || a.name.localeCompare(b.name),
  }[cardSort] || ((a, b) => a.name.localeCompare(b.name));
  const live = rows.filter((r) => r.status !== "removed");
  const total = live.reduce((a, r) => a + (r.qty || 1), 0);
  $("#card-total").textContent = total;
  $("#card-total").classList.toggle("bad", editing && total !== 100);
  $("#cards").classList.toggle("grid", grid);
  $("#cards").classList.toggle("editing", editing);
  const catOptions = (sel) => ["", ...CATEGORY_ORDER.slice(1)].map((c) => `<option value="${esc(c)}" ${c === sel ? "selected" : ""}>${esc(c ? catLabel(c) : "Kategorie …")}</option>`).join("");
  $("#cards").innerHTML = Object.entries(groups).sort(([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b)).map(([g, items]) => {
    const html = items.sort(cmp).map((c) => {
      const cd = c.cd;
      const own = ownershipBadge(c.name, c.qty, c.commander, c.status !== "new");
      const copy = c.status === "new" ? null : shownCopy(c.name);  // the copy whose Ort is this deck
      const img = copy?.image || cd.image, back = copy?.image ? copy.image_back || "" : cd.image_back || "";
      const data = `data-img="${esc(img || "")}" data-img-back="${esc(back)}" data-name="${esc(c.name)}"${copy?.foil ? ' data-foil="1"' : ""}`;
      const label = `${c.qty > 1 ? c.qty + "× " : ""}${c.name}${copy?.foil ? " (Foil)" : ""}`;
      if (grid) {
        return `<div class="card${copy?.foil ? " foil" : ""}" role="button" tabindex="0" ${data} aria-label="${esc(label)} – große Ansicht">
          ${img ? `<img src="${esc(img)}" alt="" loading="lazy">${copy?.foil ? '<span class="foil-sheen" aria-hidden="true"></span>' : ""}` : `<div class="noimg">${esc(c.name)}</div>`}
          ${c.qty > 1 ? `<span class="qty-badge">${c.qty}×</span>` : ""}${own ? `<span class="own-badge">${own}</span>` : ""}</div>`;
      }
      const name = `${esc(c.name)}${cd.image_back ? '<span class="dfc" title="doppelseitig">⇄</span>' : ""}${cd.game_changer ? '<span class="gc" title="Game Changer">GC</span>' : ""}${copy?.foil ? '<span class="foil-tag" title="Foil – liegt so im Deck">Foil</span>' : ""}`;
      const unit = copy && !copy.proxy && copy.price ? copy.price : priceOf(cd, d);
      const price = `<span class="price"${unit !== priceOf(cd, d) ? ' title="Preis deiner Ausgabe"' : ""}>${unit ? esc(fmtNum(unit, "", 2)) : ""}</span>`;
      if (!editing || c.commander) {
        return `<div class="card" role="button" tabindex="0" ${data} aria-label="${esc(label)} – große Ansicht">
          <span>${c.qty > 1 ? `<span class="qty">${c.qty}× </span>` : ""}${name}${own}</span>${price}</div>`;
      }
      if (c.status === "removed") {
        return `<div class="card removed" ${data}><span class="card-name"><s>${esc(label)}</s></span>
          <span class="edit-ctrls"><button type="button" class="mini" data-act="undo" title="Rückgängig">↶ zurück</button></span></div>`;
      }
      return `<div class="card ${c.status || ""}" ${data}>
        <button type="button" class="card-name" data-act="view">${name}${c.status === "new" ? ' <span class="tag-new">neu</span>' : ""}</button>
        <span class="edit-ctrls">
          <select class="cat" data-act="cat" aria-label="Kategorie von ${esc(c.name)}">${catOptions(c.category || "")}</select>
          <button type="button" class="mini" data-act="minus" aria-label="Eine weniger">−</button>
          <span class="q">${c.qty}</span>
          <button type="button" class="mini" data-act="plus" aria-label="Eine mehr">+</button>
          <button type="button" class="mini" data-act="similar" title="Ähnliche Karten zum Tauschen">${icon("swap")}</button>
          <button type="button" class="mini" data-act="maybe" title="Auf die Vielleicht-Liste" aria-label="${esc(c.name)} auf die Vielleicht-Liste">${icon("maybe")}</button>
          <button type="button" class="mini danger" data-act="remove" title="Entfernen" aria-label="${esc(c.name)} entfernen">✕</button>
        </span></div>`;
    }).join("");
    const n = items.filter((r) => r.status !== "removed").reduce((a, c) => a + (c.qty || 1), 0);
    return `<section class="group${!grid && items.length > 16 ? " long" : ""}"><h3>${esc(g)} <span class="count">${n}</span></h3>${grid ? `<div class="group-cards">${html}</div>` : html}</section>`;
  }).join("") + maybeHtml(d, grid, editing);
  updateEditBar(total);
}

// ---------- edit mode ----------
function setEditing(on) {
  if (on && !currentDeck) return;
  edit = on ? { slug: currentDeck.slug, add: new Map(), qty: new Map(), remove: new Set(), cat: new Map(), maybeAdd: new Map(), maybeRemove: new Set() } : null;
  $("#edit-toggle").setAttribute("aria-pressed", String(on));
  $("#edit-toggle span").textContent = on ? "Fertig" : "Bearbeiten";
  $("#add-card-form").hidden = !on;
  renderCards(currentDeck);
  if (on) $("#add-card-name").focus();
}
$("#edit-toggle").addEventListener("click", async () => {
  if (!edit) return setEditing(true);
  if (editChanges() && !(await ask({ title: "Änderungen verwerfen?", text: `${editChanges()} ungespeicherte Änderungen gehen verloren.`, ok: "Verwerfen", danger: true }))) return;
  setEditing(false);
});
$("#edit-discard").addEventListener("click", () => setEditing(false));

function updateEditBar(total) {
  const n = editChanges();
  $("#edit-bar").hidden = !edit || !n;
  syncSaveButtons();
  if (!edit || !n) return;
  const parts = [];
  const out = [...edit.remove].filter((n) => !movedToMaybe(n)).length;
  if (edit.add.size) parts.push(`${edit.add.size} neu`);
  if (out) parts.push(`${out} raus`);
  if (edit.qty.size + edit.cat.size) parts.push(`${edit.qty.size + edit.cat.size} geändert`);
  if (edit.maybeAdd.size + edit.maybeRemove.size) parts.push(`Vielleicht ${[edit.maybeAdd.size && `+${edit.maybeAdd.size}`, edit.maybeRemove.size && `−${edit.maybeRemove.size}`].filter(Boolean).join(" ")}`);
  $("#edit-summary").innerHTML = `${parts.join(" · ")} · <b class="${total === 100 ? "ok" : "bad"}">${total} Karten</b>${total === 100 ? "" : " (Commander-Decks brauchen 100)"}`;
}

function currentQty(name) {
  if (edit.add.has(name)) return edit.add.get(name).qty;
  if (edit.qty.has(name)) return edit.qty.get(name);
  return currentDeck.cards.find((c) => c.name === name)?.qty || 0;
}
function setQty(name, qty) {
  if (edit.add.has(name)) {
    if (qty <= 0) edit.add.delete(name); else edit.add.get(name).qty = qty;
    return;
  }
  const orig = currentDeck.cards.find((c) => c.name === name)?.qty || 0;
  if (qty <= 0) { edit.qty.delete(name); edit.remove.add(name); }
  else if (qty === orig) edit.qty.delete(name);
  else edit.qty.set(name, qty);
}

async function addCard(name, qty = 1, category = "") {
  const pendingMaybe = [...edit.maybeAdd.keys()].find((n) => n.toLowerCase() === name.toLowerCase());
  if (pendingMaybe) {  // back from the (unsaved) maybe list
    const m = edit.maybeAdd.get(pendingMaybe);
    edit.maybeAdd.delete(pendingMaybe);
    if (m.fromDeck) { edit.remove.delete(pendingMaybe); return pendingMaybe; }
    category ||= m.category;
  }
  const inDeck = currentDeck.cards.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (inDeck && !edit.remove.has(inDeck.name)) { setQty(inDeck.name, currentQty(inDeck.name) + qty); return inDeck.name; }
  if (inDeck) { edit.remove.delete(inDeck.name); return inDeck.name; }
  const data = await api(`/api/card?name=${enc(name)}`);
  if (currentDeck.commanders.includes(data.name)) throw new Error(`${data.name} ist der Commander.`);
  const existing = edit.add.get(data.name);
  edit.add.set(data.name, { qty: (existing?.qty || 0) + qty, category: category || existing?.category || "", data });
  return data.name;
}

/** Put a card on the maybe list: a deck card moves there (out of the deck), any other card is looked up first. */
async function addMaybe(name, category = "") {
  const inDeck = currentDeck.cards.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const pending = [...edit.add.keys()].find((n) => n.toLowerCase() === name.toLowerCase());
  if (inDeck && !(edit.remove.has(inDeck.name) && !movedToMaybe(inDeck.name))) {
    const n = inDeck.name;
    edit.add.delete(n); edit.qty.delete(n); edit.cat.delete(n); edit.remove.add(n);
    edit.maybeAdd.set(n, { category: category || inDeck.category || "", data: currentDeck.card_data?.[n] || {}, fromDeck: true });
    return n;
  }
  if (pending) {
    const a = edit.add.get(pending);
    edit.add.delete(pending);
    if (!(currentDeck.maybe || []).some((m) => m.name === pending)) edit.maybeAdd.set(pending, { category: category || a.category || "", data: a.data });
    return pending;
  }
  const saved = (currentDeck.maybe || []).find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (saved) { edit.maybeRemove.delete(saved.name); return saved.name; }
  const data = await api(`/api/card?name=${enc(name)}`);
  if (currentDeck.commanders.includes(data.name)) throw new Error(`${data.name} ist der Commander.`);
  if (data.name !== name && [...currentDeck.cards, ...(currentDeck.maybe || [])].some((c) => c.name === data.name) || edit.add.has(data.name)) return addMaybe(data.name, category);  // a German name
  edit.maybeAdd.set(data.name, { category, data });
  return data.name;
}

/** Take a card off the maybe list (a card that came from the deck in this edit stays out of the deck, shown as removed). */
function removeMaybe(name) {
  if (edit.maybeAdd.delete(name)) return;
  if ((currentDeck.maybe || []).some((m) => m.name === name)) edit.maybeRemove.add(name);
}

/** A typed name can be a card and also a face of another one (Rampant Growth is the prepared spell of
 * Studious First-Year): ask which one is meant, the card of that name first. → the name, or null (cancelled). */
async function chooseCard(name, { deck = true } = {}) {
  const known = deck && [...currentDeck?.cards || [], ...currentDeck?.maybe || [], ...edit?.add.keys() || []]
    .some((c) => (c.name || c).toLowerCase() === name.toLowerCase());
  if (!name || known) return name;
  const { choices } = await api(`/api/card?name=${enc(name)}&choices=1`);
  if (!choices?.length) return name;
  const dlg = $("#card-choice");
  const what = (c) => c.name.toLowerCase() === name.toLowerCase() ? ["Die Karte selbst", "accent"]
    : c.layout === "prepare" ? ["Als vorbereiteter Zauber", ""] : c.layout === "adventure" ? ["Als Abenteuer", ""] : ["Als Kartenseite", ""];
  $("#card-choice-text").textContent = `„${name}“ gibt es als eigene Karte und auf einer anderen Karte.`;
  $("#card-choice-list").innerHTML = choices.map((c) => {
    const [label, kind] = what(c);
    return `<button type="button" class="card-choice" data-name="${esc(c.name)}">
      ${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy">` : ""}
      <span class="pill ${kind}">${esc(label)}</span><b>${esc(c.name)}</b><small>${esc(c.type_line || "")}</small></button>`;
  }).join("");
  return new Promise((resolve) => {
    const done = (v) => { resolve(v); if (dlg.open) dlg.close(); };
    $("#card-choice-list").onclick = (e) => { const b = e.target.closest(".card-choice"); if (b) done(b.dataset.name); };
    $("#card-choice-cancel").onclick = () => done(null);
    dlg.onclose = () => resolve(null);
    dlg.showModal();
    $("#card-choice-list .card-choice").focus();
  });
}

wireAutocomplete($("#add-card-name"), $("#ac-add"));
$("#add-card-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const typed = $("#add-card-name").value.trim();
  if (!typed || !edit) return;
  try {
    const name = await chooseCard(typed);
    if (!name) return;
    const added = await addCard(name, Math.max(1, Number($("#add-card-qty").value) || 1), $("#add-card-cat").value);
    $("#add-card-name").value = "";
    $("#add-card-qty").value = 1;
    renderCards(currentDeck);
    toast(`${added} vorgemerkt – mit „Speichern & prüfen“ übernehmen.`);
  } catch (err) { fail(err); }
});
$("#add-card-maybe").addEventListener("click", async () => {
  const name = $("#add-card-name").value.trim();
  if (!edit) return;
  if (!name) { $("#add-card-name").focus(); return toast("Gib zuerst einen Kartennamen ein."); }
  try {
    const picked = await chooseCard(name);
    if (!picked) return;
    const added = await addMaybe(picked, $("#add-card-cat").value);
    $("#add-card-name").value = "";
    renderCards(currentDeck);
    toast(`${added} kommt auf die Vielleicht-Liste – mit „Speichern & prüfen“ übernehmen.`);
  } catch (err) { fail(err); }
});

$("#cards").addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-act=cat]");
  if (!sel || !edit) return;
  const name = sel.closest(".card").dataset.name;
  if (edit.add.has(name)) edit.add.get(name).category = sel.value;
  else if (sel.value === (currentDeck.cards.find((c) => c.name === name)?.category || "")) edit.cat.delete(name);
  else edit.cat.set(name, sel.value);
  renderCards(currentDeck);
});

$("#edit-save").addEventListener("click", async () => {
  if (!edit || !editChanges()) return;
  const body = {
    add: [...edit.add].map(([name, a]) => ({ name, qty: a.qty, category: a.category || null })),
    remove: [...edit.remove].filter((n) => !movedToMaybe(n)),  // the server moves those itself
    set_qty: Object.fromEntries(edit.qty),
    set_category: Object.fromEntries([...edit.cat].filter(([n]) => !edit.remove.has(n))),
    maybe_add: [...edit.maybeAdd].map(([name, m]) => ({ name, category: m.category || null })),
    maybe_remove: [...edit.maybeRemove],
  };
  const btn = $("#edit-save");
  btn.disabled = true;
  btn.textContent = "Speichere …";
  const slug = edit.slug, since = currentDeck?.version;
  try {
    const r = await api(`/api/decks/${enc(slug)}/cards`, { method: "POST", body });
    setEditing(false);
    currentDeck = null;
    await refreshDeckList();
    await route();
    toast(`Gespeichert als v${r.version}.${r.legal ? "" : " Achtung: das Deck ist nicht legal – siehe Prüfung."}`, r.legal ? "info" : "error");
    void offerOrderAfterRebuild(slug, since);
  } catch (err) { fail(err); }
  finally { btn.disabled = false; btn.textContent = "Speichern & prüfen"; }
});

// ---------- drag cards in from scryfall.com (another window or app) ----------
// Open deck → the cards go into its list (edit mode); anywhere else → commander of a new empty deck.
let dragFromApp = false;  // text or links dragged inside the app itself are no card drops
document.addEventListener("dragstart", () => { dragFromApp = true; });
document.addEventListener("dragend", () => { dragFromApp = false; });
const DROP_TYPES = ["text/uri-list", "text/html", "text/plain"];
// a drop the page leaves alone makes the browser open the link instead of the app, so every outside drag is caught here;
// only the artwork picker keeps its own image-file drops
const isCardDrag = (e) => {
  const types = [...(e.dataTransfer?.types || [])];
  return !dragFromApp && types.some((t) => DROP_TYPES.includes(t)) && !($("#picker").open && types.includes("Files"));
};
const dropIntoDeck = () => parseHash().view === "deck" && !!currentDeck;
// in an open deck the overlay has two targets: the deck (left half of the window) and the maybe list (right half)
const dropOnMaybe = (e) => dropIntoDeck() && !!e && e.clientX > window.innerWidth / 2;

let dropHideTimer = 0;
function showDropOverlay(on, e = null) {
  clearTimeout(dropHideTimer);
  $("#drop-overlay").hidden = !on;
  if (!on) return;
  const deck = dropIntoDeck(), maybe = dropOnMaybe(e);
  $("#drop-overlay").classList.toggle("two", deck);
  $("#drop-maybe").hidden = !deck;
  $("#drop-main").classList.toggle("active", deck && !maybe);
  $("#drop-maybe").classList.toggle("active", maybe);
  $("#drop-title").textContent = deck ? `In „${currentDeck.name}“` : "Als Commander für ein neues Deck";
  $("#drop-hint").textContent = deck ? "Die Karte kommt ins Deck, du speicherst danach." : "Loslassen – danach nur noch „Leeres Deck anlegen“.";
  dropHideTimer = setTimeout(() => showDropOverlay(false), 250);  // dragover repeats while the pointer is in the window
}
document.addEventListener("dragover", (e) => {
  if (!isCardDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  if (!document.querySelector("dialog[open]")) showDropOverlay(true, e);
});
document.addEventListener("drop", async (e) => {
  if (!isCardDrag(e)) return;
  e.preventDefault();
  showDropOverlay(false);
  if (document.querySelector("dialog[open]")) return toast("Schließ zuerst das offene Fenster, dann zieh die Karte herein.", "error");
  const dt = e.dataTransfer;
  const body = { uri_list: dt.getData("text/uri-list"), html: dt.getData("text/html"), text: dt.getData("text/plain") };
  try {
    const r = await api("/api/cards/drop", { method: "POST", body });
    if (r.missing.length && !r.cards.length) throw new Error(`Karte nicht gefunden: ${r.missing.join(", ")}`);
    if (dropIntoDeck()) await dropCardsIntoDeck(r.cards, { maybe: dropOnMaybe(e) });
    else dropCommander(r.cards);
    if (r.missing.length) toast(`Nicht erkannt: ${r.missing.join(", ")}`, "error");
  } catch (err) { fail(err); }
});

let dropToast = null;
async function dropCardsIntoDeck(cards, { maybe = false } = {}) {
  if ($("#panel-karten").hidden) selectTab("karten");
  if (!edit) setEditing(true);
  const added = [];
  for (const c of cards) {
    try { added.push(await (maybe ? addMaybe(c.name) : addCard(c.name))); } catch (err) { fail(err); }
  }
  if (!added.length) return;
  renderCards(currentDeck);
  for (const name of added) {
    const row = $(`#cards .card[data-name="${CSS.escape(name)}"]`);
    row?.classList.add("just-dropped");
    if (name === added[added.length - 1]) row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  dropToast?.remove();  // one card after the other: one toast, not a stack
  dropToast = toast(`${added.join(", ")} ${maybe ? "kommt auf die Vielleicht-Liste" : "vorgemerkt"} – mit „Speichern & prüfen“ übernehmen.`, "info", 6000, { label: "Rückgängig", run: () => {
    if (!edit) return;
    for (const name of added) {
      if (!maybe) setQty(name, currentQty(name) - 1);
      else if (movedToMaybe(name)) void addCard(name);  // back into the deck
      else removeMaybe(name);
    }
    renderCards(currentDeck);
  } });
}

function dropCommander(cards) {
  const onForm = parseHash().view === "new" && $("#import-box").dataset.imode === "manual";
  const cmd = $("#manual-cmd"), partner = $("#manual-partner");
  if (parseHash().view !== "new") go("#/new");
  setImportMode("manual");
  if (onForm && cmd.value.trim() && !partner.value.trim()) partner.value = cards[0].name;  // second drop = partner
  else { cmd.value = cards[0].name; partner.value = cards[1]?.name || ""; }
  const names = [cmd.value, partner.value].filter(Boolean).join(" + ");
  const legendary = cards.every((c) => /legendary|legendär/i.test(c.type_line || ""));
  toast(legendary ? `Commander: ${names}. Jetzt „Leeres Deck anlegen“ klicken.` : `${names} eingetragen – Achtung, das ist keine legendäre Karte.`,
    legendary ? "info" : "error", 6000);
  $("#manual-btn").focus();
}

// ---------- collection ownership in the deck (filled by loadOwnership) ----------
let ownership = null;  // { cards: {name: {need, real, proxy, missing, other_decks}}, ... }
const OWNED_ORDER = ["Fehlt", "Als Proxy vorhanden", "Vorhanden"];
function ownershipLabel(name) {
  const o = ownership?.cards?.[name];
  if (!o) return "Unbekannt";
  return o.missing > 0 ? "Fehlt" : o.real >= o.need ? "Vorhanden" : "Als Proxy vorhanden";
}
function ownershipBadge(name, need = 1, commander = false, button = false) {
  const o = ownership?.cards?.[name];
  if (!ownership?.collection_size || (!o && !ownership.all)) return "";
  const real = o?.real || 0, prox = o?.proxy || 0;
  // where the copies are right now (the Ort of each collection entry), one line per place
  const where = (o?.places || []).map((p) => `${p.qty}× ${placeLabel(p) || "ohne Ort"}${p.proxy ? " (Proxy)" : ""}`).join("\n");
  const tip = (head) => esc(where ? `${head}:\n${where}` : head);
  // in the deck list the badge is a button: it opens the copies to move into this deck
  const badge = (cls, head, text) => button
    ? `<button type="button" class="own ${cls}" data-act="own" title="${tip(head)}\n\nKlicken: Exemplare in dieses Deck legen" aria-label="${esc(head)} – Exemplare in dieses Deck legen">${text}</button>`
    : `<span class="own ${cls}" title="${tip(head)}">${text}</span>`;
  if (real >= need) return badge("ok", "In deiner Sammlung", "✓");
  if (real + prox >= need) return badge("proxy", "Als Proxy in deiner Sammlung", "P");
  if (real + prox > 0) return badge("part", `Nur ${real + prox} von ${need} vorhanden`, `${real + prox}/${need}`);
  return "";  // missing: no badge (the Sammlung panel and "nach Besitz" show them) – keeps the list calm
}

// the copies whose Ort is this deck (printing, foil, proxy): the deck view shows them instead of the default printing
const deckCopies = (name) => (ownership && ownership.slug === currentDeck?.slug && ownership.cards?.[name]?.copies) || [];
const shownCopy = (name) => deckCopies(name)[0] || null;
// the deck's value with its own printings, only once at least one copy lies in the deck
function deckValue(d) {
  const v = ownership?.slug === d?.slug ? ownership.value : null;
  return v && v.own + v.proxy > 0 ? v : null;
}
function deckValueTip(d) {
  const v = deckValue(d);
  if (!v) return "";
  const cur = (d.currency || "eur").toUpperCase();
  return [`Wert mit deinen Karten aus der Sammlung (Ort: dieses Deck):`,
    `${v.own} eigene Karten mit dem Preis ihrer Ausgabe${v.foil ? `, davon ${v.foil} Foil` : ""}`,
    v.proxy ? `${v.proxy} Proxies zählen 0` : "",
    v.rest ? `${v.rest} weitere zur günstigsten Ausgabe` : "",
    `Günstigste Ausgaben für alles: ${fmtPrice(v.cheapest, cur)}`].filter(Boolean).join("\n");
}
// ---------- move collection copies into the open deck (click on the ✓/P badge) ----------
let ownCopies = null;  // { slug, name, data: card_copies(), moved: {deck entry id: move result} }
const OWN_FILTERS = { all: () => true, real: (e) => !e.proxy, proxy: (e) => !!e.proxy };
async function openOwnCopies(name) {
  const slug = currentDeck?.slug;
  if (!slug) return;
  const filter = OWN_FILTERS[store.get("ownfilter")] ? store.get("ownfilter") : "all";
  $("#own-copies-filter").querySelector(`input[value="${filter}"]`).checked = true;
  const moved = ownCopies?.slug === slug && ownCopies.name === name ? ownCopies.moved : {};  // moves made while it was open
  try { ownCopies = { slug, name, moved, data: await api(`/api/decks/${enc(slug)}/copies?name=${enc(name)}`) }; } catch (err) { return fail(err); }
  $("#own-copies-title").textContent = name;
  renderOwnCopies();
  const dlg = $("#own-copies");
  if (!dlg.open) dlg.showModal();
}
function renderOwnCopies() {
  const { data } = ownCopies;
  const filter = $("#own-copies-filter").querySelector("input:checked").value;
  const want = OWN_FILTERS[filter];
  const left = Math.max(0, data.need - data.placed);
  $("#own-copies-text").textContent = data.need
    ? `Das Deck braucht ${data.need}×. ${data.placed ? `${data.placed} ${data.placed === 1 ? "liegt" : "liegen"} schon drin` : "Noch keins liegt drin"}${left ? ` – ${left} fehlt noch.` : "."}`
    : "Diese Karte ist gerade nicht im Deck.";
  const row = (e, here) => {
    const where = here ? "In diesem Deck" : placeLabel(e) || "Ohne Ort";
    const facts = [`${e.qty}×`, e.proxy ? "Proxy" : "Echt", where].join(" · ");
    const act = here ? "" : `<span class="oc-act">
      ${e.qty > 1 ? `<input type="number" min="1" max="${e.qty}" value="${Math.min(e.qty, Math.max(1, left))}" aria-label="Wie viele davon?" data-qty>` : ""}
      <button type="button" class="btn small" data-move="${esc(e.id)}">Ins Deck</button></span>`;
    return `<div class="oc-row">
      ${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy">` : '<span class="oc-noimg"></span>'}
      <div><b>${esc(copyLabel({ ...e, proxy: false }) || "Ohne bestimmte Ausgabe")}</b><small>${esc(facts)}</small>
        ${e.used_by ? `<small class="warn">Wird in „${esc(e.used_by)}“ gespielt</small>` : ""}</div>
      ${here ? (ownCopies.moved[e.id] ? `<button type="button" class="btn small" data-back="${esc(e.id)}">Zurücklegen</button>` : `<span class="pill ok">Liegt hier</span>`) : act}</div>`;
  };
  const elsewhere = data.elsewhere.filter(want), here = data.here.filter(want);
  const hidden = data.elsewhere.length - elsewhere.length;
  $("#own-copies-list").innerHTML = [
    `<h3>An anderen Orten</h3>`,
    elsewhere.length ? elsewhere.map((e) => row(e, false)).join("")
      : `<p class="muted small">${hidden ? `Keine ${filter === "real" ? "echten" : "Proxy-"}Exemplare woanders – ${hidden} unter „Alle“.` : "Keine weiteren Exemplare in deiner Sammlung."}</p>`,
    here.length ? `<h3>Schon in diesem Deck</h3>${here.map((e) => row(e, true)).join("")}` : "",
  ].join("");
}
$("#own-copies-filter").addEventListener("change", (e) => { store.set("ownfilter", e.target.value); renderOwnCopies(); });
$("#own-copies-close").addEventListener("click", () => $("#own-copies").close());
$("#own-copies").addEventListener("close", () => { ownCopies = null; });
// puts moved copies back where they came from (one undo per move; the toast's „Rückgängig“ does the same)
async function undoOwnMove(slug, name, moved) {
  await api("/api/collection/bulk", { method: "POST", body: { ids: [moved.id], place: moved.place, place_deck: moved.place_deck, qty: moved.qty } });
  if (ownCopies?.slug === slug && ownCopies.name === name) delete ownCopies.moved[moved.id];
  await afterOwnMove(slug, name);
}
$("#own-copies-list").addEventListener("click", async (e) => {
  const back = e.target.closest("[data-back]");
  if (back && ownCopies?.moved[back.dataset.back]) {
    back.disabled = true;
    return undoOwnMove(ownCopies.slug, ownCopies.name, ownCopies.moved[back.dataset.back]).catch((err) => { back.disabled = false; fail(err); });
  }
  const btn = e.target.closest("[data-move]");
  if (!btn || !ownCopies) return;
  const state = ownCopies, { slug, name } = state;
  const entry = state.data.elsewhere.find((x) => x.id === btn.dataset.move);
  const input = btn.closest(".oc-row").querySelector("[data-qty]");
  const qty = input ? Math.min(entry.qty, Math.max(1, Math.round(Number(input.value) || 1))) : entry.qty;
  btn.disabled = true;
  try {
    const moved = await api(`/api/decks/${enc(slug)}/copies/move`, { method: "POST", body: { id: entry.id, qty } });
    const deckName = currentDeck?.slug === slug ? currentDeck.name : slug;
    const prev = state.moved[moved.id];  // a second move from the same place into the same entry: undo both
    state.moved[moved.id] = prev && prev.place === moved.place && prev.place_deck === moved.place_deck
      ? { ...moved, qty: prev.qty + moved.qty } : moved;
    toast(`${moved.qty}× ${name} liegt jetzt in „${deckName}“.`, "ok", 6000,
      { label: "Rückgängig", run: () => undoOwnMove(slug, name, moved).catch(fail) });
    await afterOwnMove(slug, name);
  } catch (err) { btn.disabled = false; fail(err); }
});
async function afterOwnMove(slug, name) {
  if ($("#own-copies").open && ownCopies?.slug === slug && ownCopies.name === name) await openOwnCopies(name);
  if (currentDeck?.slug === slug) await loadOwnership(currentDeck);
}

function copyLabel(c) {
  const lang = c.lang && c.lang !== "en" ? (LANG_NAMES[c.lang] || c.lang.toUpperCase()) : "";
  return [c.set_name || (c.set || "").toUpperCase(), c.collector_number ? `#${c.collector_number}` : "", c.foil ? "Foil" : "", lang, c.proxy ? "Proxy" : ""]
    .filter(Boolean).join(" · ");
}

// ---------- test hand (London mulligan, first mulligan free) ----------
let hand = null;  // { lib: [card], hand: [card], draws, mull, bottom }
const isLand = (cd) => /\bLand\b/.test(cd?.type_line || "");
function libraryOf(d) {
  return d.cards.flatMap((c) => Array.from({ length: c.qty || 1 }, () => ({ name: c.name, cd: d.card_data?.[c.name] || {} })));
}
function shuffle(arr) {
  const rnd = new Uint32Array(arr.length);
  crypto.getRandomValues(rnd);
  for (let i = arr.length - 1; i > 0; i--) { const j = rnd[i] % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
function resetHand() {
  hand = null;
  $("#hand").innerHTML = "";
  $("#hand-hint").hidden = true;
  $("#hand-status").textContent = "Zieh eine Starthand – wie am Tisch.";
  rateHand();
}
function dealHand(mull) {
  const lib = shuffle(libraryOf(currentDeck));
  hand = { lib, hand: lib.splice(0, 7), draws: 0, mull, bottom: Math.max(0, mull - 1) };
  renderHand();
}
function renderHand() {
  if (!hand) return;
  const lands = hand.hand.filter((c) => isLand(c.cd)).length;
  const onDraw = $("#on-draw").checked;
  const turn = hand.draws === 0 ? 1 : onDraw ? hand.draws : hand.draws + 1;
  $("#hand-status").textContent = `${hand.draws ? `Zug ${turn}` : "Starthand"} · ${hand.hand.length} Karten · ${lands} ${lands === 1 ? "Land" : "Länder"}`
    + (hand.mull ? ` · ${hand.mull}. Mulligan` : "") + ` · noch ${hand.lib.length} in der Bibliothek`;
  const hint = $("#hand-hint");
  hint.hidden = !hand.bottom && hand.mull !== 1;
  hint.textContent = hand.bottom
    ? `Lege noch ${hand.bottom} ${hand.bottom === 1 ? "Karte" : "Karten"} unter die Bibliothek – klick sie an.`
    : "Der erste Mulligan ist in Commander frei: du behältst alle 7 Karten.";
  $("#hand").innerHTML = hand.hand.map((c, i) => `<button type="button" class="hand-card card ${isLand(c.cd) ? "land" : ""}" data-i="${i}"
      data-img="${esc(c.cd.image || "")}" data-name="${esc(c.name)}" title="${esc(c.name)}${hand.bottom ? " – unter die Bibliothek legen" : ""}">
      ${c.cd.image ? `<img src="${esc(c.cd.image)}" alt="${esc(c.name)}">` : `<span class="noimg">${esc(c.name)}</span>`}</button>`).join("");
  $("#hand-draw").disabled = !!hand.bottom || !hand.lib.length;
  if (!hand.draws) rateHand();  // drawing later keeps the rating of the starting hand
}
$("#hand-new").addEventListener("click", () => currentDeck && dealHand(0));
$("#hand-mull").addEventListener("click", () => currentDeck && dealHand((hand?.mull || 0) + 1));
$("#hand-draw").addEventListener("click", () => {
  if (!hand) return dealHand(0);
  if (hand.bottom || !hand.lib.length) return;
  hand.hand.push(hand.lib.shift());
  hand.draws += 1;
  renderHand();
});
$("#on-draw").addEventListener("change", () => { renderHand(); if (currentDeck) renderOdds(currentDeck); if (!hand) rateHand(); });
$("#hand").addEventListener("click", (e) => {
  const b = e.target.closest(".hand-card");
  if (!b || !hand) return;
  if (!hand.bottom) {
    const i = Number(b.dataset.i);
    showCardView(b.dataset.name, hand.hand[i].cd, hand.hand.map((c) => ({ name: c.name, cd: c.cd })), i);
    return;
  }
  hand.lib.push(...hand.hand.splice(Number(b.dataset.i), 1));
  hand.bottom -= 1;
  renderHand();
});

// ---------- rating of the starting hand (openinghand.py: rules and odds, no AI) ----------
let handRating = { seq: 0, timer: 0, suggest: [] };
function rateHand() {
  clearTimeout(handRating.timer);
  handRating.timer = setTimeout(loadHandRating, 120);
}
async function loadHandRating() {
  const d = currentDeck;
  if (!d) return;
  const seq = ++handRating.seq;
  const body = { cards: hand ? hand.hand.map((c) => c.name) : [], mulligans: hand?.mull || 0,
    on_draw: $("#on-draw").checked, bottom: hand?.bottom || 0 };
  let r;
  try {
    r = await api(`/api/decks/${enc(d.slug)}/hand`, { method: "POST", body });
  } catch (err) {
    if (seq === handRating.seq) $("#hand-rating").innerHTML = `<p class="muted small">Bewertung gerade nicht möglich: ${esc(err.message)}</p>`;
    return;
  }
  if (seq !== handRating.seq || currentDeck?.slug !== d.slug) return;
  renderHandRating(r, d);
}
function renderHandRating(r, d) {
  const deckInfo = r.deck || {};
  const speed = d.speed ? ` · Tempo des Decks: ${esc(d.speed.label)}` : "";
  $("#hand-rating-deck").innerHTML = deckInfo.playable != null
    ? `In diesem Deck sind <b>${pct(deckInfo.keep)}</b> der Starthände gut und <b>${pct(deckInfo.playable)}</b> spielbar${speed}.`
    : "Zieh eine Hand – hier steht dann, ob du sie behalten solltest.";
  handRating.suggest = r.bottom || [];
  markBottomSuggestion();
  if (r.score == null) { $("#hand-rating").innerHTML = ""; return; }
  const li = (t) => `<li>${esc(t)}</li>`;
  const f = r.facts || {};
  const odds = f.odds || {};
  const facts = [
    ["Mana-Quellen", `${f.mana_sources}`, "Länder, Ramp und Zauber mit Land-Rückseite"],
    ["Bis Zug 3 spielbar", `${f.early_plays}`, "Zauber, die die Hand in den ersten drei Zügen wirken kann"],
    f.commander ? ["Commander", f.commander_turn ? `Zug ${f.commander_turn}` : "nach Zug 6", `${f.commander}, wenn alles nach Plan läuft`] : null,
    ["3 Länder bis Zug 3", pct(odds.lands_by_3 ?? 0), "Wahrscheinlichkeit mit dem Rest der Bibliothek"],
    ["4 Länder bis Zug 4", pct(odds.lands_by_4 ?? 0), "Wahrscheinlichkeit mit dem Rest der Bibliothek"],
  ].filter(Boolean);
  const where = r.percentile != null ? `Besser als ${r.percentile} % der Starthände dieses Decks` : `Hand mit ${hand?.hand.length ?? "?"} Karten`;
  $("#hand-rating").innerHTML = `
    <div class="hr-head">
      <span class="hr-verdict ${esc(r.verdict)}">${esc(r.label)}</span>
      <div class="hr-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.score}" aria-label="Bewertung ${r.score} von 100">
        <div class="hr-fill ${esc(r.verdict)}" style="width:${r.score}%"></div></div>
      <span class="hr-score">${r.score}<span class="muted"> / 100</span></span>
    </div>
    <p class="muted small hr-where">${where}${r.fatal ? ` · <b class="bad">${esc(r.fatal)}</b>` : ""}</p>
    ${r.advice ? `<p class="hint-box">${esc(r.advice)}</p>` : ""}
    ${r.bottom?.length ? `<p class="hint-box">Vorschlag zum Unterlegen: <b>${r.bottom.map(esc).join(", ")}</b> – markiert in der Hand.</p>` : ""}
    <div class="hr-cols">
      <div><h3>Spricht dafür</h3>${r.good.length ? `<ul class="hr-list good">${r.good.map(li).join("")}</ul>` : '<p class="muted small">Nichts Besonderes.</p>'}</div>
      <div><h3>Spricht dagegen</h3>${r.bad.length ? `<ul class="hr-list bad">${r.bad.map(li).join("")}</ul>` : '<p class="muted small">Nichts.</p>'}</div>
    </div>
    <dl class="hr-facts">${facts.map(([k, v, t]) => `<div title="${esc(t)}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    <details class="more"><summary>Wie wird bewertet?</summary>
      <p class="small">Ohne KI, nur Regeln und Wahrscheinlichkeiten: Die App spielt die Hand für ein paar Züge allein durch
      (ein Land pro Zug, gezogene Länder im Schnitt der Bibliothek, Ramp zuerst, dann die günstigsten Zauber) und rechnet
      die Landdrops hypergeometrisch aus dem Rest der Bibliothek. Gezählt werden Länder (3–4 sind ideal), Ramp (Sol Ring und Co. zählen wie Länder),
      frühe Züge, passende Farben, wann der Commander kommt, Kartenzug, Interaktion, Tutoren und Kombo-Teile aus der Deck-Prüfung.
      Das Tempo des Decks ändert die Maßstäbe: ein schnelles Deck braucht einen schnellen Start, ein langsames verträgt mehr Länder und Ramp.
      Zum Vergleich werden 600 zufällige Starthände dieses Decks genauso bewertet.</p>
      <p class="small muted">Grundlage: Frank Karstens Commander-Analysen (Länder, Farbquellen, Mulligan-Regeln), die Mulligan-Guides von EDHREC und topdeck.gg (cEDH)
      sowie Daten von playgroup.gg. Der erste Mulligan ist in Commander frei.</p>
    </details>`;
}
function markBottomSuggestion() {
  const names = [...handRating.suggest];
  $("#hand").querySelectorAll(".hand-card").forEach((b) => {
    const i = names.indexOf(b.dataset.name);
    b.classList.toggle("suggest", !!hand?.bottom && i >= 0);
    if (i >= 0) names.splice(i, 1);
  });
}

// ---------- probabilities (hypergeometric) ----------
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) r = (r * (n - Math.min(k, n - k) + i)) / i;
  return r;
}
const pExactly = (N, K, n, k) => (choose(K, k) * choose(N - K, n - k)) / choose(N, n);
function pAtLeast(N, K, n, k) {
  let p = 0;
  for (let i = k; i <= Math.min(n, K); i++) p += pExactly(N, K, n, i);
  return Math.min(1, p);
}
const pct = (p) => `${Math.round(p * 100)} %`;

function renderOdds(d) {
  const lib = libraryOf(d);
  const N = lib.length;
  if (N < 8) { $("#odds").innerHTML = '<p class="muted">Zu wenige Karten.</p>'; return; }
  const count = (fn) => lib.filter((c) => fn(c.cd)).length;
  const L = count(isLand);
  const has = (roles) => (cd) => !isLand(cd) && (cd.roles || []).some((r) => roles.includes(r));
  const R = count(has(["ramp"])), D = count(has(["card_draw"])), X = count(has(["removal", "board_wipe", "counterspell"]));
  const onDraw = $("#on-draw").checked;
  const seen = (turn) => 7 + (onDraw ? turn : turn - 1);  // cards seen by the given turn
  const dist = Array.from({ length: 8 }, (_, k) => pExactly(N, L, 7, k));
  const max = Math.max(...dist);
  const keep = dist.slice(2, 6).reduce((a, b) => a + b, 0);
  const bars = dist.map((p, k) => `<div class="dbar ${k >= 2 && k <= 5 ? "ok" : ""}" title="${k} Länder: ${pct(p)}">
      <div class="fill" style="height:${(p / max) * 100}%"></div><span class="x">${k}</span></div>`).join("");
  const row = (label, p, detail) => `<tr><th scope="row">${label}</th><td class="num">${pct(p)}</td><td class="muted small">${detail}</td></tr>`;
  $("#odds").innerHTML = `
    <div class="odds-grid">
      <figure class="dist">
        <figcaption><b>Länder in der Starthand</b> · Ø ${fmtNum(7 * L / N, "", 1)} · 2–5 Länder: <b>${pct(keep)}</b></figcaption>
        <div class="dbars" role="img" aria-label="Länder in der Starthand: ${dist.map((p, k) => `${k}: ${pct(p)}`).join(", ")}">${bars}</div>
      </figure>
      <table class="odds-table">
        <caption class="sr-only">Wahrscheinlichkeiten ${onDraw ? "auf dem Draw" : "auf dem Play"}</caption>
        <tbody>
          ${[2, 3, 4, 5].map((t) => row(`${t}. Landdrop in Zug ${t}`, pAtLeast(N, L, seen(t), t), `mind. ${t} Länder unter ${seen(t)} Karten`)).join("")}
          ${R ? row("Ramp bis Zug 2", pAtLeast(N, R, seen(2), 1), `${R} Ramp-Karten im Deck`) : ""}
          ${D ? row("Kartenzug bis Zug 3", pAtLeast(N, D, seen(3), 1), `${D} Kartenzug-Karten`) : ""}
          ${X ? row("Interaktion bis Zug 4", pAtLeast(N, X, seen(4), 1), `${X} Removal/Wipes/Counter`) : ""}
        </tbody>
      </table>
    </div>
    <p class="muted small">${L} Länder in ${N} Karten · ${onDraw ? "auf dem Draw (Karte in Zug 1)" : "auf dem Play (keine Karte in Zug 1)"}${keep < 0.75 ? ` · <span class="warn">Nur ${pct(keep)} der Starthände haben 2–5 Länder – mehr Länder oder günstiger Ramp helfen.</span>` : ""}</p>`;
}

// ---------- tokens, emblems and markers the deck creates ----------
async function loadTokens(d) {
  $("#token-panel").hidden = true;
  let toks = [];
  try { toks = await api(`/api/decks/${enc(d.slug)}/tokens`); } catch { return; }
  if (currentDeck?.slug !== d.slug || !toks.length) return;
  $("#token-panel").hidden = false;
  $("#token-count").textContent = toks.length;
  $("#token-list").innerHTML = toks.map((t) => `<li class="card" data-img="${esc(t.image || "")}" data-name="${esc(t.name)}" data-type="${esc(t.type_line)}" data-id="${esc(t.id || "")}">
    ${t.image ? `<img src="${esc(t.image)}" alt="" loading="lazy">` : ""}
    <div><b>${esc(t.name)}</b><div class="muted small">${esc(t.type_line.replace(/^Token /, ""))} · von ${esc(t.from.slice(0, 3).join(", "))}${t.from.length > 3 ? ` +${t.from.length - 3}` : ""}</div></div></li>`).join("");
}
$("#token-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-name]");
  if (!li) return;
  const items = [...$("#token-list").querySelectorAll("li[data-name]")];
  const tokenCd = (el) => ({ image: el.dataset.img, token: true, type_line: el.dataset.type, id: el.dataset.id });
  showCardView(li.dataset.name, tokenCd(li), items.map((el) => ({ name: el.dataset.name, cd: tokenCd(el) })), items.indexOf(li));
});

// ---------- replacement suggestions ----------
// deck check: traffic light per area; "fix" offers role candidates
const STATUS_TEXT = { green: "passt", yellow: "prüfen", red: "Problem" };
const ROLE_CATEGORY = { ramp: "Ramp", card_draw: "Draw", removal: "Removal", board_wipe: "Board Wipe" };
function renderHealth(d) {
  const h = d.health;
  $("#health-panel").hidden = !h;
  if (!h) return;
  const row = (it) => `<li><details data-key="${esc(it.key)}">
      <summary><span class="light ${esc(it.status)}" role="img" aria-label="${STATUS_TEXT[it.status]}"></span>
        <span class="h-label">${esc(it.label)}</span><span class="h-val">${esc(fmtNum(it.value))} · Ziel ${esc(it.target)}</span></summary>
      <div class="h-body"><p>${esc(it.text)}</p><p class="why"><strong>Warum wichtig?</strong> ${esc(it.why)}</p>
        ${it.cards.length ? `<p class="why">Erkannt: ${it.cards.slice(0, 12).map(esc).join(", ")}${it.cards.length > 12 ? " …" : ""}</p>` : ""}
        ${it.fix ? `<div class="btn-group">
          ${it.fix.role ? `<button type="button" class="btn small" data-role="${esc(it.fix.role)}" data-label="${esc(it.label)}">Karten vorschlagen</button>` : ""}
        </div>` : ""}</div></details></li>`;
  const open = h.items.filter((it) => it.status !== "green" && it.key !== "table_rule");
  const n = open.length;
  $("#health-summary").textContent = n
    ? `${n} ${n === 1 ? "Bereich braucht" : "Bereiche brauchen"} Aufmerksamkeit.`
    : "Alles im grünen Bereich.";
  $("#health-list").innerHTML = open.map(row).join("");
  $("#health-all-list").innerHTML = h.items.map(row).join("");
}
$("#health-panel").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.role) void openRoleCandidates(b.dataset.role, b.dataset.label);
});

let similarRole = null;
async function openRoleCandidates(role, label) {
  similarFor = null;
  similarRole = role;
  $("#similar-title").textContent = `${label} ergänzen`;
  $("#similar-hint").textContent = "Suche beliebte Karten in deinen Farben …";
  $("#similar-grid").innerHTML = "";
  $("#similar").showModal();
  try {
    const items = await api(`/api/decks/${enc(currentDeck.slug)}/role-candidates?role=${enc(role)}`);
    const cur = (currentDeck.currency || "eur") === "usd" ? "price_usd" : "price_eur";
    $("#similar-hint").textContent = items.length
      ? "Klick merkt die Karte im Bearbeiten-Modus vor. Nimm für jede neue Karte eine andere heraus, damit es 100 bleiben."
      : "Keine passenden Karten gefunden.";
    $("#similar-grid").innerHTML = items.map((c) => `<button type="button" class="similar" data-name="${esc(c.name)}">
      ${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy">` : `<div class="noimg">${esc(c.name)}</div>`}
      <span class="sim-name">${esc(c.name)}</span>
      <span class="muted small">${esc(c.type_line || "")}${c[cur] ? ` · ${esc(c[cur])}` : ""}${ownershipBadge(c.name, 1) ? " · " + ownershipBadge(c.name, 1) : ""}</span></button>`).join("");
  } catch (err) { $("#similar-hint").textContent = err.message; }
}

let similarFor = null;
async function openSimilar(name) {
  similarFor = name;
  similarRole = null;
  $("#similar-title").textContent = `Ersatz für ${name}`;
  $("#similar-hint").textContent = "Suche Karten mit gleicher Rolle in deinen Farben …";
  $("#similar-grid").innerHTML = "";
  $("#similar").showModal();
  try {
    const items = await api(`/api/decks/${enc(currentDeck.slug)}/similar?card=${enc(name)}`);
    const cur = (currentDeck.currency || "eur") === "usd" ? "price_usd" : "price_eur";
    $("#similar-hint").textContent = items.length ? "Klick tauscht die Karte (wird erst beim Speichern übernommen)." : "Keine passenden Karten gefunden.";
    $("#similar-grid").innerHTML = items.map((c, i) => `<button type="button" class="similar" data-i="${i}" data-name="${esc(c.name)}">
      ${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy">` : `<div class="noimg">${esc(c.name)}</div>`}
      <span class="sim-name">${esc(c.name)}</span>
      <span class="muted small">${esc(c.reason || "")}${c[cur] ? ` · ${esc(c[cur])}` : ""}${ownershipBadge(c.name, 1) ? " · " + ownershipBadge(c.name, 1) : ""}</span></button>`).join("");
  } catch (err) { $("#similar-hint").textContent = err.message; }
}
$("#similar-grid").addEventListener("click", async (e) => {
  const b = e.target.closest(".similar");
  if (b && similarRole) {
    if (b.classList.contains("picked")) return;
    try {
      if (!edit) setEditing(true);
      const added = await addCard(b.dataset.name, 1, ROLE_CATEGORY[similarRole] || "");
      b.classList.add("picked");
      b.querySelector(".sim-name").textContent = "✓ " + added;
      renderCards(currentDeck);
      toast(`${added} vorgemerkt – entferne dafür eine andere Karte und speichere.`);
    } catch (err) { fail(err); }
    return;
  }
  if (!b || !edit || !similarFor) return;
  const old = similarFor;
  const category = edit.add.get(old)?.category || edit.cat.get(old) || currentDeck.cards.find((c) => c.name === old)?.category || "";
  try {
    const added = await addCard(b.dataset.name, 1, category);
    setQty(old, currentQty(old) - 1);
    $("#similar").close();
    renderCards(currentDeck);
    toast(`${old} → ${added} vorgemerkt.`);
  } catch (err) { fail(err); }
});
$("#similar-close").addEventListener("click", () => $("#similar").close());

// ---- card search by description: the sync server asks Claude for a Scryfall query, Scryfall answers ----
const DESC_COLORS = [["W", "Weiß"], ["U", "Blau"], ["B", "Schwarz"], ["R", "Rot"], ["G", "Grün"], ["C", "Farblos"]];
const DESC_TYPES = [["creature", "Kreatur"], ["instant", "Spontanzauber"], ["sorcery", "Hexerei"], ["artifact", "Artefakt"],
  ["enchantment", "Verzauberung"], ["planeswalker", "Planeswalker"], ["land", "Land"]];
const describe = { slug: null, query: "", page: 1, busy: false };

function deckColors() {
  const ci = new Set();
  for (const n of currentDeck?.commanders || []) for (const c of currentDeck.card_data?.[n]?.color_identity || []) ci.add(c);
  return ci.size ? [...ci] : ["C"];
}
function describeChips(box, items, on) {
  box.innerHTML = items.map(([v, l]) => `<button type="button" class="chip" data-v="${v}" aria-pressed="${on.includes(v)}">${esc(l)}</button>`).join("");
}
const pickedChips = (box) => [...box.querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset.v);

function openDescribe() {
  if (describe.slug !== currentDeck.slug) {  // a new deck: its colours, a fresh form
    describe.slug = currentDeck.slug;
    describeChips($("#describe-colors"), DESC_COLORS, deckColors());
    describeChips($("#describe-types"), DESC_TYPES, []);
    $("#describe-text").value = "";
    describeShow(null);
  }
  $("#describe").showModal();
  $("#describe-text").focus();
}
for (const box of ["#describe-colors", "#describe-types"]) {
  $(box).addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    // "Farblos" next to colours adds colourless cards (Sol Ring); alone it means only colourless ones
    b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
  });
}

function describeShow(got, { append = false } = {}) {
  const grid = $("#describe-grid");
  $("#describe-query").hidden = !got;
  $("#describe-more").hidden = !got?.has_more;
  if (!got) { grid.innerHTML = ""; $("#describe-hint").textContent = ""; return; }
  const cur = (currentDeck.currency || "eur") === "usd" ? "price_usd" : "price_eur";
  const inDeck = new Set([...currentDeck.cards.map((c) => c.name), ...(edit ? edit.add.keys() : [])]);
  const html = got.cards.map((c) => `<button type="button" class="similar${inDeck.has(c.name) ? " picked" : ""}" data-name="${esc(c.name)}">
      ${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy">` : `<div class="noimg">${esc(c.name)}</div>`}
      <span class="sim-name">${inDeck.has(c.name) ? "✓ " : ""}${esc(c.name)}</span>
      <span class="muted small">${esc(c.type_line || "")}${c[cur] ? ` · ${esc(fmtPrice(c[cur], currentDeck.currency))}` : ""}${ownershipBadge(c.name, 1) ? " · " + ownershipBadge(c.name, 1) : ""}</span></button>`).join("");
  grid.innerHTML = append ? grid.innerHTML + html : html;
  if (!append) {
    $("#describe-q").value = got.used ?? describe.query;
    $("#describe-explain").textContent = got.explain || "";
    const broader = got.used && got.broader && got.used === got.broader && got.used !== got.query;
    $("#describe-hint").textContent = !got.total ? "Keine Karten gefunden – anders beschreiben oder die Suche anpassen."
      : `${fmtNum(got.total)} ${got.total === 1 ? "Karte" : "Karten"}${broader ? " · genau so gab es nichts, das ist die breitere Suche" : ""} · Klick merkt eine Karte im Deck vor.`;
  }
}

async function describeRun(fn) {
  if (describe.busy) return;
  describe.busy = true;
  $("#describe-go").disabled = $("#describe-q-run").disabled = true;
  $("#describe-setup").hidden = true;
  $("#describe-hint").textContent = "Suche läuft …";
  try { await fn(); }
  catch (err) {
    $("#describe-hint").textContent = err.message;
    if (err.status === 409 && /eingerichtet/.test(err.message)) void describeSetup();
  } finally {
    describe.busy = false;
    $("#describe-go").disabled = $("#describe-q-run").disabled = false;
  }
}

$("#describe-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#describe-text").value.trim();
  if (text.length < 3) { $("#describe-hint").textContent = "Beschreib kurz, was die Karte tun soll."; return; }
  void describeRun(async () => {
    describeShow(null);
    $("#describe-hint").textContent = "Claude baut die Suche …";
    const got = await api("/api/cards/describe", { method: "POST", body: { text, colors: pickedChips($("#describe-colors")), types: pickedChips($("#describe-types")) } });
    describe.query = got.used; describe.page = 1;
    describeShow(got);
  });
});
$("#describe-query").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#describe-q").value.trim();
  if (!q) return;
  void describeRun(async () => {
    const got = await api(`/api/cards/query?q=${enc(q)}`);
    describe.query = q; describe.page = 1;
    describeShow({ ...got, used: q, explain: "Deine angepasste Suche" });
  });
});
$("#describe-more").addEventListener("click", () => describeRun(async () => {
  const got = await api(`/api/cards/query?q=${enc(describe.query)}&page=${describe.page + 1}`);
  describe.page += 1;
  describeShow(got, { append: true });
}));
$("#describe-grid").addEventListener("click", async (e) => {
  const b = e.target.closest(".similar");
  if (!b || b.classList.contains("picked")) return;
  try {
    if (!edit) setEditing(true);
    const added = await addCard(b.dataset.name, 1);
    b.classList.add("picked");
    b.querySelector(".sim-name").textContent = "✓ " + added;
    renderCards(currentDeck);
    toast(`${added} vorgemerkt – mit „Speichern & prüfen“ übernehmen.`);
  } catch (err) { fail(err); }
});

async function describeSetup() {
  const box = $("#describe-setup");
  box.hidden = false;
  try {
    const cfg = await api("/api/cards/describe/setup");
    $("#describe-model").innerHTML = (cfg.models || []).map((m) => `<option value="${esc(m.id)}"${m.id === cfg.model ? " selected" : ""}>${esc(m.label)} – ${esc(m.cost)}</option>`).join("");
  } catch (err) { $("#describe-hint").textContent = err.message; }
  $("#describe-key").focus();
}
$("#describe-setup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("#describe-key").value.trim();
  if (!key) return;
  try {
    await api("/api/cards/describe/setup", { method: "PUT", body: { key, model: $("#describe-model").value || null } });
    $("#describe-key").value = "";
    $("#describe-setup").hidden = true;
    toast("Suche mit KI eingerichtet", "ok");
    $("#describe-form").requestSubmit();
  } catch (err) { fail(err); }
});
$("#describe-open").addEventListener("click", openDescribe);
$("#describe-close").addEventListener("click", () => $("#describe").close());

// hover preview of card images (list view, hand, swaps); off via Einstellungen → Darstellung
const preview = $("#preview");
let hoverPreview = true;
function applyHoverPreview(on) {
  hoverPreview = on !== false;
  if (!hoverPreview) preview.hidden = true;
}
document.addEventListener("mouseover", (e) => {
  if (!hoverPreview) return;
  const el = e.target.closest(".card[data-img]");
  if (!el || !el.dataset.img || el.closest(".cards.grid")) return;
  const [front, back] = preview.querySelectorAll("img");
  front.src = el.dataset.img;
  back.hidden = back.parentElement.hidden = !el.dataset.imgBack;  // double-faced: both sides side by side
  preview.classList.toggle("foil", !!el.dataset.foil);
  if (el.dataset.imgBack) back.src = el.dataset.imgBack;
  preview.hidden = false;
});
document.addEventListener("mouseout", (e) => { if (e.target.closest(".card[data-img]")) preview.hidden = true; });
document.addEventListener("mousemove", (e) => {
  if (preview.hidden) return;
  const w = preview.querySelector("img.back:not([hidden])") ? 500 : 260;
  const x = e.clientX + w > window.innerWidth ? e.clientX - w : e.clientX + 20;
  const y = Math.min(e.clientY - 40, window.innerHeight - 350);
  preview.style.left = x + "px"; preview.style.top = Math.max(8, y) + "px";
});

// click (or Enter) on a card: large view, both faces for double-faced cards
function openCardFromEvent(e) {
  const el = e.target.closest(".card[data-name]");
  if (!el || !currentDeck) return;
  const act = e.target.closest("[data-act]")?.dataset.act;
  const name = el.dataset.name;
  if (act === "own") return openOwnCopies(name);
  if (edit && act && act !== "view" && el.dataset.maybe) {
    if (act === "unmaybe") removeMaybe(name);
    if (act === "undo-maybe") edit.maybeRemove.delete(name);
    if (act === "to-deck") {
      const cat = edit.maybeAdd.get(name)?.category || (currentDeck.maybe || []).find((m) => m.name === name)?.category || "";
      return addCard(name, 1, cat).then(() => renderCards(currentDeck), fail);
    }
    renderCards(currentDeck);
    return;
  }
  if (edit && act === "maybe") return addMaybe(name).then(() => renderCards(currentDeck), fail);
  if (edit && act && act !== "view") {
    if (act === "cat") return;
    if (act === "plus") setQty(name, currentQty(name) + 1);
    if (act === "minus") setQty(name, currentQty(name) - 1);
    if (act === "remove") setQty(name, 0);
    if (act === "undo") edit.remove.delete(name);
    if (act === "similar") return openSimilar(name);
    renderCards(currentDeck);
    return;
  }
  if (edit && !act) return;  // clicks on the row background in edit mode
  const cdOf = (n) => currentDeck.card_data?.[n] || edit?.add.get(n)?.data || edit?.maybeAdd.get(n)?.data || {};
  const row = e.target.closest(".card[data-name]");
  // arrows step through the list the card is in: the deck, or the maybe list
  const rows = [...$("#cards").querySelectorAll(`.card[data-name]:not(.removed)${row.dataset.maybe ? "[data-maybe]" : ":not([data-maybe])"}`)];
  const copiesOf = (el) => (el.dataset.maybe ? [] : deckCopies(el.dataset.name));
  const list = rows.map((el) => ({ name: el.dataset.name, cd: cdOf(el.dataset.name), copies: copiesOf(el) }));
  showCardView(name, cdOf(name), list, rows.indexOf(row), copiesOf(row));
}
$("#cards").addEventListener("click", openCardFromEvent);
$("#cards").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches(".card[role=button]")) { e.preventDefault(); void openCardFromEvent(e); }
});

let cardViewCard = null;  // { name, cd } of the open card view
let cardViewList = null;  // [{name, cd}] frozen when the view opened
let cardViewIndex = -1;
let cardViewCopies = [];  // the deck's own copies of the open card (Ort = this deck)

function showCardView(name, cd, list, index, copies = []) {
  cardViewCard = { name, cd: cd || {} };
  cardViewList = list || null;
  cardViewIndex = list ? index : -1;
  cardViewCopies = copies || [];
  renderCardViewFaces(0);
  $("#card-view-title").textContent = name + (cd.image_back ? " – doppelseitig" : "");
  $("#card-view-link").href = cd.scryfall_uri || `https://scryfall.com/search?q=${enc('!"' + name + '"')}`;
  const prev = cardViewList && cardViewIndex > 0 ? cardViewList[cardViewIndex - 1] : null;
  const next = cardViewList && cardViewIndex < cardViewList.length - 1 ? cardViewList[cardViewIndex + 1] : null;
  $("#card-view-prev").hidden = !prev;
  $("#card-view-next").hidden = !next;
  $("#card-view-prev").setAttribute("aria-label", prev ? `Vorherige: ${prev.name}` : "Vorherige Karte");
  $("#card-view-next").setAttribute("aria-label", next ? `Nächste: ${next.name}` : "Nächste Karte");
  preview.hidden = true;
  const dlg = $("#card-view");
  if (!dlg.open) dlg.showModal();
  void loadCardText(name);
}
function stepCardView(dir) {
  if (!cardViewList) return;
  const i = cardViewIndex + dir;
  if (i < 0 || i >= cardViewList.length) return;
  const item = cardViewList[i];
  showCardView(item.name, item.cd, cardViewList, i, item.copies);
}

// the faces of the open card: the picked own copy (its printing, foil look) or the default printing
function renderCardViewFaces(pick) {
  const { name, cd } = cardViewCard;
  const copy = cardViewCopies[pick] || null;
  const front = copy?.image || cd.image, back = copy?.image ? copy.image_back : cd.image_back;
  const faces = name.split(" // ");
  const imgs = [[front, faces[0]], ...(back ? [[back, faces[1] || "Rückseite"]] : [])].filter(([u]) => u);
  const big = (u) => u.replace("/normal/", "/large/").replace("/small/", "/large/");
  // each face is a 3D card: front (with the foil sheen and a glare) and the Magic card back behind it
  $("#card-view-faces").innerHTML = imgs.map(([u, label]) =>
    `<figure class="card3d-wrap${copy?.foil ? " foil" : ""}"><div class="card3d" title="Ziehen zum Drehen, Doppelklick dreht um">
      <span class="holo front"><img src="${esc(big(u))}" alt="${esc(label)}" draggable="false">${copy?.foil ? '<span class="foil-sheen" aria-hidden="true"></span>' : ""}<span class="glare" aria-hidden="true"></span></span>
      <span class="holo backside" aria-hidden="true"><img src="${CARD_BACK}" alt="" draggable="false" loading="lazy"></span></div>
      ${imgs.length > 1 ? `<figcaption>${esc(label)}</figcaption>` : ""}</figure>`).join("")
    || '<p class="muted">Kein Bild verfügbar.</p>';
  const box = $("#card-view-copies");
  box.hidden = !cardViewCopies.length;
  if (!cardViewCopies.length) { box.innerHTML = ""; return; }
  const one = (c, i) => `${c.qty > 1 ? `${c.qty}× ` : ""}${copyLabel(c)}`;
  box.innerHTML = cardViewCopies.length === 1
    ? `<span class="muted">Liegt im Deck:</span> ${esc(one(cardViewCopies[0]))}`
    : `<span class="muted">Liegt im Deck:</span> ${cardViewCopies.map((c, i) =>
      `<button type="button" class="chip${i === pick ? " on" : ""}" data-copy="${i}" aria-pressed="${i === pick}">${esc(one(c, i))}</button>`).join("")}`;
}
$("#card-view-copies").addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (b) renderCardViewFaces(Number(b.dataset.copy));
});
// 3D card in the big view: it leans towards the pointer, a drag turns it (let go: it settles on the nearer side),
// a double click turns it over; the foil sheen and the glare follow the angle
const CARD_BACK = "https://backs.scryfall.io/large/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg";
const calmMotion = matchMedia("(prefers-reduced-motion: reduce)");
const card3d = new WeakMap();  // .card3d -> { side: 0|180, rx, ry, drag }
function pose(el, rx, ry, px = 0.5, py = 0.5) {
  const st = card3d.get(el) || { side: 0 };
  st.rx = rx; st.ry = ry;
  card3d.set(el, st);
  el.style.setProperty("--rx", `${rx.toFixed(2)}deg`);
  el.style.setProperty("--ry", `${ry.toFixed(2)}deg`);
  const turn = ((ry % 360) + 540) % 360 - 180;  // -180..180, 0 = front
  const lean = Math.max(-1, Math.min(1, (Math.abs(turn) > 90 ? -1 : 1) * Math.sin((turn * Math.PI) / 180) * 2));
  el.style.setProperty("--mx", `${(50 + lean * 45 + (px - 0.5) * 40).toFixed(1)}%`);
  el.style.setProperty("--my", `${(50 - rx * 2.5 + (py - 0.5) * 40).toFixed(1)}%`);
  el.style.setProperty("--gx", `${(px * 100).toFixed(1)}%`);
  el.style.setProperty("--gy", `${(py * 100).toFixed(1)}%`);
}
function settle(el, side) {
  const st = card3d.get(el) || {};
  st.side = side; st.drag = null;
  el.classList.remove("dragging", "leaning");
  pose(el, 0, side);
}
function flipCard(el) {
  const st = card3d.get(el) || { side: 0 };
  settle(el, (st.side || 0) + 180);
}
const faces3d = $("#card-view-faces");
faces3d.addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".card3d");
  if (!el || e.button !== 0) return;
  e.preventDefault();
  const st = card3d.get(el) || { side: 0, rx: 0, ry: 0 };
  st.drag = { x: e.clientX, y: e.clientY, ry: st.ry ?? st.side, moved: false };
  card3d.set(el, st);
  el.setPointerCapture(e.pointerId);
  el.classList.add("dragging");
});
faces3d.addEventListener("pointermove", (e) => {
  const el = e.target.closest(".card3d");
  if (!el) return;
  const st = card3d.get(el) || { side: 0 };
  const r = el.getBoundingClientRect();
  const px = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), py = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
  if (st.drag) {
    const dx = e.clientX - st.drag.x, dy = e.clientY - st.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) st.drag.moved = true;
    return pose(el, Math.max(-30, Math.min(30, -dy * 0.35)), st.drag.ry + dx * 0.6, px, py);
  }
  if (calmMotion.matches || e.pointerType !== "mouse") return;
  el.classList.add("leaning");
  pose(el, (0.5 - py) * 16, (st.side || 0) + (px - 0.5) * 22, px, py);
});
function endDrag(e) {
  const el = e.target.closest(".card3d");
  const st = el && card3d.get(el);
  if (!st?.drag) return;
  // settle on the side that faces the viewer, a quick flick past 60° turns it over
  const base = st.side || 0, moved = st.ry - base;
  settle(el, Math.abs(moved) > 60 ? base + Math.sign(moved) * 180 * Math.max(1, Math.round(Math.abs(moved) / 180)) : base);
}
faces3d.addEventListener("pointerup", endDrag);
faces3d.addEventListener("pointercancel", endDrag);
faces3d.addEventListener("pointerleave", (e) => {
  for (const el of faces3d.querySelectorAll(".card3d.leaning")) if (!card3d.get(el)?.drag) settle(el, card3d.get(el)?.side || 0);
});
faces3d.addEventListener("dblclick", (e) => { const el = e.target.closest(".card3d"); if (el) flipCard(el); });
$("#card-view-flip").addEventListener("click", () => faces3d.querySelectorAll(".card3d").forEach(flipCard));
$("#card-view-prev").addEventListener("click", () => stepCardView(-1));
$("#card-view-next").addEventListener("click", () => stepCardView(1));
$("#card-view").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.target.closest(".segmented")) return;
  e.preventDefault();
  stepCardView(e.key === "ArrowLeft" ? -1 : 1);
});
$("#card-view-close").addEventListener("click", () => $("#card-view").close());
$("#card-view-order").addEventListener("click", () => {
  if (!cardViewCard) return;
  const { name, cd } = cardViewCard;
  const deck = parseHash().view === "deck" && currentDeck ? currentDeck : null;
  const token = !!cd.token;
  const item = { kind: token ? "token" : "card", name, qty: 1, source: deck ? deck.name : (token ? "Tokens" : "Einzelkarten"),
    ...(deck ? { source_slug: deck.slug } : {}),
    ...(token ? { type_line: cd.type_line || "Token", token_id: /^[0-9a-f-]{36}$/.test(cd.id || "") ? cd.id : null, image: cd.image || null } : {}) };
  void orderDialog({ title: token ? "Token drucken" : "Karte drucken", text: `„${name}“ in eine Sammelbestellung packen.`,
    body: { items: [item] }, qtyField: true });
});

// rules text next to the image: German printed text or English Oracle text, glossary terms marked
const cardTexts = new Map();
let cardViewName = null;
let cardLang = store.get("cardlang") === "en" ? "en" : "de";
document.querySelector(`[name="cardlang"][value="${cardLang}"]`).checked = true;

async function loadCardText(name) {
  cardViewName = name;
  const box = $("#card-view-text");
  box.hidden = false;
  $("#card-view-rules").innerHTML = '<p class="muted small">Kartentext wird geladen …</p>';
  $("#card-view-terms").hidden = true;
  $("#card-view-note").hidden = true;
  $("#card-view-note").textContent = "";
  let data = cardTexts.get(name);
  if (!data) {
    try { data = await api(`/api/cards/text?name=${enc(name)}&lang=de`); cardTexts.set(name, data); }
    catch { data = null; }
  }
  if (cardViewName !== name) return;  // another card was opened meanwhile
  if (!data) { box.hidden = true; return; }
  renderCardText(data);
}

function manaHtml(sym) {
  const s = sym.slice(1, -1);
  const color = /^[WUBRG]$/.test(s) ? s.toLowerCase() : "";
  const label = { T: "↷", Q: "↶" }[s] || s.replace("/", "");
  return `<span class="mana ${color}" title="${esc(sym)}">${esc(label)}</span>`;
}

// escape a rules text, turning {G}-symbols into pills and glossary terms into buttons
function rulesHtml(text, terms) {
  const names = [];
  for (const t of terms) for (const n of [t.term, t.de]) if (n) names.push([n, t.term]);
  names.sort((a, b) => b[0].length - a[0].length);
  const byName = new Map(names.map(([n, t]) => [n.toLowerCase(), t]));
  const alt = names.map(([n]) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`\\{[^}]+\\}` + (alt ? `|(?<![\\p{L}\\d-])(?:${alt})(?![\\p{L}\\d-])` : ""), "giu");
  let out = "", last = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(last, m.index));
    const hit = m[0];
    if (hit.startsWith("{")) out += manaHtml(hit);
    else {
      const term = byName.get(hit.toLowerCase());
      const entry = terms.find((t) => t.term === term);
      out += `<button type="button" class="term" data-term="${esc(term)}" title="${esc(entry?.text || "")}">${esc(hit)}</button>`;
    }
    last = m.index + hit.length;
  }
  return out + esc(text.slice(last));
}

function renderCardText(data) {
  const german = cardLang === "de" && data.printed;
  const faces = german ? data.printed.faces : data.faces;
  $("#card-view-rules").innerHTML = faces.map((f, i) => `<div class="face">
      <div class="head"><span>${esc(f.name)}</span><span>${(data.faces[i]?.mana_cost || "").match(/\{[^{}]{1,12}\}/g)?.map(manaHtml).join("") || ""}</span></div>
      <div class="type">${esc(f.type_line)}</div>
      ${f.text.split("\n").filter(Boolean).map((line) => `<p>${rulesHtml(line, data.terms)}</p>`).join("") || '<p class="muted small">Kein Regeltext.</p>'}
    </div>`).join("")
    + (data.pt && faces.length === 1 ? `<p class="pt">${esc(data.pt)}</p>` : "");
  const note = $("#card-view-note");
  if (cardLang !== "de") { note.hidden = true; note.textContent = ""; }
  else if (!data.printed) { note.hidden = false; note.textContent = "Keine deutsche Ausgabe – englischer Oracle-Text."; }
  else { note.hidden = false; note.textContent = `Drucktext${data.printed.set_name ? " aus " + data.printed.set_name : ""}. Maßgeblich ist der englische Oracle-Text.`; }
  $("#card-view-terms").hidden = !data.terms.length;
  $("#card-view-terms-list").innerHTML = data.terms.map((t) =>
    `<dt data-term="${esc(t.term)}">${esc(t.de || t.term)}${t.de ? ` <span class="de">(${esc(t.term)})</span>` : ""}</dt><dd data-term="${esc(t.term)}">${esc(t.text)}</dd>`).join("");
}

$("#card-view-text").addEventListener("change", (e) => {
  if (e.target.name !== "cardlang") return;
  cardLang = e.target.value;
  store.set("cardlang", cardLang);
  const data = cardTexts.get(cardViewName);
  if (data) renderCardText(data);
});
$("#card-view-rules").addEventListener("click", (e) => {
  const b = e.target.closest(".term");
  if (!b) return;
  for (const el of $$("#card-view-text .on")) el.classList.remove("on");
  for (const el of $$(`#card-view-text [data-term="${CSS.escape(b.dataset.term)}"]`)) el.classList.add("on");
  $(`#card-view-terms-list dt[data-term="${CSS.escape(b.dataset.term)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
});
// ---------- deck actions ----------
$("#copy-btn").addEventListener("click", async () => {
  if (!currentDeck) return;
  try {
    await navigator.clipboard.writeText(currentDeck.export_text);
    toast("Liste kopiert – z. B. in Moxfield oder Archidekt einfügen.");
  } catch { toast("Kopieren nicht erlaubt – der Browser blockiert die Zwischenablage.", "error"); }
});

async function copyAsDeck(version) {
  const name = await ask({
    title: "Als neues Deck kopieren", text: "Die Kopie bekommt einen eigenen Verlauf.",
    value: `${currentDeck.name} (Kopie${version ? " v" + version : ""})`, ok: "Kopieren",
  });
  if (!name) return;
  const r = await api(`/api/decks/${enc(currentDeck.slug)}/copy`, { method: "POST", body: { name, version: version || null } });
  await refreshDeckList();
  toast(`„${name}“ angelegt.`);
  go(`#/deck/${enc(r.slug)}`);
}
$("#duplicate-btn").addEventListener("click", () => currentDeck && copyAsDeck(null).catch(fail));

$("#validate-btn").addEventListener("click", async () => {
  if (!currentDeck) return;
  const slug = currentDeck.slug;
  try {
    await api(`/api/decks/${enc(slug)}/validate`, { method: "POST" });
    currentDeck = null;
    await refreshDeckList();
    await route();
    toast("Deck neu geprüft.");
  } catch (err) { fail(err); }
});

$("#delete-btn").addEventListener("click", async () => {
  if (!currentDeck) return;
  const ok = await ask({ title: `„${currentDeck.name}“ löschen?`, ok: "In den Papierkorb", danger: true,
    text: "Das Deck kommt mit allen Versionen und Partien in den Papierkorb unter den Decks. Bis du ihn leerst, kannst du es zurückholen." });
  if (!ok) return;
  const name = currentDeck.name;
  let r;
  try { r = await api(`/api/decks/${enc(currentDeck.slug)}`, { method: "DELETE" }); } catch (err) { fail(err); return; }
  currentDeck = null;
  await refreshDeckList();
  go("#/new");
  toast(`„${name}“ liegt im Papierkorb.`, "info", 8000, { label: "Rückgängig", run: () => restoreFromTrash(r.trash_id) });
});

// ============================================================================================
// deck check: table rule + the power the deck aims for
// ============================================================================================
function retuneTarget() {
  const form = $("#retune-form");
  return {
    bracket: Number(form.querySelector('[name="rbracket"]:checked')?.value || currentDeck?.bracket || 3),
    tier: form.querySelector('[name="tier"]:checked')?.value || null,
  };
}

function stepTarget(direction) {
  let { bracket, tier } = retuneTarget();
  let idx = bracket * 3 + TIER_ORDER.indexOf(tier || "mid") + direction;
  idx = Math.min(Math.max(idx, 3), 17);
  bracket = Math.floor(idx / 3);
  tier = TIER_ORDER[idx % 3];
  $("#retune-form").querySelector(`[name="rbracket"][value="${bracket}"]`).checked = true;
  $("#retune-form").querySelector(`[name="tier"][value="${tier}"]`).checked = true;
  renderPower(currentDeck);
}
$("#step-up").addEventListener("click", () => stepTarget(+1));
$("#step-down").addEventListener("click", () => stepTarget(-1));
$("#retune-form").addEventListener("change", () => renderPower(currentDeck));

function profileSnapshot(p) {
  p = p || {};
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    tier: p.tier || null,
    max_game_changers: num(p.max_game_changers),
    max_tutors: num(p.max_tutors),
    allow_two_card_combos: p.allow_two_card_combos === false ? false : null,
    allow_extra_turns: p.allow_extra_turns === false ? false : null,
    allow_mass_land_denial: p.allow_mass_land_denial === false ? false : null,
    style: (p.style || "").trim(),
  };
}

function targetDirty(d) {
  if (!d || !$("#retune-form").querySelector('[name="rbracket"]')) return false;
  const bracket = Number($("#retune-form").querySelector('[name="rbracket"]:checked')?.value || d.bracket || 3);
  if (bracket !== (d.bracket || 3)) return true;
  const form = profileSnapshot(readProfile($("#retune-form .profile-fields")) || {});
  return JSON.stringify(form) !== JSON.stringify(profileSnapshot(d.power_profile));
}

function syncSaveButtons() {
  const dirty = targetDirty(currentDeck);
  const edits = !!(edit && editChanges());
  const retune = $("#retune-btn");
  retune.hidden = !dirty;
  retune.classList.toggle("primary", dirty && !edits);
  $("#edit-save").classList.toggle("primary", edits);
}

function renderPower(d) {
  if (!d) return;
  const power = d.validation?.bracket?.power;
  const { bracket, tier } = retuneTarget();
  const goal = bracket + TIER_CENTER[tier || "mid"];
  const pos = (v) => `${((Math.min(Math.max(v, 1), 5.99) - 1) / 5) * 100}%`;
  $("#power-scale").innerHTML = `<div class="track"></div>
    ${[2, 3, 4, 5].map((b) => `<span class="sep" style="left:${pos(b)}"></span>`).join("")}
    ${[1, 2, 3, 4, 5].map((b) => `<span class="tick" style="left:${pos(b + 0.5)}" title="Bracket ${b}">${b}</span>`).join("")}
    ${power ? `<div class="mark now" style="left:${pos(power.value)}" title="Aktuell ${power.value}"></div>` : ""}
    <div class="mark goal" style="left:${pos(goal)}" title="Ziel"></div>`;
  const changed = targetDirty(d);
  $("#power-text").innerHTML = (power
    ? `<span class="legend-bar"></span> Aktuell: <b>${esc(fmtPower(power.value))}</b> · ${esc(power.text)}
       <details class="more"><summary>Wie kommt der Wert zustande?</summary>${esc(power.components.map((c) => `${c.reason} ${c.points > 0 ? "+" : ""}${c.points}`).join(", "))}${power.floor_from_rules ? ` – durch die Regeln mindestens Bracket ${power.floor_from_rules}` : ""}</details>`
    : "Noch keine Power-Einschätzung – „⋯ → Neu prüfen“.<br>")
    + `<span class="legend-dot"></span> Ziel: <b>${esc(levelText(bracket, tier))}</b>${changed ? " – mit „Ziel speichern“ übernehmen" : ""}`;
  syncSaveButtons();
}

// Tempo from the total mana value (speed.py): slow on the left, fast on the right, like the power scale.
function renderSpeed(d) {
  const sp = d?.speed;
  $("#deck-speed").hidden = !sp;
  if (!sp) return;
  const [lo, hi] = sp.scale;
  const pos = (v) => `${((hi - Math.min(Math.max(v, lo), hi)) / (hi - lo)) * 100}%`;
  const bounds = sp.tiers.map((t) => t.max).filter((m) => m != null);
  const eff = sp.effective ?? sp.total;
  const cheaper = eff !== sp.total;
  $("#speed-label").textContent = `${sp.label} · ${eff}`;
  const scale = $("#speed-scale");
  scale.setAttribute("aria-label", `Gesamt-Manawert ${sp.total}${cheaper ? `, effektiv ${eff}` : ""}: ${sp.label}`);
  scale.innerHTML = `<div class="track"></div>
    ${bounds.map((b) => `<span class="sep" style="left:${pos(b)}"></span><span class="tick" style="left:${pos(b)}">${b}</span>`).join("")}
    <span class="tick name lo">langsam</span><span class="tick name hi">schnell</span>
    ${cheaper ? `<div class="mark raw" style="left:${pos(sp.total)}" title="Gedruckt ${sp.total}"></div>` : ""}
    <div class="mark now" style="left:${pos(eff)}" title="Effektiv ${eff}"></div>`;
  const avg = sp.average ? ` (Ø ${fmtNum(sp.average)} je Nicht-Land-Karte)` : "";
  const li = (items) => `<ul class="speed-list">${items.map((t) => `<li>${t}</li>`).join("")}</ul>`;
  const discounts = (sp.discounts || []).map((x) => `<b>${esc(x.name)}</b>: ${fmtNum(x.before)} → ${fmtNum(x.after)} – ${esc(x.why)}`);
  const reducers = (sp.reducers || []).map((r) => `<b>${esc(r.name)}</b> macht ${esc(r.what)} um ${r.amount} billiger: −${fmtNum(r.saved)} an ${r.cards} ${r.cards === 1 ? "Karte" : "Karten"}`);
  $("#speed-text").innerHTML = `${cheaper ? `<span class="muted">Gedruckt ${sp.total}, effektiv ${eff}.</span> ` : ""}${esc(sp.text)}
    <details class="more"><summary>Wie kommt der Wert zustande?</summary>
      Alle Manawerte des Decks zusammengezählt${esc(avg)}: Commander mit, Länder zählen 0, X zählt 0, doppelseitige Karten zählen ihre Vorderseite.
      Je kleiner die Summe, desto früher liegt das Deck auf dem Tisch. Grenzen: ${sp.tiers.map((t) => `${esc(t.label)} ${t.max == null ? `über ${bounds[bounds.length - 1]}` : `bis ${t.max}`}`).join(" · ")}.
      ${discounts.length ? `<br><b>Werden selbst günstiger</b>${li(discounts)}` : ""}
      ${reducers.length ? `<b>Machen andere Karten günstiger</b> (nie unter die farbigen Symbole)${li(reducers)}` : ""}
      ${sp.combo ? `<b>Combo:</b> ${esc(sp.combo.cards.join(" + "))} für zusammen ${fmtNum(sp.combo.mana_value)} Mana${sp.combo_lifted ? " – darum mindestens „Schnell“" : ""}.<br>` : ""}
      ${sp.complete ? "" : `<br><b>Das Deck hat erst ${sp.cards} von 100 Karten</b> – jede weitere Karte macht die Summe größer.`}
      ${sp.exact ? "" : "<br>Ohne Commander geschätzt – „⋯ → Neu prüfen“ rechnet genau."}
    </details>`;
}

$("#retune-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentDeck) return;
  const { bracket } = retuneTarget();
  const profile = readProfile($("#retune-form .profile-fields"));
  const notes = currentDeck.power_profile?.notes;
  const { slug } = currentDeck;
  const btn = $("#retune-btn");
  btn.disabled = true;
  try {
    await api(`/api/decks/${enc(slug)}/target`, { method: "PUT", body: { bracket, profile: profile || notes ? { ...profile, notes: notes || "" } : null } });
    currentDeck = null;
    await refreshDeckList();
    await route();
    toast(`Ziel gespeichert: ${levelText(bracket, profile?.tier)}.`);
  } catch (err) { fail(err); }
  finally { btn.disabled = false; }
});

// ============================================================================================
// Rule 0: one dialog from the deck check, printable as a single sheet
// ============================================================================================
let rule0For = null;
let rule0 = null;
const rule0Rows = (rows) => rows.map((r) => `<dt>${esc(r.label)}</dt><dd${r.flag ? ' class="flag"' : ""}>${esc(r.value)}</dd>`).join("");

async function loadRule0() {
  const slug = currentDeck.slug;
  rule0For = slug;
  try {
    const r = await api(`/api/decks/${enc(slug)}/rule0`);
    if (currentDeck?.slug !== slug) return;
    rule0 = r;
    $("#rule0-full-title").textContent = r.title;
    $("#rule0-full-rows").innerHTML = rule0Rows(r.rows);
    renderSheetTitle(currentDeck);
  } catch (err) {
    rule0For = null;
    rule0 = null;
    $("#rule0-full-rows").innerHTML = `<p class="empty-inline">${esc(err.message)}</p>`;
  }
}
async function openRule0() {
  if (!currentDeck) return;
  const dlg = $("#rule0-full");
  if (!dlg.open) dlg.showModal();
  if (rule0For !== currentDeck.slug || !rule0) {
    $("#rule0-full-title").textContent = "Rule 0";
    $("#rule0-full-rows").innerHTML = `<p class="empty-inline">Lade …</p>`;
    await loadRule0();
  }
}
$("#rule0-open").addEventListener("click", () => openRule0());
$("#rule0-copy").addEventListener("click", async () => {
  if (!rule0) return;
  try { await navigator.clipboard.writeText(rule0.text); toast("Rule-0-Text kopiert."); }
  catch { toast("Kopieren nicht möglich – markiere den Text von Hand.", "error"); }
});
function printRule0() {
  if (!rule0) return;
  document.body.classList.add("print-rule0");
  window.print();
}
window.addEventListener("afterprint", () => document.body.classList.remove("print-rule0"));
$("#rule0-print").addEventListener("click", printRule0);
$("#rule0-full-close").addEventListener("click", () => $("#rule0-full").close());

function renderSheetTitle(d) { $("#sheet-title").textContent = `${d.name} · ${d.commanders.join(" + ")}`; }

// ============================================================================================
// tab "Partien": game log, record and "learn from your games"
// ============================================================================================
let gameData = null;  // { slug, games, stats, learn_focus, issue_labels, result_labels }

async function loadGames(d) {
  renderKnownOpps();
  renderGameForm();
  $("#game-deck-cards").innerHTML = [...d.commanders, ...d.cards.map((c) => c.name)].map((n) => `<option value="${esc(n)}">`).join("");
  try {
    const data = await api(`/api/decks/${enc(d.slug)}/games`);
    if (currentDeck?.slug !== d.slug) return;
    renderGames(d.slug, data);
  } catch { /* the tab shows the empty state */ }
}

function renderGames(slug, data) {
  const first = !gameData;
  gameData = { slug, ...data };
  const formBox = $("#game-form-box");
  if (formBox.dataset.slug !== slug) {
    formBox.dataset.slug = slug;
    resetGameForm();
    formBox.open = !data.games.length;
  }
  if (first || !$("#game-issues").children.length) {
    // the reasons that happen most first; six at a time, the rest behind "mehr …"
    const seen = Object.fromEntries((data.stats.issues || []).map((i) => [i.key, i.count]));
    const keys = Object.keys(data.issue_labels).sort((a, b) => (seen[b] || 0) - (seen[a] || 0));
    $("#game-issues").innerHTML = keys.map((k, i) =>
      `<label${i >= 6 ? " hidden" : ""}><input type="checkbox" name="issues" value="${esc(k)}"><span>${esc(data.issue_labels[k])}</span></label>`).join("")
      + (keys.length > 6 ? '<button type="button" class="chip" id="game-issues-more">mehr …</button>' : "");
  }
  const st = data.stats;
  $("#game-count").textContent = st.games || "";
  $("#game-learn").hidden = !data.learn_focus;
  $("#game-learn").textContent = data.learn_focus ? `${data.learn_focus}.` : "";
  const pct = st.win_rate === null ? "–" : `${Math.round(st.win_rate * 100)} %`;
  const maxIssue = Math.max(1, ...st.issues.map((i) => i.count));
  $("#game-stats").innerHTML = !st.games ? '<p class="empty-inline">Die Bilanz erscheint nach der ersten Partie.</p>' : `
    <div class="kpis"><div><b>${st.games}</b><span>Partien</span></div><div><b>${st.wins}–${st.losses}${st.draws ? "–" + st.draws : ""}</b><span>Siege–Niederlagen</span></div>
      <div><b>${pct}</b><span>Siegquote</span></div><div><b>${st.avg_turn ?? "–"}</b><span>Ø Zug am Ende</span></div></div>
    ${st.issues.length ? `<h3 class="small muted">Häufigste Probleme</h3><ul class="issue-bars">${st.issues.slice(0, 6).map((i) =>
      `<li><span>${esc(i.label)}</span><span class="bar"><i style="width:${(i.count / maxIssue) * 100}%"></i></span><span>${i.count}×</span></li>`).join("")}</ul>` : ""}
    ${st.per_version.length > 1 ? `<p class="game-stats-more">Pro Version: ${st.per_version.map((v) => `v${v.version} ${v.wins}/${v.games}`).join(" · ")}</p>` : ""}
    ${st.mvps.length ? `<p class="game-stats-more">Beste Karten: ${st.mvps.map((m) => `${esc(m.name)}${m.count > 1 ? ` (${m.count}×)` : ""}`).join(", ")}</p>` : ""}
    ${st.opponents.length ? `<p class="game-stats-more">Häufigste Gegner: ${st.opponents.map((o) => esc(o.name)).join(", ")}</p>` : ""}
    ${st.places ? `<p class="game-stats-more">Platzierung: Ø ${fmtNum(st.places.avg)}${st.places.avg_players ? ` bei ${fmtNum(st.places.avg_players)} Spielern` : ""} · ${st.places.counts.map((c) => `${c.count}× ${c.place}. Platz`).join(" · ")}</p>` : ""}
    ${st.rounds ? roundStatsHtml(st.rounds) : ""}`;
  $("#game-empty").hidden = !!data.games.length;
  $("#game-list").innerHTML = data.games.slice().reverse().map((g) => `<li data-id="${esc(g.id)}">
      <div class="when"><span class="res ${esc(g.result)}">${esc(data.result_labels[g.result] || g.result)}</span>${g.place ? `<br><span class="place${g.place === 1 ? " first" : ""}">${esc(g.place)}. Platz</span>` : ""}<br><span class="meta">${esc(fmtDate(g.played))}${g.version ? ` · v${esc(g.version)}` : ""}</span></div>
      <div>${g.opponents.length ? `gegen ${g.opponents.map((o, i) => (g.opponent_ids?.[i] ? `<a href="#/opponents/${enc(g.opponent_ids[i])}">${esc(o)}</a>` : esc(o)) + (g.opponent_places?.[i] ? ` <span class="place${g.opponent_places[i] === 1 ? " first" : ""}">(${esc(g.opponent_places[i])}.)</span>` : "")).join(", ")}` : '<span class="meta">Gegner nicht notiert</span>'}${g.turn ? ` · Zug ${esc(g.turn)}` : ""}${g.how && data.how_labels?.[g.how] ? ` · ${esc(data.how_labels[g.how])}` : ""}
        ${g.started === "me" ? '<br><span class="meta">Ich habe angefangen</span>' : Number.isInteger(g.started) && g.opponents[g.started] ? `<br><span class="meta">Angefangen: ${esc(g.opponents[g.started])}</span>` : ""}
        ${g.mvp ? `<br>Beste Karte: <strong>${esc(g.mvp)}</strong>` : ""}${g.note ? `<br><span class="meta">${esc(g.note)}</span>` : ""}
        ${g.issues.length ? `<div class="issues">${g.issues.map((i) => `<span>${esc(data.issue_labels[i] || i)}</span>`).join("")}</div>` : ""}
        ${g.round_turns ? roundBoxHtml(g.round, g.round_turns) : ""}</div>
      <button type="button" class="icon-btn game-del" aria-label="Partie löschen" title="Partie löschen">${icon("x")}</button></li>`).join("");
}

// rounds counted with Conclave Table (or the phone's former Runden-Helfer): what they say over all games, and one round turn by turn
const cmdShort = (name) => String(name || "").split(",")[0].split(" // ")[0];
function roundStatsHtml(r) {
  const maxLost = Math.max(1, ...r.per_turn.map((t) => t.avg_lost));
  return `<h3 class="small muted round-stats-head">Aus den Runden-Protokollen · ${r.rounds} ${r.rounds === 1 ? "Runde" : "Runden"}</h3>
    ${r.sources.length ? `<p class="game-stats-more">Am meisten Schaden: ${r.sources.slice(0, 3).map((x) => `<strong>${esc(cmdShort(x.name))}</strong> ${x.damage}${x.cmd ? ` (${x.cmd} Commander-Schaden)` : ""}${r.rounds > 1 ? ` in ${x.rounds} ${x.rounds === 1 ? "Runde" : "Runden"}` : ""}`).join(" · ")}</p>` : ""}
    ${r.per_turn.some((t) => t.avg_lost) ? `<p class="game-stats-more">Leben verloren pro eigenem Zug${r.rounds > 1 ? " (Schnitt)" : ""}:</p>
      <ul class="issue-bars turn-bars">${r.per_turn.slice(0, 10).map((t) => `<li${r.worst_turn?.turn === t.turn ? ' class="worst"' : ""}><span>Zug ${t.turn}</span><span class="bar"><i style="width:${(t.avg_lost / maxLost) * 100}%"></i></span><span>${t.avg_lost ? "−" + fmtNum(t.avg_lost) : "0"}</span></li>`).join("")}</ul>` : ""}
    ${r.avg_end_life !== null ? `<p class="game-stats-more">Leben am Ende${r.rounds > 1 ? " im Schnitt" : ""}: ${fmtNum(r.avg_end_life)}${r.poison_rounds ? ` · Gift in ${r.poison_rounds} ${r.poison_rounds === 1 ? "Runde" : "Runden"}` : ""}</p>` : ""}`;
}

function roundBoxHtml(r, turns) {
  const mins = r.started && r.ended ? Math.max(0, Math.round((new Date(r.ended) - new Date(r.started)) / 60000)) : null;
  const pts = [r.start_life, ...turns.map((t) => t.life)];
  const W = 300, H = 56, max = Math.max(...pts, 1), min = Math.min(0, ...pts);
  const spark = pts.length > 2 ? `<svg class="round-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Leben pro Zug: ${pts.join(", ")}">
    <polyline points="${pts.map((v, i) => `${((i / (pts.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - min) / (max - min || 1)) * (H - 8)).toFixed(1)}`).join(" ")}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>` : "";
  const cmd = (r.cmd || []).filter((c) => c.dmg).sort((a, b) => b.dmg - a.dmg);
  return `<details class="more round-box"><summary>Runde ansehen <span class="muted">· ${esc(r.life ?? "–")} Leben am Ende · ${turns.length} ${turns.length === 1 ? "Zug" : "Züge"}${mins !== null ? ` · ${mins} Min.` : ""}</span></summary>
    <div class="round-head">${spark}
      <div class="round-facts"><span>Start <b>${esc(r.start_life)}</b></span><span>Ende <b>${esc(r.life ?? "–")}</b></span>${r.poison ? `<span>Gift <b>${esc(r.poison)}</b></span>` : ""}
        ${cmd.map((c) => `<span>${esc(cmdShort(c.name))} <b>${esc(c.dmg)}</b>/21</span>`).join("")}</div></div>
    <table class="round-turns"><thead><tr><th>Zug</th><th>Leben</th><th>Was passiert ist</th></tr></thead><tbody>
      ${turns.slice().reverse().map((t) => `<tr><td>${t.turn}</td><td><b>${t.life}</b>${t.lost || t.gained ? ` <span class="${t.lost > t.gained ? "down" : "up"}">${t.lost > t.gained ? "−" + (t.lost - t.gained) : "+" + (t.gained - t.lost)}</span>` : ""}</td>
        <td>${t.events.length ? t.events.map(esc).join(" · ") : '<span class="muted">nichts</span>'}${t.notes.map((n) => `<br><em>${esc(n)}</em>`).join("")}</td></tr>`).join("")}
    </tbody></table></details>`;
}

// ---------- the game form, like the phone's game sheet: result, opponents as chips, places, the rest folded away ----------
const GAME_OPPS_MAX = 5;
let gameOpps = [];  // [{name, id, note, place, image}]
let gameMe = null;  // my finishing place

function resetGameForm() {
  $("#game-form").reset();
  gameOpps = []; gameMe = null;
  renderGameForm();
}
const commanderArt = (url) => (url ? url.replace("/normal/", "/art_crop/") : "");

function addGameOpp(name, id = null) {
  name = name.trim();
  if (!name) return;
  if (gameOpps.some((o) => (id && o.id === id) || o.name.toLowerCase() === name.toLowerCase())) return;
  if (gameOpps.length >= GAME_OPPS_MAX) { toast(`Höchstens ${GAME_OPPS_MAX} Gegner.`, "error"); return; }
  const known = id ? oppIndex.find((o) => o.id === id) : oppIndex.find((o) => o.commanders.some((c) => c.toLowerCase() === name.toLowerCase()));
  const o = { name, id: known?.id || null, note: "", place: null, image: commanderArt(known?.image) };
  gameOpps.push(o);
  if (!o.image) void api(`/api/card?name=${enc(name)}`).then((c) => { o.image = commanderArt(c.image); renderGameForm(); }).catch(() => {});
  renderGameForm();
}

function renderGameForm() {
  const form = $("#game-form");
  const result = form.elements.result.value;
  // opponents
  $("#game-opps").innerHTML = gameOpps.map((o, i) => `<span class="gf-opp" role="listitem">${o.image ? `<img src="${esc(o.image)}" alt="">` : '<i aria-hidden="true"></i>'}
      <span>${esc(o.name)}</span><button type="button" class="icon-btn" data-remove="${i}" aria-label="${esc(o.name)} entfernen">${icon("x")}</button></span>`).join("");
  $("#game-opp-add").hidden = gameOpps.length >= GAME_OPPS_MAX;
  const known = $$("#game-known-opps button[data-oid]");
  for (const b of known) b.hidden = gameOpps.some((o) => o.id === b.dataset.oid);
  $("#game-known-opps").hidden = !known.some((b) => !b.hidden);
  // places: me + the opponents, 1..N
  const n = 1 + gameOpps.length;
  if (gameMe > n) gameMe = null;
  for (const o of gameOpps) if (o.place > n) o.place = null;
  const rows = [{ who: "me", name: "Ich", place: gameMe }, ...gameOpps.map((o, i) => ({ who: String(i), name: o.name, place: o.place }))];
  $("#game-places-box").hidden = n < 2;
  $("#game-places").innerHTML = n < 2 ? "" : rows.map((r) => `<div class="place-row${r.place === 1 ? " first" : ""}" data-who="${r.who}">
      <span class="place-name">${esc(r.name)}${r.place === 1 ? ` <span class="first-label">${icon("trophy")}Gewinner</span>` : ""}</span>
      <span class="place-pick" role="radiogroup" aria-label="Platz: ${esc(r.name)}">${Array.from({ length: n }, (_, k) => k + 1).map((x) =>
        `<button type="button" role="radio" data-place="${x}" aria-checked="${r.place === x}" aria-label="${x}. Platz">${x}</button>`).join("")}</span>
    </div>`).join("");
  // what went wrong: only after a loss or a draw
  $("#game-issues-box").hidden = !(result === "loss" || result === "draw");
  // notes per opponent (under "Mehr Details")
  const notes = $("#game-opp-notes");
  const typing = notes.contains(document.activeElement);
  if (!typing) {
    notes.innerHTML = gameOpps.map((o, i) => `<label class="field"><span>Aufgefallen bei ${esc(o.name)}</span>
      <input data-note="${i}" value="${esc(o.note)}" placeholder="z. B. Combo mit Thassa's Oracle"></label>`).join("");
  }
  // the one primary button names what gets saved
  const label = { win: "Sieg speichern", loss: "Niederlage speichern", draw: "Unentschieden speichern" }[result] || "Partie speichern";
  $("#game-save").textContent = label;
  $("#game-save").disabled = !result;
  $("#game-save-hint").hidden = !!result;
  const els = form.elements;
  const howLabel = $(`#game-how input:checked + span`)?.textContent || "";
  $("#game-more-sum").textContent = [els.turn.value ? `Zug ${els.turn.value}` : "", howLabel, els.mvp.value.trim(), els.note.value.trim() ? "Notiz" : ""].filter(Boolean).join(" · ");
}

// a place (the same again clears it); the last open player gets the place left; my 1st place = win, later = loss
function setGamePlace(who, place) {
  const get = (w) => (w === "me" ? gameMe : gameOpps[Number(w)].place);
  const set = (w, v) => { if (w === "me") gameMe = v; else gameOpps[Number(w)].place = v; };
  set(who, get(who) === place ? null : place);
  const all = ["me", ...gameOpps.map((_, i) => String(i))];
  const open = all.filter((w) => !get(w));
  const taken = new Set(all.map(get).filter(Boolean));
  if (get(who) && open.length === 1 && taken.size === all.length - 1) set(open[0], all.map((_, i) => i + 1).find((x) => !taken.has(x)));
  const els = $("#game-form").elements;
  if (gameMe === 1) els.result.value = "win";
  else if (gameMe && els.result.value !== "draw") els.result.value = "loss";
}

wireAutocomplete($("#game-opp-input"), $("#ac-game-opp"));
const addTypedOpp = () => { const input = $("#game-opp-input"); addGameOpp(input.value); input.value = ""; input.focus(); };
$("#game-opp-btn").addEventListener("click", addTypedOpp);
$("#game-opp-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTypedOpp(); } });
$("#game-opps").addEventListener("click", (e) => {
  const b = e.target.closest("[data-remove]");
  if (!b) return;
  gameOpps.splice(Number(b.dataset.remove), 1);
  renderGameForm();
});
$("#game-places").addEventListener("click", (e) => {
  const b = e.target.closest("[data-place]");
  if (!b) return;
  setGamePlace(b.closest("[data-who]").dataset.who, Number(b.dataset.place));
  renderGameForm();
});
$("#game-issues").addEventListener("click", (e) => {
  if (e.target.id !== "game-issues-more") return;
  for (const l of $$("#game-issues label")) l.hidden = false;
  e.target.remove();
});
$("#game-opp-notes").addEventListener("input", (e) => { if (e.target.dataset.note) gameOpps[Number(e.target.dataset.note)].note = e.target.value; });
// a picked "how" can be taken back by clicking it again
$("#game-how").addEventListener("click", (e) => {
  const input = e.target.closest("label")?.querySelector("input");
  if (input?.checked && e.target.tagName === "SPAN") { e.preventDefault(); input.checked = false; renderGameForm(); }
});
$("#game-form").addEventListener("input", (e) => { if (["turn", "mvp", "note"].includes(e.target.name)) renderGameForm(); });
$("#game-form").addEventListener("change", (e) => {
  if (e.target.name === "result") {
    if (e.target.value === "win" && !gameMe && gameOpps.length) gameMe = 1;
    if (e.target.value === "loss" && gameMe === 1) gameMe = null;
  }
  renderGameForm();
});

$("#game-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentDeck) return;
  const f = new FormData(e.target);
  const body = {
    result: f.get("result"), turn: f.get("turn") ? Number(f.get("turn")) : null, mvp: f.get("mvp") || null,
    opponents: gameOpps.map((o) => o.name), opponent_ids: gameOpps.map((o) => o.id), opponent_notes: gameOpps.map((o) => o.note.trim()),
    remember_opponents: !!f.get("remember_opponents"), issues: f.getAll("issues"), note: f.get("note") || "", how: f.get("how") || null,
    place: gameOpps.length ? gameMe : null, opponent_places: gameOpps.map((o) => o.place),
  };
  if (body.result === "win") body.issues = [];
  const slug = currentDeck.slug;
  try {
    const data = await api(`/api/decks/${enc(slug)}/games`, { method: "POST", body });
    resetGameForm();
    if (currentDeck?.slug === slug) renderGames(slug, data);
    if (body.opponents.length) void refreshOpponents().then(renderKnownOpps);
    toast(body.result === "win" ? "Sieg gespeichert – Glückwunsch!" : "Partie gespeichert.");
  } catch (err) { fail(err); }
});
$("#game-list").addEventListener("click", async (e) => {
  const b = e.target.closest(".game-del");
  if (!b || !currentDeck) return;
  if (!(await ask({ title: "Partie löschen?", ok: "Löschen", danger: true }))) return;
  const slug = currentDeck.slug;
  try { renderGames(slug, await api(`/api/decks/${enc(slug)}/games/${enc(b.closest("li").dataset.id)}`, { method: "DELETE" })); }
  catch (err) { fail(err); }
});

// ============================================================================================
// tab "Verlauf": versions, diffs, restore, copy
// ============================================================================================
let versions = [];

async function renderHistory(d) {
  versions = await api(`/api/decks/${enc(d.slug)}/versions`).catch(() => []);
  if (currentDeck?.slug !== d.slug) return;
  $("#version-count").textContent = versions.length > 1 ? versions.length : "";
  $("#compare-result").hidden = true;
  const cur = (d.currency || "eur").toUpperCase();
  $("#history").innerHTML = versions.length ? versions.slice().reverse().map((h) => `<li>
    <div class="vhead">
      <span class="vnum">${h.version ? "v" + h.version : "–"}</span>
      ${h.current ? '<span class="pill ok">aktuell</span>' : ""}
      <span class="when">${esc(fmtDate(h.at))}</span>
      <span class="muted small">${h.from && h.from !== h.to ? `${esc(h.from)} → ` : ""}${esc(h.to || "")}
        · ${esc(fmtPrice(h.price, cur))} · Power ${esc(fmtPower(h.power))}</span>
    </div>
    ${h.note ? `<div>${esc(h.note)}</div>` : ""}
    ${h.added?.length ? `<div class="plus">+ ${esc(h.added.join(", "))}</div>` : ""}
    ${h.removed?.length ? `<div class="minus">− ${esc(h.removed.join(", "))}</div>` : ""}
    ${h.version ? `<div class="vactions">
      ${!h.current ? `<button type="button" class="btn small" data-act="diff" data-v="${h.version}">Mit aktuell vergleichen</button>` : ""}
      ${h.restorable && !h.current ? `<button type="button" class="btn small" data-act="restore" data-v="${h.version}">Wiederherstellen</button>` : ""}
      ${h.restorable ? `<button type="button" class="btn small ghost" data-act="copy" data-v="${h.version}">Als neues Deck</button>` : ""}
      ${h.restorable ? `<button type="button" class="btn small ghost" data-act="text" data-v="${h.version}">Liste kopieren</button>` : ""}
    </div>` : ""}
  </li>`).join("") : '<li class="empty-inline">Noch keine Versionen – jede gespeicherte Änderung legt eine an.</li>';
  const opts = versions.filter((h) => h.restorable).map((h) => `<option value="${h.version}">v${h.version}${h.current ? " (aktuell)" : ""}</option>`).join("");
  const form = $("#compare-form").elements;
  form.a.innerHTML = opts;
  form.b.innerHTML = opts;
  const n = versions.filter((h) => h.restorable).length;
  if (n > 1) form.a.selectedIndex = n - 2;
  form.b.selectedIndex = n - 1;
  $("#compare-form").hidden = n < 2;
}

async function showDiff(a, b) {
  const r = await api(`/api/decks/${enc(currentDeck.slug)}/diff?a=${a}${b ? `&b=${b}` : ""}`);
  const box = $("#compare-result");
  const delta = (x, f) => (x.from === x.to || x.from == null || x.to == null ? esc(f(x.to)) : `${esc(f(x.from))} → <b>${esc(f(x.to))}</b>`);
  box.innerHTML = `<b>v${r.from_version} → v${r.to_version}</b>
    <dl class="kv">
      <dt>Stufe</dt><dd>${r.level.from === r.level.to ? esc(r.level.to) : `${esc(r.level.from)} → <b>${esc(r.level.to)}</b>`}</dd>
      <dt>Power</dt><dd>${delta(r.power, fmtPower)}</dd>
      <dt>Preis</dt><dd>${delta(r.price, (v) => fmtPrice(v, (currentDeck.currency || "eur").toUpperCase()))}</dd>
      <dt>Rein (${r.added.length})</dt><dd class="plus">${esc(r.added.join(", ") || "–")}</dd>
      <dt>Raus (${r.removed.length})</dt><dd class="minus">${esc(r.removed.join(", ") || "–")}</dd>
    </dl>`;
  box.hidden = false;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("#compare-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target.elements;
  showDiff(f.a.value, f.b.value).catch(fail);
});

$("#history").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !currentDeck) return;
  const v = Number(btn.dataset.v);
  try {
    if (btn.dataset.act === "diff") await showDiff(v);
    if (btn.dataset.act === "copy") await copyAsDeck(v);
    if (btn.dataset.act === "text") {
      const snap = await api(`/api/decks/${enc(currentDeck.slug)}/versions/${v}`);
      await navigator.clipboard.writeText(snap.export_text);
      toast(`Liste von v${v} kopiert.`);
    }
    if (btn.dataset.act === "restore") {
      const ok = await ask({ title: `Version ${v} wiederherstellen?`, text: "Sie wird als neue Version gespeichert – nichts geht verloren.", ok: "Wiederherstellen" });
      if (!ok) return;
      await api(`/api/decks/${enc(currentDeck.slug)}/versions/${v}/restore`, { method: "POST" });
      currentDeck = null;
      await refreshDeckList();
      await route();
      toast(`Version ${v} wiederhergestellt.`);
    }
  } catch (err) { fail(err); }
});

// ============================================================================================
// tab "Drucken": print studio (MPC Autofill, PDF)
// ============================================================================================
let printPlan = null;
let currentOrder = null;  // the open collective order (page #/orders/<id>)
// what the print studio works on: the open deck or a collective order (same print routes, slug sammel-<id>)
function pctx() {
  if (parseHash().view === "orders" && currentOrder) {
    return { slug: currentOrder.slug, name: currentOrder.name, route: `#/orders/${enc(currentOrder.id)}`, order: true };
  }
  return currentDeck ? { slug: currentDeck.slug, name: currentDeck.name, route: `#/deck/${enc(currentDeck.slug)}/drucken`, order: false } : null;
}
// the print studio is one block that moves into the deck tab or the order page
function mountPrintStudio(slot) {
  const studio = $("#print-studio");
  if (studio.parentElement !== $(slot)) $(slot).appendChild(studio);
  for (const el of $$("#print-form .token-opt")) el.hidden = !!pctx()?.order;  // orders list their tokens explicitly
}
let prepared = { faces: {} };
const printOpts = () => {
  const f = $("#print-form").elements;
  return { source: f.source.value, stock: f.stock.value, foil: f.foil.checked, upscale: f.upscale.checked,
    only_missing: !f.only_missing.closest("[hidden]") && f.only_missing.checked,
    tokens: f.tokens.checked ? Math.min(20, Math.max(1, Number(f.token_copies.value) || 1)) : 0 };
};
$("#print-form").addEventListener("submit", (e) => e.preventDefault());
$("#print-form").addEventListener("change", (e) => {
  const name = e.target.name;
  if (!["source", "stock", "foil", "upscale", "only_missing", "tokens", "token_copies"].includes(name)) return;
  if (name === "token_copies" && !$("#print-form").elements.tokens.checked) return;
  void loadPlan();
});
const planQuery = () => { const o = printOpts(); return new URLSearchParams({ source: o.source, only_missing: o.only_missing, tokens: o.tokens }).toString(); };

async function loadPlan() {
  $("#print-summary").textContent = "Lade Vorschau …";
  $("#print-grid").innerHTML = "";
  $("#print-tokens").hidden = true;  // the old list may belong to another deck/order
  $("#print-token-list").innerHTML = "";
  const slug = pctx().slug;
  try {
    [printPlan, prepared] = await Promise.all([
      api(`/api/decks/${enc(slug)}/print/plan?${planQuery()}`),
      api(`/api/decks/${enc(slug)}/print/prepared`),
    ]);
  } catch (err) { $("#print-summary").textContent = err.message; return; }
  if (pctx()?.slug !== slug) return;
  renderPlan();
  renderPreparedInfo();
  void updateDownloadLinks();
}

function renderPreparedInfo() {
  const faces = Object.values(prepared.faces || {});
  const has = faces.length > 0;
  $("#open-folder-btn").hidden = !has;
  $("#prepared-info").hidden = !has;
  if (!has) return;
  const ai = faces.filter((f) => f.upscaled).length;
  $("#prepared-info").innerHTML = `${icon("check")} ${faces.length} Druckbilder in <code>${esc(prepared.images_dir)}</code>`
    + (ai ? ` · ${ai} KI-hochskaliert (${esc(prepared.upscale_model)}${prepared.descreen && prepared.descreen !== "off" ? ", Druckraster entfernt: " + esc(prepared.descreen) : ""})` : "")
    + " · 🔍 auf einer Karte zeigt Vorher/Nachher.";
}

function originTag(img) {
  if (!img) return "";
  if (img.origin === "local") return '<span class="tag own">eigenes Bild</span>';
  if (img.custom) return '<span class="tag own">eigene Wahl</span>';
  return img.origin === "mpcfill" ? '<span class="tag mpc">MPC</span>' : '<span class="tag">Scryfall</span>';
}

function renderPlan() {
  renderPlanSummary();
  renderTokenList();
  $("#print-grid").innerHTML = printPlan.cards.map((c, i) => cardTile(c, i, "front")).join("");
}

// tokens: artwork + copies per token (stored per deck; collective orders keep theirs in the order items)
function tokenRow(c, i) {
  const img = c.front?.image;
  const from = (c.from || []).slice(0, 3).join(", ") + ((c.from || []).length > 3 ? " …" : "");
  const editable = !pctx()?.order;
  return `<li data-i="${i}" class="${c.qty === 0 ? "off" : ""}">
    <button type="button" class="tok-art" data-pick="${i}" title="Artwork für ${esc(c.name)} wählen" aria-label="Artwork für ${esc(c.name)} wählen">
      ${img ? `<img src="${esc(img.thumb)}" alt="" loading="lazy">` : '<span class="noimg">kein Bild</span>'}</button>
    <div class="tok-info"><b>${esc(c.name)}</b>
      <span class="muted small">${esc(tokenKind(c.type_line))}${from ? ` · von ${esc(from)}` : ""}</span></div>
    <div class="tok-controls">${originTag(img)}
    ${editable ? `<div class="stepper" role="group" aria-label="Anzahl ${esc(c.name)}">
        <button type="button" class="btn small" data-step="-1" aria-label="Eins weniger"${c.qty <= 0 ? " disabled" : ""}>−</button>
        <input type="number" min="0" max="99" value="${c.qty}" inputmode="numeric" aria-label="Anzahl ${esc(c.name)}">
        <button type="button" class="btn small" data-step="1" aria-label="Eins mehr"${c.qty >= 99 ? " disabled" : ""}>+</button></div>
      <button type="button" class="link-btn tok-reset" data-reset${c.qty_custom ? "" : " hidden"}>↺ Standard (${c.default_qty})</button>`
    : `<span class="muted small">${c.qty}× laut Bestellung</span>`}</div>
  </li>`;
}
// "Token Creature — Human" stays, emblems too; markers like The Monarch (type "Card") are called Marker
const tokenKind = (tl) => (/^(Token|Emblem)/.test(tl || "Token") ? tl || "Token" : "Marker");
function renderTokenList() {
  const toks = printPlan.cards.map((c, i) => [c, i]).filter(([c]) => c.token);
  $("#print-tokens").hidden = !toks.length;
  $("#print-token-list").innerHTML = toks.map(([c, i]) => tokenRow(c, i)).join("");
  updateTokenCount();
}
function updateTokenCount() {
  const toks = printPlan.cards.filter((c) => c.token);
  const n = toks.reduce((sum, c) => sum + c.qty, 0);
  $("#print-tokens-count").textContent = `· ${toks.length} verschiedene, ${n} ${n === 1 ? "Karte" : "Karten"}`;
}
const tokenSaveTimers = {};
function setTokenQty(li, qty, delay = 450) {
  const i = Number(li.dataset.i);
  const v = Math.max(0, Math.min(99, Math.round(Number(qty))));
  if (!Number.isFinite(v)) return;
  const input = li.querySelector("input");
  if (Number(input.value) !== v) input.value = v;
  printPlan.cards[i].qty = v;  // show it right away, save a moment later
  li.classList.toggle("off", v === 0);
  li.querySelector('[data-step="-1"]').disabled = v <= 0;
  li.querySelector('[data-step="1"]').disabled = v >= 99;
  updateTokenCount();
  clearTimeout(tokenSaveTimers[i]);
  tokenSaveTimers[i] = setTimeout(() => saveTokenQty(i, v), delay);
}
async function saveTokenQty(i, qty) {
  const slug = pctx().slug, face = printPlan.cards[i].front.face;
  try {
    await api(`/api/decks/${enc(slug)}/print/token-qty`, { method: "POST", body: { counts: { [face]: qty } } });
    const plan = await api(`/api/decks/${enc(slug)}/print/plan?${planQuery()}`);
    if (pctx()?.slug !== slug) return;
    printPlan = plan;
    renderPlanSummary();
    updateTokenCount();
    const j = plan.cards.findIndex((c) => c.token && c.front.face === face);
    const li = $(`#print-token-list li[data-i="${i}"]`);
    if (j < 0 || !li) { renderPlan(); return; }
    const c = plan.cards[j];
    const input = li.querySelector("input");
    if (document.activeElement !== input) input.value = c.qty;  // never overwrite what is being typed
    li.classList.toggle("off", c.qty === 0);
    const reset = li.querySelector("[data-reset]");
    reset.hidden = !c.qty_custom;
    reset.textContent = `↺ Standard (${c.default_qty})`;
    const tile = $(`#print-grid .pcard[data-i="${j}"]`);
    if (tile) tile.outerHTML = cardTile(c, j, "front");
    if (Object.keys(prepared.faces || {}).length && !$("#prepared-info .stale")) {
      $("#prepared-info").insertAdjacentHTML("beforeend", ' <span class="warn stale">· Token-Anzahl geändert – „Vorbereiten“ erneut ausführen.</span>');
    }
  } catch (err) { fail(err); }
}
$("#print-token-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  if (e.target.closest("[data-pick]")) { void openPicker(Number(li.dataset.i), "front"); return; }
  const step = e.target.closest("[data-step]");
  if (step) { setTokenQty(li, Number(li.querySelector("input").value) + Number(step.dataset.step)); return; }
  if (e.target.closest("[data-reset]")) {
    clearTimeout(tokenSaveTimers[li.dataset.i]);
    const c = printPlan.cards[Number(li.dataset.i)];
    li.querySelector("input").value = c.default_qty;
    void saveTokenQty(Number(li.dataset.i), null);
  }
});
$("#print-token-list").addEventListener("input", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li && e.target.matches("input") && e.target.value !== "") setTokenQty(li, e.target.value, 700);
});
$("#print-token-list").addEventListener("change", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li && e.target.matches("input")) setTokenQty(li, e.target.value === "" ? 0 : e.target.value, 0);
});

function renderPlanSummary() {
  const p = printPlan;
  const imgs = p.cards.flatMap((c) => [c.front?.image, c.back?.image]).filter(Boolean);
  const mpc = imgs.filter((i) => i.origin === "mpcfill").length;
  $("#print-summary").innerHTML = `${p.quantity} Karten · MPC-Staffel ${p.mpc_bracket} · ${mpc} MPC-Autofill-Scans, ${imgs.length - mpc} Scryfall`
    + ` · ${p.cards.filter((c) => c.back).length} doppelseitig`
    + (p.server ? "" : ' · <span class="warn">kein MPC-Autofill-Server eingestellt (nur Scryfall)</span>')
    + (p.missing.length ? ` · <span class="bad">ohne Bild: ${esc(p.missing.join(", "))}</span>` : "")
    + (p.warnings.length ? `<br><span class="warn">${esc(p.warnings.join(" "))}</span>` : "");
  const tiles = imgs.length + p.missing.length;
  $("#print-grid-count").textContent = `· ${tiles} Bilder` + (p.missing.length ? ` · ${p.missing.length} ohne Bild` : "");
  if (p.missing.length) $("#print-grid-box").open = true;  // something needs attention: show the images
}

function cardTile(c, i, side) {
  const f = c[side];
  const img = f?.image;
  return `<button type="button" class="pcard${c.token && c.qty === 0 ? " off" : ""}" data-i="${i}" data-side="${side}" title="${esc(c.name)} – Bild wählen">
    ${img ? `<img src="${esc(img.thumb)}" alt="${esc(f.face)}" loading="lazy">` : `<div class="noimg">${esc(c.name)}<br>kein Bild</div>`}
    <div class="tags">${c.token && c.qty === 0 ? '<span class="tag off">nicht drucken</span>' : ""}${c.qty > 1 ? `<span class="tag">${c.qty}×</span>` : ""}${c.commander ? '<span class="tag">Commander</span>' : ""}${c.token ? '<span class="tag tok">Token</span>' : ""}${c.back ? '<span class="tag dfc" title="Doppelseitige Karte – ↻ dreht sie um">DFC</span>' : ""}${originTag(img)}${f && prepared.faces?.[f.face]?.upscaled ? '<span class="tag ai">KI</span>' : ""}</div>
    ${c.back ? `<span class="flip" data-flip="${i}" title="${side === "front" ? "Rückseite zeigen" : "Vorderseite zeigen"}" aria-label="Karte umdrehen">↻</span>` : ""}
    ${f && prepared.faces?.[f.face] ? `<span class="zoom" data-compare="${esc(f.face)}" title="Vorher/Nachher vergleichen">🔍 ${prepared.faces[f.face].dpi ? esc(prepared.faces[f.face].dpi) + " DPI" : ""}</span>` : ""}
    <div class="cap">${esc(f?.face || c.name)}${c.back ? `<span class="muted"> · ${side === "front" ? "Vorderseite" : "Rückseite"}</span>` : ""}</div>
  </button>`;
}

$("#print-grid").addEventListener("click", (e) => {
  const cmp = e.target.closest("[data-compare]");
  if (cmp) { openCompare(cmp.dataset.compare); return; }
  const flip = e.target.closest("[data-flip]");
  const tile = e.target.closest(".pcard");
  if (!tile) return;
  const i = Number(tile.dataset.i);
  if (flip) {
    const side = tile.dataset.side === "front" ? "back" : "front";
    tile.outerHTML = cardTile(printPlan.cards[i], i, side);
    return;
  }
  void openPicker(i, tile.dataset.side);
});

// image picker: MPC Autofill scans + every Scryfall printing, loaded page by page (175 per page)
let pickerCtx = null;
async function openPicker(i, side) {
  const c = printPlan.cards[i];
  pickerCtx = { i, card: c, side, face: c[side].face, token: !!c.token, options: [], page: 0, hasMore: true, total: 0, loading: false };
  $("#picker-title").textContent = `${c[side].face}${side === "back" ? " (Rückseite)" : ""}`;
  $("#picker-filter").value = "";
  $("#picker-hint").textContent = "Lade Bilder von MPC Autofill und die Scryfall-Drucke …";
  $("#picker-grid").innerHTML = "";
  $("#picker-more").hidden = true;
  $("#picker").showModal();
  await loadPickerPage();
}

async function loadPickerPage() {
  const ctx = pickerCtx;
  if (!ctx || ctx.loading || !ctx.hasMore) return;
  ctx.loading = true;
  $("#picker-more-btn").disabled = $("#picker-all-btn").disabled = true;
  try {
    const r = await api(`/api/decks/${enc(pctx().slug)}/print/alternatives?card=${enc(ctx.card.name)}&side=${ctx.side}&token=${ctx.token}&page=${ctx.page + 1}`);
    if (pickerCtx !== ctx) return;
    ctx.options.push(...r.options);
    ctx.page = r.page;
    ctx.hasMore = r.has_more;
    ctx.total = r.scryfall_total;
    renderPicker();
  } catch (err) { $("#picker-hint").textContent = err.message; }
  finally { ctx.loading = false; $("#picker-more-btn").disabled = $("#picker-all-btn").disabled = false; }
}

function renderPicker() {
  const ctx = pickerCtx;
  const q = $("#picker-filter").value.trim().toLowerCase();
  const current = ctx.card[ctx.side].image?.id;
  const mpc = ctx.options.filter((o) => o.origin === "mpcfill").length;
  const own = ctx.options.filter((o) => o.origin === "local").length;
  const scry = ctx.options.length - mpc - own;
  const shown = ctx.options.map((o, k) => [o, k]).filter(([o]) => !q || `${o.label || ""} ${o.released || ""} ${o.dpi || ""}`.toLowerCase().includes(q));
  $("#picker-hint").textContent = `${own ? `${own} eigene${own === 1 ? "s Bild" : " Bilder"} · ` : ""}${mpc ? `${mpc} MPC-Autofill-Scans (druckoptimiert) · ` : ""}${scry} von ${ctx.total} Scryfall-Drucken geladen`
    + (q ? ` · ${shown.length} passen zum Filter` : "") + (ctx.hasMore && q ? " – „Alle laden“ durchsucht alle Drucke" : "");
  $("#picker-grid").innerHTML = shown.map(([o, k]) => `<button type="button" class="pcard ${o.id === current ? "selected" : ""}" data-k="${k}">
    <img src="${esc(o.thumb)}" alt="" loading="lazy">
    ${o.upload ? `<span class="del" data-del="${esc(o.upload)}" title="Eigenes Bild löschen" aria-label="Eigenes Bild löschen">✕</span>` : ""}
    <div class="tags">${o.origin === "local" ? '<span class="tag own">eigenes Bild</span>' : o.origin === "mpcfill" ? '<span class="tag mpc">MPC</span>' : '<span class="tag">Scryfall</span>'}${o.dpi ? `<span class="tag">${esc(o.dpi)} DPI</span>` : ""}</div>
    <div class="cap">${esc(o.label || "")}${o.released ? ` · ${esc(o.released.slice(0, 4))}` : ""}</div></button>`).join("")
    || '<p class="muted">Keine passenden Bilder.</p>';
  $("#picker-more").hidden = !ctx.hasMore;
}
$("#picker-filter").addEventListener("input", debounce(() => pickerCtx && renderPicker(), 120));
$("#picker-more-btn").addEventListener("click", loadPickerPage);
$("#picker-all-btn").addEventListener("click", async () => {
  const ctx = pickerCtx;
  if (!ctx) return;
  // loadPickerPage() sets ctx.hasMore; another face opened meanwhile replaces pickerCtx
  let more = ctx.hasMore && $("#picker").open;
  while (more) {
    await loadPickerPage();
    more = pickerCtx === ctx && ctx.hasMore && $("#picker").open;
  }
});

async function pick(option) {
  const ctx = pickerCtx;
  await api(`/api/decks/${enc(pctx().slug)}/print/choose`, { method: "POST", body: { face: ctx.face, option } });
  $("#picker").close();
  await refreshAfterPick(ctx);
}

// own image: upload it for the picker's card face (it is chosen right away)
async function uploadPickerImage(file) {
  const ctx = pickerCtx;
  if (!ctx || !file) return;
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|tiff?|bmp)$/i.test(file.name)) { toast("Das ist keine Bilddatei.", "error"); return; }
  const slug = pctx().slug;
  const box = $("#picker-upload");
  box.classList.add("busy");
  $("#picker-hint").textContent = `Lade „${file.name}“ hoch und mache es druckfertig …`;
  try {
    const q = new URLSearchParams({ face: ctx.face, filename: file.name, bleed: $("#picker-bleed").value });
    let res;
    try { res = await fetch(`/api/decks/${enc(slug)}/print/upload?${q}`, { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } }); }
    catch { throw new Error("Keine Verbindung zur App – läuft mtg-gui noch?"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(res, data));
    $("#picker").close();
    toast(`Eigenes Bild für ${ctx.face} gewählt. ${(data.notes || []).join(" ")}`, data.notes?.some((n) => n.startsWith("Niedrige")) ? "error" : "info", 8000);
    await refreshAfterPick(ctx);
  } catch (err) { $("#picker-hint").textContent = err.message; fail(err); }
  finally { box.classList.remove("busy"); $("#picker-file").value = ""; }
}
$("#picker-upload-btn").addEventListener("click", () => $("#picker-file").click());
$("#picker-file").addEventListener("change", (e) => uploadPickerImage(e.target.files[0]));
$("#picker").addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); $("#picker").classList.add("dragging"); } });
$("#picker").addEventListener("dragleave", (e) => { if (e.target === $("#picker")) $("#picker").classList.remove("dragging"); });
$("#picker").addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  $("#picker").classList.remove("dragging");
  void uploadPickerImage(e.dataTransfer.files[0]);
});

// after a pick/upload/delete: update just this tile – re-rendering the whole grid would make the page jump
async function refreshAfterPick({ i, card, side }) {
  const slug = pctx().slug;
  const plan = await api(`/api/decks/${enc(slug)}/print/plan?${planQuery()}`);
  if (pctx()?.slug !== slug) return;
  printPlan = plan;
  renderPlanSummary();
  const j = plan.cards.findIndex((c) => c.name === card.name);
  const tile = $(`#print-grid .pcard[data-i="${i}"]`);
  if (j < 0 || !tile) { renderPlan(); return; }
  tile.outerHTML = cardTile(plan.cards[j], j, side);
  if (card.token) renderTokenList();
  $(`#print-grid .pcard[data-i="${j}"]`)?.focus({ preventScroll: true });
}
$("#picker-grid").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    const ok = await ask({ title: "Eigenes Bild löschen?", text: "Das hochgeladene Bild wird entfernt. Nutzt die Karte es gerade, wählt die App wieder automatisch.", ok: "Löschen", danger: true });
    if (!ok) return;
    try {
      const slug = pctx().slug, ctx = pickerCtx;
      await api(`/api/decks/${enc(slug)}/print/uploads/${enc(del.dataset.del)}`, { method: "DELETE" });
      ctx.options = ctx.options.filter((o) => o.upload !== del.dataset.del);
      renderPicker();
      await refreshAfterPick(ctx);
      toast("Bild gelöscht.");
    } catch (err) { fail(err); }
    return;
  }
  const t = e.target.closest("[data-k]");
  if (t) pick(pickerCtx.options[Number(t.dataset.k)]).catch(fail);
});
$("#picker-auto").addEventListener("click", () => pick(null).catch(fail));
$("#picker-close").addEventListener("click", () => $("#picker").close());

$("#prepare-btn").addEventListener("click", async () => {
  const ctx0 = pctx();
  if (!ctx0 || currentJob) return;
  const { slug, name, route: back } = ctx0;
  try {
    const { job } = await api(`/api/decks/${enc(slug)}/print/prepare`, { method: "POST", body: printOpts() });
    startJob(job, `Druckdateien für ${name}`, { kind: "print", slug, slot: "#print-job-slot", route: back });
    $("#print-job-slot").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) { fail(err); }
});

// ---------- before/after comparison ----------
let compareFace = null;
function imageUrl(face, kind) {
  return `/api/decks/${enc(pctx().slug)}/print/image?face=${enc(face)}&kind=${kind}&t=${Date.now()}`;
}
function openCompare(face) {
  compareFace = face;
  const info = prepared.faces[face];
  $("#compare-title").textContent = `${face} – Vorher / Nachher`;
  const originLabel = { scryfall: "Scryfall-Scan", mpcfill: "MPC-Autofill-Scan", local: "eigene Datei" }[info.origin] || info.origin;
  $("#compare-cap-a").textContent = `Original: ${originLabel}`;
  $("#compare-cap-b").textContent = `Druckdatei: ${info.dpi ? info.dpi + " DPI" : ""}${info.upscaled ? " · KI-hochskaliert" : info.origin === "scryfall" ? " · nicht hochskaliert" : ""}`;
  loadCompareImages();
  $("#compare").showModal();
}
function loadCompareImages() {
  const bleed = $("#compare-bleed").checked;
  const a = $("#compare-a"), b = $("#compare-b");
  a.onload = applyZoom;
  a.src = imageUrl(compareFace, "original");
  b.src = imageUrl(compareFace, bleed ? "file" : "trim");
  b.onload = () => {
    $("#compare-cap-b").title = `${b.naturalWidth} × ${b.naturalHeight} px`;
    applyZoom();
  };
}
function applyZoom() {
  const z = Number($("#compare-zoom").value);
  const pane = $("#pane-a");
  // keep the visible centre when zooming
  const cx = (pane.scrollLeft + pane.clientWidth / 2) / Math.max(pane.scrollWidth, 1);
  const cy = (pane.scrollTop + pane.clientHeight / 2) / Math.max(pane.scrollHeight, 1);
  const img = $("#compare-b").naturalWidth ? $("#compare-b") : $("#compare-a");
  const aspect = img.naturalWidth ? img.naturalWidth / img.naturalHeight : 63 / 88;
  const fit = Math.min(pane.clientWidth, pane.clientHeight * aspect);  // whole card visible at "Einpassen"
  const width = fit * z;
  for (const im of [$("#compare-a"), $("#compare-b")]) im.style.width = `${width}px`;
  for (const p of [$("#pane-a"), $("#pane-b")]) {
    p.scrollLeft = cx * p.scrollWidth - p.clientWidth / 2;
    p.scrollTop = cy * p.scrollHeight - p.clientHeight / 2;
  }
  const a = $("#compare-a");
  if (a.naturalWidth) $("#compare-cap-a").title = `${a.naturalWidth} × ${a.naturalHeight} px`;
}
let syncLock = null;  // the pane the user is scrolling; the other one follows
let syncTimer = null;
for (const [src, dst] of [["#pane-a", "#pane-b"], ["#pane-b", "#pane-a"]]) {
  $(src).addEventListener("scroll", () => {
    if (syncLock && syncLock !== src) return;
    syncLock = src;
    const s = $(src), d = $(dst);
    d.scrollLeft = s.scrollLeft * (d.scrollWidth / Math.max(s.scrollWidth, 1));
    d.scrollTop = s.scrollTop * (d.scrollHeight / Math.max(s.scrollHeight, 1));
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncLock = null; }, 120);
  });
}
$("#compare-zoom").addEventListener("change", applyZoom);
$("#compare-bleed").addEventListener("change", loadCompareImages);
$("#compare-close").addEventListener("click", () => $("#compare").close());

$("#open-folder-btn").addEventListener("click", async () => {
  try {
    const r = await api(`/api/decks/${enc(pctx().slug)}/print/open-folder`, { method: "POST" });
    if (!r.opened) toast(`Ordner: ${r.path}`);
  } catch (err) { fail(err); }
});

async function onPrepared(result) {
  logLine("result", `Druckbilder: ${result.images_dir}`);
  if (result.missing.length) toast(`Ohne Bild: ${result.missing.join(", ")}`, "error");
  if (pctx() && printLoadedFor === pctx().slug) {
    prepared = await api(`/api/decks/${enc(pctx().slug)}/print/prepared`).catch(() => prepared);
    renderPlan();
    renderPreparedInfo();
    void updateDownloadLinks();
  }
}

async function updateDownloadLinks() {
  const base = `/api/decks/${enc(pctx().slug)}/print/files`;
  const have = await api(base).catch(() => ({}));  // which files exist – no 404 noise in the console
  for (const [id, kind] of [["#xml-link", "xml"], ["#pdf-link", "pdf"]]) {
    $(id).href = `${base}/${kind}`;
    $(id).hidden = !have[kind];
  }
}

$("#pdf-btn").addEventListener("click", async () => {
  const btn = $("#pdf-btn");
  btn.disabled = true;
  btn.textContent = "Erstelle PDF …";
  try {
    const r = await api(`/api/decks/${enc(pctx().slug)}/print/pdf`, { method: "POST", body: { paper: $("#pdf-paper").value, include_backs: $("#pdf-backs").checked } });
    await updateDownloadLinks();
    window.open($("#pdf-link").href, "_blank");
    toast(`PDF erstellt: ${r.cards} Karten auf ${r.pages} Seiten.`);
  } catch (err) { fail(err); }
  finally { btn.disabled = false; btn.textContent = "PDF erstellen"; }
});

$("#mpc-btn").addEventListener("click", async () => {
  const ctx0 = pctx();
  if (!ctx0 || currentJob) return;
  const { slug, name, route: back } = ctx0;
  try {
    const r = await api(`/api/decks/${enc(slug)}/print/autofill`, { method: "POST", body: { mode: "mpc", window: $("#mpc-window").checked, ...TERM_SIZE } });
    if (r.job) {
      startJob(r.job, `MPC Autofill: ${name}`, { kind: "autofill", slug, slot: "#print-job-slot", route: back });
      $("#print-job-slot").scrollIntoView({ behavior: "smooth", block: "start" });
    } else toast("MPC Autofill läuft in einem eigenen Konsolenfenster – dort weiter bedienen.");
  } catch (err) { fail(err); }
});

// ---------- terminal (MPC Autofill runs in a pseudo-terminal; its menus need arrow keys) ----------
// escape sequences: CSI (ESC [ … final byte) and OSC (ESC ] … BEL), plus carriage returns
const [ESC_C, BEL_C] = [String.fromCharCode(27), String.fromCharCode(7)];
const ANSI_RE = new RegExp(`${ESC_C}\\[[0-9;?]*[ -/]*[@-~]|${ESC_C}\\][^${BEL_C}]*${BEL_C}|\\r`, "g");
const TERM_SIZE = { rows: 32, cols: 110 };
const KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r" };
let term = null;
let keyQueue = Promise.resolve();

function sendKeys(data, raw = true) {
  const job = currentJob;
  if (!job) return;
  keyQueue = keyQueue.then(() => api(`/api/jobs/${job}/input`, { method: "POST", body: { text: data, raw } })
    .catch((err) => logLine("error", err.message)));
}

function resetTerminal() {
  if (term) { term.dispose(); term = null; }
  $("#terminal").innerHTML = "";
  $("#terminal-wrap").hidden = true;
}

function openTerminal() {
  if (term) return;
  if (!window.Terminal) {  // xterm.js missing -> simple line input as fallback
    $("#console-form").hidden = false;
    return;
  }
  $("#terminal-wrap").hidden = false;
  term = new window.Terminal({ ...TERM_SIZE, fontSize: 13, cursorBlink: true, convertEol: false,
    theme: { background: "#111111" }, fontFamily: "ui-monospace, Consolas, monospace" });
  term.open($("#terminal"));
  term.onData((d) => sendKeys(d));
  term.focus();
}

document.querySelector(".term-keys").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-key]");
  if (b && currentJob) { sendKeys(KEYS[b.dataset.key]); term?.focus(); }
});

$("#console-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = e.target.elements.text;
  sendKeys(input.value, false);
  input.value = "";
});

// ============================================================================================
// my collection
// ============================================================================================
let coll = { entries: [], summary: {}, decks: {} };
let collSummary = { cards: 0 };
let collShown = 150;
const COLL_PAGE = 150;
const LANG_NAMES = { en: "EN", de: "DE", fr: "FR", it: "IT", es: "ES", pt: "PT", ja: "JA", ko: "KO", ru: "RU", zhs: "ZH", zht: "ZH" };
let collView = store.get("collview") === "grid" ? "grid" : "list";
document.querySelector(`[name="collview"][value="${collView}"]`).checked = true;

function applyCollectionPresence() {
  const has = (collSummary.cards || 0) > 0;
  $("#coll-count").textContent = has ? collSummary.cards : "";
  for (const el of $$(".needs-collection")) el.hidden = !has;
  const opt = $('#card-group option[value="owned"]');
  opt.hidden = !has;
  opt.disabled = !has;
  if (!has && cardGroup === "owned") { cardGroup = "category"; $("#card-group").value = "category"; }
}

async function refreshCollectionSummary() {
  try {
    coll = await api("/api/collection");
    collSummary = coll.summary;
  } catch { /* offline: keep the old numbers */ }
  applyCollectionPresence();
}

async function loadCollection() {
  await refreshCollectionSummary();
  renderCollection();
}

// where cards are (Ort): one of the decks (its slug, shown by its current name) or free text like "Binder rot"
const collSel = new Set();  // marked entries, for "Ort setzen"
function placeLabel(e) {
  if (e.place_deck) return deckIndex.find((d) => d.slug === e.place_deck)?.name || e.place || e.place_deck;
  return e.place || "";
}
const placeKey = (e) => (e.place_deck ? `deck:${e.place_deck}` : e.place ? `text:${e.place.trim().toLowerCase()}` : "none");
function parsePlace(text) {
  const t = text.trim().replace(/\s+/g, " ");
  const deck = deckIndex.find((d) => d.name.toLowerCase() === t.toLowerCase());
  return deck ? { place: deck.name, place_deck: deck.slug } : { place: t, place_deck: "" };
}
function fillPlaces() {
  const names = [...new Set([...(coll.places || []).map((p) => placeLabel(p)), ...deckIndex.map((d) => d.name)].filter(Boolean))];
  $("#place-options").innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
}
function renderBulk() {
  for (const id of [...collSel]) if (!coll.entries.some((e) => e.id === id)) collSel.delete(id);
  const n = collSel.size;
  $("#coll-bulk").hidden = !n || collView === "grid";
  $("#coll-bulk-count").textContent = `${n} markiert`;
}
function openPlaceDialog(ids) {
  const entries = coll.entries.filter((e) => ids.includes(e.id));
  const labels = [...new Set(entries.map(placeLabel))];
  $("#place-title").textContent = entries.length === 1 ? `Ort: ${entries[0].name}` : `Ort für ${entries.length} Einträge`;
  $("#place-text").textContent = `${entries.reduce((n, e) => n + e.qty, 0)} Karten. Leer lassen = kein Ort.`;
  $("#place-input").value = labels.length === 1 ? labels[0] : store.get("collplace") || "";
  const recent = [...new Set([...(coll.places || []).map(placeLabel), ...deckIndex.map((d) => d.name)])].slice(0, 8);
  $("#place-chips").innerHTML = recent.map((n) => `<button type="button" class="chip" data-place="${esc(n)}">${esc(n)}</button>`).join("");
  // one entry with several copies: move only some of them (one All Is Dust into the deck, the other into the bulk box)
  const several = entries.length === 1 && entries[0].qty > 1 ? entries[0].qty : 0;
  $("#place-qty-field").hidden = !several;
  if (several) {
    $("#place-qty").max = several;
    $("#place-qty").value = several;
    $("#place-qty-hint").textContent = `– von ${several}; der Rest bleibt, wo er ist`;
  }
  const dlg = $("#place-dialog");
  dlg.onclose = null;
  $("#place-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const p = parsePlace($("#place-input").value);
    const n = Math.round(Number($("#place-qty").value));
    if (several && n > 0 && n < several) p.qty = n;
    try {
      const r = await api("/api/collection/bulk", { method: "POST", body: { ids, ...p } });
      if (p.place) store.set("collplace", p.place);
      dlg.close();
      collSel.clear();
      toast(p.qty ? `${p.qty}× ${entries[0].name} → ${p.place || "kein Ort"}` : p.place ? `${r.changed} ${r.changed === 1 ? "Eintrag" : "Einträge"} → ${p.place}` : `Ort bei ${r.changed} ${r.changed === 1 ? "Eintrag" : "Einträgen"} entfernt.`);
      await loadCollection();
    } catch (err) { fail(err); }
  };
  dlg.showModal();
  $("#place-input").focus();
}
$("#place-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-place]");
  if (b) { $("#place-input").value = b.dataset.place; $("#place-input").focus(); }
});
$("#place-cancel").addEventListener("click", () => $("#place-dialog").close());
$("#coll-bulk-place").addEventListener("click", () => openPlaceDialog([...collSel]));
const BULK_SET = {  // „Ändern …“ in the marking bar: what each choice sends, and the toast
  real: [{ proxy: false }, "als Original"], proxy: [{ proxy: true }, "als Proxy"],
  foil: [{ foil: true }, "als Foil"], nonfoil: [{ foil: false }, "ohne Foil"],
};
$("#coll-bulk-set").addEventListener("change", async (ev) => {
  const v = ev.target.value, text = ev.target.selectedOptions[0]?.textContent || v;
  ev.target.value = "";
  if (!v || !collSel.size) return;
  const [body, label] = v.startsWith("lang:") ? [{ lang: v.slice(5) }, `auf ${text}`] : BULK_SET[v];
  const marked = coll.entries.filter((e) => collSel.has(e.id));
  if (marked.length === 1 && marked[0].qty > 1) {
    const n = await askCount(marked[0], label);
    if (!n) return;
    if (n < marked[0].qty) body.qty = n;
  }
  try {
    const r = await api("/api/collection/bulk", { method: "POST", body: { ids: [...collSel], ...body } });
    collSel.clear();
    toast(`${r.changed} ${r.changed === 1 ? "Eintrag" : "Einträge"} ${label} gesetzt.`, "ok");
    await loadCollection();
  } catch (err) { fail(err); }
});
$("#coll-bulk-delete").addEventListener("click", async () => {
  const ids = [...collSel];
  const cards = coll.entries.filter((e) => collSel.has(e.id)).reduce((n, e) => n + e.qty, 0);
  const yes = await ask({ title: `${ids.length} ${ids.length === 1 ? "Eintrag" : "Einträge"} löschen?`,
    text: `${cards} ${cards === 1 ? "Karte verschwindet" : "Karten verschwinden"} aus deiner Sammlung.`, ok: "Löschen", danger: true });
  if (!yes) return;
  try {
    const r = await api("/api/collection/bulk", { method: "POST", body: { ids, delete: true } });
    collSel.clear();
    toast(`${r.changed} ${r.changed === 1 ? "Eintrag" : "Einträge"} gelöscht.`, "ok");
    await loadCollection();
  } catch (err) { fail(err); }
});
$("#coll-bulk-none").addEventListener("click", () => { collSel.clear(); renderCollection(); });
$("#coll-bulk-all").addEventListener("click", () => { for (const e of collFiltered()) collSel.add(e.id); renderCollection(); });

// „Filter“ in Meine Sammlung: card facts (colour identity, types, commander, mana value, roles, Oracle text) come
// from /api/collection/cards, the rest from the entries. Within one group any pick matches, the groups all have to.
const CF_FLAGS = [["commander", "Kann Commander sein"], ["legendary", "Legendär"]];
const CF_COLORS = [["W", "Weiß"], ["U", "Blau"], ["B", "Schwarz"], ["R", "Rot"], ["G", "Grün"], ["C", "Farblos"]];
const CF_TYPES = [["Creature", "Kreatur"], ["Artifact", "Artefakt"], ["Enchantment", "Verzauberung"], ["Instant", "Spontanzauber"],
  ["Sorcery", "Hexerei"], ["Planeswalker", "Planeswalker"], ["Land", "Land"], ["Battle", "Schlacht"]];
const CF_CMC = [["1", "0–1"], ["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"], ["6", "6+"]];
const CF_MIN = [1, 5, 20];
const CF_EMPTY = { flags: [], colors: [], mode: "in", types: [], cmc: [], roles: [], text: "", deck: "", places: [], sets: [], langs: [], min: 0 };
let cf = (() => {
  try { return { ...CF_EMPTY, ...JSON.parse(store.get("collfilters") || "{}") }; } catch { return { ...CF_EMPTY }; }
})();
let collFacts = null, collFactsKey = "", collFactsLoading = null, collFactsError = "";
const cfNeedsFacts = () => !!(cf.flags.length || cf.colors.length || cf.types.length || cf.cmc.length || cf.roles.length || cf.text.trim() || cf.deck);
const cfActive = () => [cf.flags.length, cf.colors.length, cf.types.length, cf.cmc.length, cf.roles.length, cf.text.trim(), cf.deck,
  cf.places.length, cf.sets.length, cf.langs.length, cf.min].filter(Boolean).length;
function saveCf() {
  store.set("collfilters", JSON.stringify(cf));
  collShown = COLL_PAGE;
  if (cfNeedsFacts()) void ensureCollFacts();
  renderCollection();
}
async function ensureCollFacts() {
  const key = [...new Set(coll.entries.map((e) => e.name))].sort((a, b) => a.localeCompare(b)).join("\n");
  if (!key || key === collFactsKey) return;
  if (collFactsLoading?.key === key) return collFactsLoading.promise;
  const promise = (async () => {
    try {
      collFacts = await api("/api/collection/cards");
      collFactsError = "";
    } catch (err) {
      collFacts = null;
      collFactsError = err.message;
    }
    collFactsKey = key;  // a failure is not retried on every redraw; the next new card or reload tries again
    collFactsLoading = null;
    if (!$("#view-collection").hidden) renderCollection();
  })();
  collFactsLoading = { key, promise };
  return promise;
}
const cfBucket = (cmc) => String(Math.min(6, Math.max(1, Math.floor(Number(cmc) || 0))));
function cfColorsMatch(ci, picked, mode) {
  const id = [...ci], wanted = picked.filter((c) => c !== "C");
  if (mode === "exact") return id.length ? !picked.includes("C") && id.length === wanted.length && id.every((c) => wanted.includes(c)) : picked.includes("C") && !wanted.length;
  if (mode === "has") return wanted.every((c) => id.includes(c)) && (!picked.includes("C") || !id.length);
  return id.length ? id.every((c) => wanted.includes(c)) : picked.includes("C");
}
/** Whether an entry passes the filter panel (card facts only once they are loaded; an unknown card fails them). */
function cfMatch(e) {
  if (cf.places.length) {
    const key = placeKey(e);
    if (!cf.places.includes(key) && !(cf.places.includes("free") && !key.startsWith("deck:"))) return false;
  }
  if (cf.sets.length && !cf.sets.includes((e.set || "").toLowerCase())) return false;
  if (cf.langs.length && !cf.langs.includes(e.lang || "en")) return false;
  if (cf.min && (e.proxy || !(Number(e.price_eur) >= cf.min))) return false;
  if (!cfNeedsFacts() || !collFacts || collFactsLoading) return true;
  const f = collFacts.cards?.[e.name];
  if (!f) return false;
  if (cf.flags.includes("commander") && !f.commander) return false;
  if (cf.flags.includes("legendary") && !f.legendary) return false;
  if (cf.colors.length && !cfColorsMatch(f.ci, cf.colors, cf.mode)) return false;
  if (cf.deck) {
    const d = deckIndex.find((x) => x.slug === cf.deck);
    if (d && typeof d.color_identity === "string" && ![...f.ci].every((c) => d.color_identity.includes(c))) return false;
    if ((coll.deck_slugs?.[e.name] || []).includes(cf.deck)) return false;
  }
  if (cf.types.length && !cf.types.some((t) => f.types.includes(t))) return false;
  const landOnly = f.types.length === 1 && f.types[0] === "Land";  // lands have no mana value worth filtering
  if (cf.cmc.length && (landOnly || !cf.cmc.includes(cfBucket(f.cmc)))) return false;
  if (cf.roles.length && !cf.roles.some((r) => f.roles.includes(r))) return false;
  const text = cf.text.trim().toLowerCase();
  if (text && !`${f.type_line}\n${f.text}`.toLowerCase().includes(text)) return false;
  return true;
}
const orList = (items) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} oder ${items.at(-1)}`;
/** The active filters in a few words, for the line above the list: „Kann Commander sein · Grün oder Schwarz · Kreatur“. */
function cfSummary() {
  const label = (pairs, keys) => keys.map((k) => pairs.find(([v]) => v === k)?.[1] || k);
  const parts = label(CF_FLAGS, cf.flags);
  if (cf.colors.length) parts.push((cf.mode === "exact" ? "genau " : cf.mode === "has" ? "mit " : "passt in ") + orList(label(CF_COLORS, cf.colors)).replace(" oder ", cf.mode === "in" ? " oder " : " und "));
  if (cf.deck) parts.push(`passt zu „${deckIndex.find((d) => d.slug === cf.deck)?.name || cf.deck}“, noch nicht drin`);
  if (cf.types.length) parts.push(orList(label(CF_TYPES, cf.types)));
  if (cf.cmc.length) parts.push(`Manawert ${orList(label(CF_CMC, cf.cmc))}`);
  if (cf.roles.length) parts.push(orList(cf.roles.map((r) => ROLE_LABELS[r] || r)));
  if (cf.text.trim()) parts.push(`Text „${cf.text.trim()}“`);
  if (cf.places.length) parts.push(orList(cf.places.map((k) => k === "none" ? "ohne Ort" : k === "free" ? "in keinem Deck" : `in ${cfPlaceName(k)}`)));
  if (cf.sets.length) parts.push(orList(cf.sets.map((x) => x.toUpperCase())));
  if (cf.langs.length) parts.push(orList(cf.langs.map((l) => LANG_NAMES[l] || l.toUpperCase())));
  if (cf.min) parts.push(`ab ${fmtPrice(cf.min, "€")} pro Karte`);
  return parts.join(" · ");
}
function cfPlaceName(key) {
  const p = (coll.places || []).find((x) => placeKey(x) === key);
  if (p) return placeLabel(p);
  return key.startsWith("deck:") ? deckIndex.find((d) => d.slug === key.slice(5))?.name || key.slice(5) : key.replace(/^text:/, "");
}
const cfChip = (group, value, text, html = esc(text)) =>
  `<button type="button" class="chip" data-cf="${group}" data-v="${esc(value)}" aria-pressed="${cf[group].includes(value)}" title="${esc(text)}">${html}</button>`;
function renderCollFilters() {
  const n = cfActive();
  $("#coll-filter-count").textContent = n || "";
  $("#coll-filter-btn").classList.toggle("on", !!n);
  if ($("#coll-filters").hidden) return;
  const box = (g) => $(`[data-cf-group="${g}"]`);
  box("flags").innerHTML = CF_FLAGS.map(([v, t]) => cfChip("flags", v, t)).join("");
  box("colors").innerHTML = CF_COLORS.map(([v, t]) => cfChip("colors", v, t, `${manaHtml(`{${v}}`)}<span class="sr-only">${esc(t)}</span>`)).join("");
  document.querySelector(`[name="cfmode"][value="${cf.mode}"]`).checked = true;
  box("types").innerHTML = CF_TYPES.map(([v, t]) => cfChip("types", v, t)).join("");
  box("cmc").innerHTML = CF_CMC.map(([v, t]) => cfChip("cmc", v, t)).join("");
  box("roles").innerHTML = Object.entries(ROLE_LABELS).map(([v, t]) => cfChip("roles", v, t)).join("");
  const places = [["free", "In keinem Deck"], ["none", "Ohne Ort"], ...(coll.places || []).map((p) => [placeKey(p), `${placeLabel(p)} (${p.cards})`])];
  box("places").innerHTML = places.map(([v, t]) => cfChip("places", v, t)).join("");
  const sets = new Map(), langs = new Map();
  for (const e of coll.entries) {
    if (e.set) sets.set(e.set.toLowerCase(), e.set_name || e.set.toUpperCase());
    langs.set(e.lang || "en", (langs.get(e.lang || "en") || 0) + e.qty);
  }
  for (const v of cf.sets) if (!sets.has(v)) sets.set(v, v.toUpperCase());
  box("sets").innerHTML = [...sets].sort((a, b) => a[1].localeCompare(b[1])).map(([v, t]) => cfChip("sets", v, t, `${esc(t)} <span class="muted">${esc(v.toUpperCase())}</span>`)).join("");
  $('[data-cf-row="sets"]').hidden = sets.size < 2 && !cf.sets.length;
  box("langs").innerHTML = [...langs.keys()].sort((a, b) => (a !== "en") - (b !== "en") || a.localeCompare(b)).map((v) => cfChip("langs", v, LANG_NAMES[v] || v.toUpperCase())).join("");
  $('[data-cf-row="langs"]').hidden = langs.size < 2 && !cf.langs.length;
  box("min").innerHTML = CF_MIN.map((v) => `<button type="button" class="chip" data-cf="min" data-v="${v}" aria-pressed="${cf.min === v}">ab ${esc(fmtPrice(v, "€"))}</button>`).join("");
  const sel = $("#cf-deck");
  sel.innerHTML = `<option value="">–</option>` + deckIndex.filter((d) => !d.damaged).map((d) => `<option value="${esc(d.slug)}">${esc(d.name)}</option>`).join("");
  sel.value = cf.deck;
  if (document.activeElement !== $("#cf-text")) $("#cf-text").value = cf.text;
  const status = $("#cf-status");
  const missing = collFacts?.missing?.length || 0;
  status.hidden = !(collFactsLoading || missing || collFactsError);
  status.textContent = collFactsLoading ? "Kartendaten werden geladen …"
    : collFactsError ? `Kartendaten fehlen (${collFactsError}) – Commander, Farbe, Typ, Manawert, Aufgabe und Text filtern gerade nicht.`
    : `${missing} ${missing === 1 ? "Karte ist" : "Karten sind"} gerade nicht nachzuschlagen (keine Verbindung, keine Kartendatenbank) und ${missing === 1 ? "fällt" : "fallen"} bei Farbe, Typ und Text heraus.`;
}
$("#coll-filter-btn").addEventListener("click", () => {
  const open = $("#coll-filters").hidden;
  $("#coll-filters").hidden = !open;
  $("#coll-filter-btn").setAttribute("aria-expanded", String(open));
  store.set("collfilteropen", open ? "1" : "");
  if (open) void ensureCollFacts();
  renderCollFilters();
});
$("#coll-filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cf]");
  if (!b) return;
  const group = b.dataset.cf, v = b.dataset.v;
  if (group === "min") cf.min = cf.min === Number(v) ? 0 : Number(v);
  else cf[group] = cf[group].includes(v) ? cf[group].filter((x) => x !== v) : [...cf[group], v];
  saveCf();
});
$$('[name="cfmode"]').forEach((r) => r.addEventListener("change", () => { cf.mode = r.value; saveCf(); }));
$("#cf-deck").addEventListener("change", (e) => { cf.deck = e.target.value; saveCf(); });
$("#cf-text").addEventListener("input", debounce((e) => { cf.text = e.target.value; saveCf(); }, 200));
$("#coll-result").addEventListener("click", (e) => {
  if (!e.target.closest("[data-act=cf-reset]")) return;
  cf = { ...CF_EMPTY };
  saveCf();
});
if (store.get("collfilteropen")) {
  $("#coll-filters").hidden = false;
  $("#coll-filter-btn").setAttribute("aria-expanded", "true");
}

function collFiltered() {
  const q = $("#coll-q").value.trim().toLowerCase();
  const filter = document.querySelector('[name="collfilter"]:checked').value;
  const sort = $("#coll-sort").value;
  const list = coll.entries.filter((e) => (filter === "all" || (filter === "proxy") === !!e.proxy)
    && (!q || `${e.name} ${e.set_name || ""} ${e.set || ""} ${e.note || ""} ${placeLabel(e)}`.toLowerCase().includes(q))
    && cfMatch(e));
  const price = (e) => Number(e.price_eur) || 0;
  const cmp = { name: (a, b) => a.name.localeCompare(b.name), qty: (a, b) => b.qty - a.qty || a.name.localeCompare(b.name),
    price: (a, b) => price(b) - price(a), added: (a, b) => (b.added || "").localeCompare(a.added || ""),
    set: (a, b) => (a.set_name || "~").localeCompare(b.set_name || "~") || a.name.localeCompare(b.name) }[sort];
  return list.sort(cmp);
}

function renderCollection() {
  fillPlaces();
  const s = coll.summary || {};
  const empty = !coll.entries.length;
  $("#coll-empty").hidden = !empty;
  $("#coll-stats").innerHTML = empty ? "" : [
    `<span class="pill">${s.cards} Karten</span>`, `<span class="pill">${s.unique} verschiedene</span>`,
    `<span class="pill ok">${s.real} echt</span>`, `<span class="pill accent">${s.proxy} Proxies</span>`,
    s.value_eur ? `<span class="pill">Wert ≈ ${fmtPrice(s.value_eur, "EUR")}</span>` : "",
  ].join("");
  if (cfNeedsFacts() || !$("#coll-filters").hidden) void ensureCollFacts();
  renderCollFilters();
  const list = collFiltered();
  const words = cfSummary();
  $("#coll-result").innerHTML = empty ? "" : `${list.length} ${list.length === 1 ? "Eintrag" : "Einträge"}${list.length !== coll.entries.length ? ` (von ${coll.entries.length})` : ""}`
    + (words ? ` · <span class="cf-summary">${esc(words)}</span> <button type="button" class="link-btn" data-act="cf-reset">Filter zurücksetzen</button>` : "");
  const shown = list.slice(0, collShown);
  const grid = collView === "grid";
  $("#coll-list").classList.toggle("grid", grid);
  $("#coll-list").innerHTML = shown.map((e) => {
    const decks = coll.decks?.[e.name] || [];
    const printing = [e.set_name || (e.set ? e.set.toUpperCase() : "Standard-Druck"), e.collector_number ? `#${e.collector_number}` : ""].filter(Boolean).join(" · ");
    const badges = `${e.foil ? '<span class="tagb foil">Foil</span>' : ""}${e.lang && e.lang !== "en" ? `<span class="tagb">${esc(LANG_NAMES[e.lang] || e.lang)}</span>` : ""}`;
    const img = e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy">` : `<div class="noimg">${esc(e.name)}</div>`;
    if (grid) {
      return `<div class="coll-tile" data-id="${esc(e.id)}">
        <button type="button" class="card tile-img" data-act="art" data-img="${esc(e.image || "")}" data-name="${esc(e.name)}" title="Artwork ändern">${img}</button>
        <span class="qty-badge">${e.qty}×</span>${e.proxy ? '<span class="own proxy tile-p" title="Proxy">P</span>' : ""}
        <span class="tile-name">${esc(e.name)} ${badges}</span></div>`;
    }
    const where = placeLabel(e);
    const sale = coll.sales?.[e.id];
    const saleTag = sale ? `<a class="tagb sale" href="#/sell" title="Auf der Verkaufsliste">${sale.status === "listed" ? "Bei Cardmarket" : "Verkauf"}${sale.qty < e.qty ? ` ${sale.qty}×` : ""}${sale.price ? ` · ${esc(fmtPrice(sale.price, "€"))}` : ""}</a>` : "";
    return `<div class="coll-row${collSel.has(e.id) ? " selected" : ""}" data-id="${esc(e.id)}">
      <input type="checkbox" class="coll-sel" data-act="select" ${collSel.has(e.id) ? "checked" : ""} aria-label="${esc(e.name)} markieren">
      <button type="button" class="thumb card" data-act="art" data-img="${esc(e.image || "")}" data-name="${esc(e.name)}" title="Artwork ändern" aria-label="Artwork von ${esc(e.name)} ändern">${img}</button>
      <div class="coll-main">
        <div class="coll-name">${esc(e.name)} ${badges}${saleTag}${where ? ` <button type="button" class="tagb place" data-act="place" title="Ort ändern">${esc(where)}</button>` : ` <button type="button" class="tagb place empty" data-act="place" title="Ort setzen">+ Ort</button>`}</div>
        <div class="muted small">${esc(printing)}${e.note ? ` · ${esc(e.note)}` : ""}${decks.length ? ` · in ${decks.length === 1 ? "Deck" : "Decks"}: ${esc(decks.join(", "))}` : ""}</div>
      </div>
      <label class="check small"><input type="checkbox" data-act="proxy" ${e.proxy ? "checked" : ""}> Proxy</label>
      <label class="check small tg-foil"><input type="checkbox" data-act="foil" ${e.foil ? "checked" : ""}> Foil</label>
      <div class="stepper" aria-label="Anzahl">
        <button type="button" class="mini" data-act="minus" aria-label="Eine weniger">−</button>
        <span class="q">${e.qty}</span>
        <button type="button" class="mini" data-act="plus" aria-label="Eine mehr">+</button>
      </div>
      <span class="price">${e.price_eur && !e.proxy ? esc(fmtPrice(Number(e.price_eur) * e.qty, "€")) : ""}</span>
      <button type="button" class="mini danger" data-act="delete" title="Entfernen" aria-label="${esc(e.name)} entfernen">✕</button>
    </div>`;
  }).join("");
  $("#coll-more").hidden = list.length <= collShown;
  renderBulk();
}

$("#coll-q").addEventListener("input", debounce(() => { collShown = COLL_PAGE; renderCollection(); }, 150));
$$('[name="collfilter"]').forEach((r) => r.addEventListener("change", () => { collShown = COLL_PAGE; renderCollection(); }));
$("#coll-sort").addEventListener("change", renderCollection);
$$('[name="collview"]').forEach((r) => r.addEventListener("change", () => { collView = r.value; store.set("collview", collView); renderCollection(); }));
$("#coll-more button").addEventListener("click", () => { collShown += COLL_PAGE; renderCollection(); });

async function patchEntry(id, body) {
  try {
    await api(`/api/collection/${enc(id)}`, { method: "PATCH", body });
    await loadCollection();
  } catch (err) { fail(err); }
}

$("#coll-list").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  const row = e.target.closest("[data-id]");
  if (!act || !row || act === "proxy" || act === "foil" || act === "select") return;
  const entry = coll.entries.find((x) => x.id === row.dataset.id);
  if (!entry) return;
  if (act === "plus") void patchEntry(entry.id, { qty: entry.qty + 1 });
  if (act === "minus") {
    if (entry.qty > 1) void patchEntry(entry.id, { qty: entry.qty - 1 });
    else if (await ask({ title: `${entry.name} entfernen?`, ok: "Entfernen", danger: true })) void patchEntry(entry.id, { qty: 0 });
  }
  if (act === "delete" && await ask({ title: `${entry.name} entfernen?`, text: `${entry.qty}× ${entry.proxy ? "Proxy" : "echt"} – aus der Sammlung löschen.`, ok: "Entfernen", danger: true })) {
    await api(`/api/collection/${enc(entry.id)}`, { method: "DELETE" }).catch(fail);
    void loadCollection();
  }
  if (act === "place") openPlaceDialog([entry.id]);
  if (act === "art") {
    const p = await pickPrinting(entry.name);
    if (p) void patchEntry(entry.id, { printing: p });
  }
});
$("#coll-list").addEventListener("change", (e) => {
  const box = e.target.closest("input[data-act]");
  const row = e.target.closest("[data-id]");
  if (box && row && box.dataset.act === "select") {
    if (box.checked) collSel.add(row.dataset.id); else collSel.delete(row.dataset.id);
    row.classList.toggle("selected", box.checked);
    renderBulk();
  } else if (box && row) void changeCopies(row.dataset.id, box.dataset.act, box.checked);
});

/** How many copies of ``entry`` a change applies to (all, or a few split off into their own row); null = cancelled. */
async function askCount(entry, label) {
  const v = await ask({ title: `Wie viele der ${entry.qty}× ${entry.name} ${label}?`,
    text: "Die übrigen bleiben, wie sie sind, und stehen dann in einer eigenen Zeile.", value: String(entry.qty), ok: "Ändern" });
  const n = Math.round(Number(String(v ?? "").replace(",", ".")));
  return v === null || !(n > 0) ? null : Math.min(n, entry.qty);
}
// the Proxy/Foil boxes of a row: with several copies, ask how many of them change
async function changeCopies(id, field, on) {
  const entry = coll.entries.find((x) => x.id === id);
  if (!entry || entry.qty < 2) return patchEntry(id, { [field]: on });
  const n = await askCount(entry, field === "proxy" ? (on ? "als Proxy" : "als Original") : (on ? "als Foil" : "ohne Foil"));
  if (!n) return renderCollection();  // the box goes back
  try {
    await api("/api/collection/bulk", { method: "POST", body: { ids: [id], [field]: on, ...(n < entry.qty ? { qty: n } : {}) } });
    await loadCollection();
  } catch (err) { fail(err); }
}

// artwork picker: all printings of a card, page by page; resolves with the chosen printing (or null)
let printsCtx = null;
function renderPrints() {
  const ctx = printsCtx;
  const q = $("#prints-filter").value.trim().toLowerCase();
  const shown = ctx.prints.map((p, i) => [p, i]).filter(([p]) => !q || `${p.set_name || ""} ${p.set || ""} ${p.collector_number || ""} ${p.released || ""}`.toLowerCase().includes(q));
  $("#prints-hint").textContent = ctx.prints.length
    ? `${ctx.prints.length} von ${ctx.total} Drucken geladen${q ? ` · ${shown.length} passen zum Filter` : ""} – klick wählt das Artwork.`
    : "Keine Drucke gefunden.";
  $("#prints-grid").innerHTML = shown.map(([p, i]) => `<button type="button" class="similar" data-i="${i}">
    ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : `<div class="noimg">${esc(ctx.name)}</div>`}
    <span class="sim-name">${esc(p.set_name || p.set)}</span>
    <span class="muted small">#${esc(p.collector_number)} · ${esc((p.released || "").slice(0, 4))}${p.price_eur ? ` · ${esc(p.price_eur)} €` : ""}</span></button>`).join("");
  $("#prints-more").hidden = !ctx.hasMore;
}
async function loadPrintsPage() {
  const ctx = printsCtx;
  if (!ctx || ctx.loading || !ctx.hasMore) return;
  ctx.loading = true;
  $("#prints-more-btn").disabled = $("#prints-all-btn").disabled = true;
  try {
    const r = await api(`/api/cards/prints?name=${enc(ctx.name)}&page=${ctx.page + 1}`);
    if (printsCtx !== ctx) return;
    ctx.prints.push(...r.prints);
    ctx.page = r.page;
    ctx.hasMore = r.has_more;
    ctx.total = r.total;
    renderPrints();
  } catch (err) { $("#prints-hint").textContent = err.message; }
  finally { ctx.loading = false; $("#prints-more-btn").disabled = $("#prints-all-btn").disabled = false; }
}
$("#prints-filter").addEventListener("input", debounce(() => printsCtx && renderPrints(), 120));
$("#prints-more-btn").addEventListener("click", loadPrintsPage);
$("#prints-all-btn").addEventListener("click", async () => {
  const ctx = printsCtx;
  if (!ctx) return;
  // loadPrintsPage() sets ctx.hasMore; another card opened meanwhile replaces printsCtx
  let more = ctx.hasMore && $("#prints-dialog").open;
  while (more) {
    await loadPrintsPage();
    more = printsCtx === ctx && ctx.hasMore && $("#prints-dialog").open;
  }
});

function pickPrinting(name) {
  const dlg = $("#prints-dialog");
  $("#prints-title").textContent = `Artwork: ${name}`;
  $("#prints-hint").textContent = "Lade die Drucke von Scryfall …";
  $("#prints-filter").value = "";
  $("#prints-grid").innerHTML = "";
  $("#prints-more").hidden = true;
  printsCtx = { name, prints: [], page: 0, hasMore: true, total: 0, loading: false };
  dlg.showModal();
  void loadPrintsPage();
  return new Promise((resolve) => {
    const ctx = printsCtx;
    const done = (p) => { resolve(p); if (dlg.open) dlg.close(); };
    dlg.onclose = () => resolve(null);
    $("#prints-close").onclick = () => done(null);
    $("#prints-grid").onclick = (e) => {
      const b = e.target.closest("[data-i]");
      if (b) done(ctx.prints[Number(b.dataset.i)]);
    };
  });
}

// add one card
let addPrinting = null;
function openCollAdd(name = "") {
  addPrinting = null;
  $("#coll-add-form").reset();
  $("#coll-add-name").value = name;
  $("#coll-add-art").hidden = true;
  $("#coll-add-art-text").textContent = "Artwork: Standard-Druck";
  $("#coll-add-place").value = store.get("collplace") || "";  // the last place, easy to change
  fillPlaces();
  $("#coll-add-dialog").showModal();
  $("#coll-add-name").focus();
}
wireAutocomplete($("#coll-add-name"), $("#ac-coll"));
$("#coll-add-btn").addEventListener("click", () => openCollAdd());
$("#coll-add-cancel").addEventListener("click", () => $("#coll-add-dialog").close());
$("#coll-add-art-btn").addEventListener("click", async () => {
  const name = $("#coll-add-name").value.trim();
  if (!name) { $("#coll-add-name").focus(); return; }
  const p = await pickPrinting(name);
  if (!p) return;
  addPrinting = p;
  $("#coll-add-name").value = p.name || name;
  $("#coll-add-art").src = p.image || "";
  $("#coll-add-art").hidden = !p.image;
  $("#coll-add-art-text").textContent = `Artwork: ${p.set_name || p.set} · #${p.collector_number}`;
});
$("#coll-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const item = {
    name: $("#coll-add-name").value.trim(), qty: Number($("#coll-add-qty").value) || 1,
    proxy: $("#coll-add-proxy").checked, foil: $("#coll-add-foil").checked, lang: $("#coll-add-lang").value,
    ...(addPrinting ? { printing: addPrinting } : {}),
  };
  try {
    if (!addPrinting) item.name = await chooseCard(item.name, { deck: false });  // a picked printing is clear
    if (item.name === null) return;
    const where = parsePlace($("#coll-add-place").value);
    store.set("collplace", where.place);
    const r = await api("/api/collection", { method: "POST", body: { items: [item], ...where } });
    if (r.not_found.length) { toast(`Nicht gefunden: ${r.not_found.join(", ")}`, "error"); return; }
    $("#coll-add-dialog").close();
    toast(`${item.qty}× ${item.name} hinzugefügt${where.place ? ` → ${where.place}` : ""}.`);
    await loadCollection();
    if (currentDeck) void loadOwnership(currentDeck);
  } catch (err) { fail(err); }
});

// import
$("#coll-import-btn").addEventListener("click", () => { $("#coll-import-form").reset(); $("#coll-import-dialog").showModal(); });
$("#coll-import-cancel").addEventListener("click", () => $("#coll-import-dialog").close());
$("#coll-import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) $("#coll-import-text").value = await file.text();
});
$("#coll-import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#coll-import-text").value;
  if (!text.trim()) { toast("Datei wählen oder Text einfügen.", "error"); return; }
  const replace = $("#coll-import-replace").checked;
  if (replace && !(await ask({ title: "Sammlung ersetzen?", text: "Die bisherige Sammlung wird durch den Import ersetzt.", ok: "Ersetzen", danger: true }))) return;
  const btn = $("#coll-import-ok");
  btn.disabled = true;
  btn.textContent = "Importiere …";
  try {
    const r = await api("/api/collection/import", { method: "POST", body: { text, proxy: $("#coll-import-proxy").checked, replace } });
    $("#coll-import-dialog").close();
    toast(`${r.added} Karten importiert.${r.not_found.length ? ` Nicht gefunden (${r.not_found.length}): ${r.not_found.slice(0, 5).join(", ")}${r.not_found.length > 5 ? " …" : ""}` : ""}`,
      r.not_found.length ? "error" : "info", 8000);
    await loadCollection();
  } catch (err) { fail(err); }
  finally { btn.disabled = false; btn.textContent = "Importieren"; }
});
$("#coll-empty").addEventListener("click", (e) => {
  const b = e.target.closest("[data-open]");
  if (b?.dataset.open === "import") $("#coll-import-btn").click();
  if (b?.dataset.open === "add") openCollAdd();
});
$("#coll-menu").addEventListener("click", (e) => { if (e.target.closest(".menu-list button")) $("#coll-menu").open = false; });
$("#coll-clear").addEventListener("click", async () => {
  if (!(await ask({ title: "Ganze Sammlung leeren?", text: `${collSummary.cards || 0} Karten werden gelöscht. Tipp: vorher exportieren.`, ok: "Leeren", danger: true }))) return;
  await api("/api/collection?confirm=true", { method: "DELETE" }).catch(fail);
  void loadCollection();
});

// ============================================================================================
// Verkaufsliste: cards from the collection to sell on Cardmarket (selling.py). In the desktop app
// „Auf Cardmarket einstellen“ opens Cardmarket in its own window (desktop/src-tauri/src/cardmarket.rs): its bar fills
// Cardmarket's sell form card by card, the user clicks Cardmarket's own button, and conclaveSell() hears „listed“.
// ============================================================================================
let sales = { items: [], count: {}, value: {}, rules: [], conditions: [] };
const SELL_STATUS = { open: "Offen", listed: "Bei Cardmarket", sold: "Verkauft" };

async function refreshSales() {
  try { sales = await api("/api/sales"); } catch { /* offline: keep the last list */ }
  renderSellNav();
}
function renderSellNav() {
  const n = (sales.count?.open || 0) + (sales.count?.listed || 0);
  $("#sell-count").textContent = n || "";
  $("#nav-sell").hidden = !sales.items.length && parseHash().view !== "sell";
}
async function showSell() {
  await refreshSales();
  renderSell();
}
async function sellWindow() {
  try { desktopShell = (await api("/api/desktop")).shell; } catch { /* keep the last answer */ }
  return !!desktopShell?.features?.includes("cardmarket");
}

const parseEuro = (v) => {
  const t = String(v ?? "").replace("€", "").trim().replace(/\./g, "").replace(",", ".");
  return t === "" ? null : Number(t);
};
function sellFiltered() {
  const f = document.querySelector('[name="sellfilter"]:checked').value;
  return sales.items.filter((i) => f === "all" || i.status === f);
}
function saleRow(i) {
  const sold = i.status === "sold";
  const img = i.image ? `<img src="${esc(i.image)}" alt="" loading="lazy">` : `<div class="noimg">${esc(i.name)}</div>`;
  const printing = [i.set_name || (i.set ? i.set.toUpperCase() : "Druck unbekannt"), i.collector_number ? `#${i.collector_number}` : ""].filter(Boolean).join(" · ");
  const prices = [i.trend ? `Trend ${fmtPrice(i.trend, "€")}` : "", i.low ? `ab ${fmtPrice(i.low, "€")}` : ""].filter(Boolean).map(esc).join("<br>")
    || (i.product_id ? "Kein Preis in der Cardmarket-Liste" : "Druck auf Cardmarket nicht gefunden – dort selbst wählen");
  const deck = i.place_deck ? deckIndex.find((d) => d.slug === i.place_deck)?.name || i.place_deck : "";
  const cheap = i.price && i.trend && i.price < i.trend * 0.7;
  const conds = (sales.conditions || []).map((c) => `<option value="${c.key}"${c.key === i.condition ? " selected" : ""}>${c.key} – ${esc(c.label)}</option>`).join("");
  const dis = sold ? " disabled" : "";
  const link = i.url || i.search_url;
  const acts = {
    open: `${desktopShell?.features?.includes("cardmarket")
      ? `<button type="button" class="btn small" data-act="one" title="Nur diese Karte auf Cardmarket einstellen">Cardmarket</button>`
      : `<a class="btn small" href="${esc(link)}" target="_blank" rel="noopener">Cardmarket ↗</a>`}
      <button type="button" class="btn small" data-act="listed" title="Schon auf Cardmarket eingestellt">Eingestellt</button>`,
    listed: `<button type="button" class="btn small" data-act="sold" title="Verkauft: die Karten gehen aus deiner Sammlung">Verkauft</button>
      <button type="button" class="mini" data-act="open" title="Zurück auf „Offen“" aria-label="Zurück auf offen">↺</button>`,
    sold: `<button type="button" class="btn small" data-act="unsold" title="Die Karten kommen zurück in die Sammlung">Rückgängig</button>`,
  }[i.status] || "";
  return `<div class="sale-row st-${esc(i.status)}" data-id="${esc(i.id)}">
    <span class="thumb card" data-img="${esc(i.image || "")}" data-name="${esc(i.name)}">${img}</span>
    <div class="coll-main">
      <div class="coll-name">${esc(i.name)}${i.foil ? '<span class="tagb foil">Foil</span>' : ""}${i.lang && i.lang !== "en" ? `<span class="tagb">${esc(LANG_NAMES[i.lang] || i.lang)}</span>` : ""}${i.status !== "open" ? `<span class="tagb sale-st">${SELL_STATUS[i.status]}</span>` : ""}</div>
      <div class="muted small">${esc(printing)}${deck ? ` · <span class="warn">liegt im Deck „${esc(deck)}“</span>` : ""}</div>
      <input type="text" class="sale-comment" data-f="comment" maxlength="200" value="${esc(i.comment || "")}" placeholder="Kommentar für Käufer (optional)" aria-label="Kommentar"${dis}>
    </div>
    <select data-f="condition" aria-label="Zustand"${dis}>${conds}</select>
    <label class="sale-qty" title="Anzahl"><input type="number" data-f="qty" min="1" max="${sold ? i.qty : Math.max(i.in_collection, 1)}" value="${i.qty}" aria-label="Anzahl"${dis}><span class="muted small">× </span></label>
    <label class="sale-price${cheap ? " cheap" : ""}" title="${cheap ? "Deutlich unter dem Trendpreis" : i.price_custom ? "Dein Preis (leer lassen = Preisregel)" : "Preis nach der Preisregel"}">
      <span><input type="text" inputmode="decimal" data-f="price" value="${i.price != null ? esc(fmtNum(i.price, "", 2)) : ""}" placeholder="Preis" aria-label="Preis in Euro"${dis}> €</span>
      <span class="muted small">${prices}</span></label>
    <div class="sale-acts">${acts}</div>
    <button type="button" class="mini danger" data-act="remove" title="Von der Liste nehmen" aria-label="${esc(i.name)} von der Liste nehmen">✕</button>
  </div>`;
}
function renderSell() {
  renderSellNav();
  const c = sales.count || {}, v = sales.value || {};
  for (const s of ["open", "listed", "sold"]) $(`#sell-n-${s}`).textContent = c[s] || "";
  $("#sell-stats").innerHTML = sales.items.length ? [
    `<span class="pill">${c.open || 0} offen · ${fmtPrice(v.open || 0, "€")}</span>`,
    c.listed ? `<span class="pill accent">${c.listed} bei Cardmarket · ${fmtPrice(v.listed || 0, "€")}</span>` : "",
    c.sold ? `<span class="pill ok">${c.sold} verkauft · ${fmtPrice(v.sold || 0, "€")}</span>` : "",
  ].join("") : "";
  $("#sell-rule").innerHTML = (sales.rules || []).map((r) => `<option value="${r.key}"${r.key === sales.rule ? " selected" : ""}>${esc(r.label)}</option>`).join("");
  $("#sell-cond-all").innerHTML = `<option value="">Zustand für alle offenen …</option>`
    + (sales.conditions || []).map((k) => `<option value="${k.key}">${k.key} – ${esc(k.label)}</option>`).join("");
  const list = sellFiltered();
  $("#sell-empty").hidden = !!sales.items.length;
  $("#sell-list").innerHTML = list.length ? list.map(saleRow).join("")
    : sales.items.length ? `<p class="empty-inline">Hier ist gerade nichts.</p>` : "";
  $("#sell-start").disabled = !c.open;
  $("#sell-copy").disabled = !c.open;
  $("#sell-foot").textContent = sales.error ? sales.error
    : sales.items.length ? `Preise aus der Cardmarket-Preisliste${sales.price_date ? ` vom ${new Date(sales.price_date).toLocaleDateString("de-DE")}` : ""} für genau diesen Druck. Der Trend gilt für ordentliche Exemplare; Zustand und Sprache ändern, was eine Karte wirklich bringt.` : "";
}

async function patchSale(id, body) {
  try {
    await api(`/api/sales/${enc(id)}`, { method: "PATCH", body });
    await showSell();
  } catch (err) { fail(err); await showSell(); }
}
$$('[name="sellfilter"]').forEach((r) => r.addEventListener("change", renderSell));
$("#sell-rule").addEventListener("change", async (e) => {
  try { sales = await api("/api/sales/rule", { method: "PUT", body: { rule: e.target.value } }); renderSell(); } catch (err) { fail(err); }
});
$("#sell-cond-all").addEventListener("change", async (e) => {
  const cond = e.target.value;
  if (!cond) return;
  const open = sales.items.filter((i) => i.status === "open");
  try {
    for (const i of open) await api(`/api/sales/${enc(i.id)}`, { method: "PATCH", body: { condition: cond } });
    toast(`Zustand ${cond} für ${open.length} ${open.length === 1 ? "Karte" : "Karten"} gesetzt.`, "ok");
  } catch (err) { fail(err); }
  await showSell();
});
$("#sell-list").addEventListener("change", (e) => {
  const f = e.target.closest("[data-f]")?.dataset.f;
  const row = e.target.closest("[data-id]");
  if (!f || !row) return;
  const raw = e.target.value;
  if (f === "price") {
    const p = parseEuro(raw);
    if (p !== null && !(p >= 0.02)) { toast("Der Preis muss mindestens 0,02 € sein.", "error"); return showSell(); }
    return patchSale(row.dataset.id, { price: p });
  }
  if (f === "qty") return patchSale(row.dataset.id, { qty: Math.max(1, Math.round(Number(raw)) || 1) });
  void patchSale(row.dataset.id, { [f]: raw });
});
$("#sell-list").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("input[data-f]")) e.target.blur();  // commits the change
});
$("#sell-list").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  const row = e.target.closest("[data-id]");
  const item = row && sales.items.find((i) => i.id === row.dataset.id);
  if (!act || !item) return;
  if (act === "listed" || act === "open") return patchSale(item.id, { status: act });
  if (act === "one") return startSell([item]);
  if (act === "remove") {
    try { await api(`/api/sales/${enc(item.id)}`, { method: "DELETE" }); } catch (err) { fail(err); }
    return showSell();
  }
  if (act === "sold") {
    try {
      const r = await api(`/api/sales/${enc(item.id)}/sold`, { method: "POST" });
      toast(r.removed ? `${r.removed}× ${item.name} verkauft – aus deiner Sammlung genommen.` : `${item.name} als verkauft markiert (war nicht mehr in der Sammlung).`, "ok", 7000,
        { label: "Rückgängig", run: async () => { await api(`/api/sales/${enc(item.id)}/unsold`, { method: "POST" }).catch(fail); void showSell(); void refreshCollectionSummary(); } });
    } catch (err) { fail(err); }
    await Promise.all([showSell(), refreshCollectionSummary()]);
  }
  if (act === "unsold") {
    try { await api(`/api/sales/${enc(item.id)}/unsold`, { method: "POST" }); toast(`${item.name} ist wieder in deiner Sammlung.`, "ok"); } catch (err) { fail(err); }
    await Promise.all([showSell(), refreshCollectionSummary()]);
  }
});
$("#sell-clear-sold").addEventListener("click", async () => {
  $("#sell-menu").open = false;
  try { const r = await api("/api/sales/sold", { method: "DELETE" }); toast(`${r.deleted} verkaufte ${r.deleted === 1 ? "Karte" : "Karten"} aus der Liste entfernt.`); } catch (err) { fail(err); }
  void showSell();
});
$("#sell-copy").addEventListener("click", async () => {
  const open = sales.items.filter((i) => i.status === "open");
  const text = open.map((i) => `${i.qty} ${i.name} (${i.set_name || i.set || "?"}${i.collector_number ? ` #${i.collector_number}` : ""}) ${i.condition} ${(i.lang || "en").toUpperCase()}${i.foil ? " Foil" : ""} – ${i.price != null ? fmtPrice(i.price, "€") : "ohne Preis"}`).join("\n");
  try { await navigator.clipboard.writeText(text); toast(`${open.length} ${open.length === 1 ? "Zeile" : "Zeilen"} kopiert.`); } catch { toast("Kopieren ging nicht.", "error"); }
});
$("#sell-start").addEventListener("click", () => startSell(sales.items.filter((i) => i.status === "open")));

// hands the cards to the desktop app, which opens its Cardmarket window (the shell cancels this navigation)
async function startSell(items) {
  if (!items.length) return;
  if (!(await sellWindow())) {
    $("#sell-hint").hidden = false;
    $("#sell-hint").textContent = "Das Einstellen mit ausgefülltem Formular geht in der Desktop-App. Im Browser öffnet „Cardmarket ↗“ die Karte; dort trägst du die Werte selbst ein und klickst danach „Eingestellt“.";
    return;
  }
  const keys = ["id", "name", "set_name", "set", "collector_number", "lang", "lang_id", "lang_name", "foil", "qty", "condition",
    "condition_name", "price", "comment", "product_id", "url", "search_url"];
  const cards = items.map((i) => Object.fromEntries(keys.map((k) => [k, i[k] ?? null])));
  $("#sell-hint").hidden = false;
  $("#sell-hint").textContent = `Cardmarket öffnet sich in einem eigenen Fenster. Melde dich dort an, falls nötig. Die Conclave-Leiste unten führt dich durch ${cards.length === 1 ? "die Karte" : `die ${cards.length} Karten`} und füllt das Verkaufen-Formular aus – den Knopf zum Einstellen drückst du selbst.`;
  location.href = "https://conclave-sell.invalid/?d=" + encodeURIComponent(JSON.stringify({ cards }));
}
// called by the shell: a card listed on Cardmarket ({type: "listed", id}), taken back („unlisted“), the window closed
window.conclaveSell = async (ev) => {
  if (ev?.type === "listed" && typeof ev.id === "string") {
    const item = sales.items.find((i) => i.id === ev.id);
    try { await api(`/api/sales/${enc(ev.id)}`, { method: "PATCH", body: { status: "listed" } }); } catch (err) { return fail(err); }
    if (item) toast(`${item.name} ist bei Cardmarket eingestellt.`, "ok");
  }
  if (ev?.type === "unlisted" && typeof ev.id === "string") {  // „Doch nicht eingestellt“ in the bar
    try { await api(`/api/sales/${enc(ev.id)}`, { method: "PATCH", body: { status: "open" } }); } catch (err) { return fail(err); }
  }
  if (ev?.type === "closed") $("#sell-hint").hidden = true;
  if (parseHash().view === "sell") void showSell(); else void refreshSales();
  if (parseHash().view === "collection") void loadCollection();
};

// Meine Sammlung: „Verkaufen …“ in the marking bar
$("#coll-bulk-sell").addEventListener("click", async () => {
  const marked = coll.entries.filter((e) => collSel.has(e.id));
  const real = marked.filter((e) => !e.proxy);
  if (!real.length) { toast("Proxies kann man auf Cardmarket nicht verkaufen.", "error"); return; }
  const inDecks = real.filter((e) => e.place_deck);
  if (inDecks.length && !(await ask({ title: `${inDecks.length === 1 ? "Eine Karte liegt" : `${inDecks.length} Karten liegen`} in einem Deck`,
    text: `${inDecks.slice(0, 4).map((e) => `${e.name} (${placeLabel(e)})`).join(", ")}${inDecks.length > 4 ? " …" : ""}. Trotzdem auf die Verkaufsliste?`, ok: "Auf die Liste" }))) return;
  let qty = null;
  if (real.length === 1 && real[0].qty > 1) {
    qty = await askCount(real[0], "verkaufen");
    if (!qty) return;
  }
  try {
    const r = await api("/api/sales", { method: "POST", body: { ids: real.map((e) => e.id), ...(qty ? { qty } : {}) } });
    collSel.clear();
    const skipped = r.skipped.length + (marked.length - real.length);
    toast(r.added ? `${r.cards} ${r.cards === 1 ? "Karte" : "Karten"} auf der Verkaufsliste${skipped ? ` (${skipped} übersprungen: Proxy oder schon drauf)` : ""}.` : "Nichts Neues – die Karten sind schon auf der Liste.",
      r.added ? "ok" : "info", 6000, { label: "Zur Verkaufsliste", run: () => go("#/sell") });
    await Promise.all([loadCollection(), refreshSales()]);
  } catch (err) { fail(err); }
});

// ---------- the deck vs. the collection ----------
async function loadOwnership(d) {
  ownership = null;
  $("#own-panel").hidden = true;
  if (!(collSummary.cards > 0)) return;
  try { ownership = { ...(await api(`/api/decks/${enc(d.slug)}/ownership`)), slug: d.slug }; } catch { return; }
  if (currentDeck?.slug !== d.slug) return;
  renderCards(currentDeck);
  $("#deck-facts").textContent = deckFacts(currentDeck);
  $("#deck-facts").title = deckValueTip(currentDeck);
  if (shownCopy(currentDeck.commanders[0])?.image) $("#deck-thumb").src = shownCopy(currentDeck.commanders[0]).image;
  const o = ownership;
  const pct = (n) => `${(n / Math.max(o.need, 1)) * 100}%`;
  const cur = o.currency === "usd" ? "USD" : "EUR";
  $("#own-panel").hidden = false;
  $("#own-summary").innerHTML = `
    <div class="own-bar" role="img" aria-label="${o.have_real} echt, ${o.have_proxy} als Proxy, ${o.missing} fehlen">
      <span class="r" style="width:${pct(o.have_real)}"></span><span class="p" style="width:${pct(o.have_proxy)}"></span></div>
    <p class="small"><b>${o.have_real + o.have_proxy} von ${o.need}</b> vorhanden · ${o.have_real} echt · ${o.have_proxy} Proxy
      · <b class="${o.missing ? "bad" : "ok"}">${o.missing} fehlen</b>${o.missing_price ? ` (≈ ${esc(fmtPrice(o.missing_price, cur))})` : ""}</p>
    ${o.shared_shortages.length ? `<p class="small warn">In mehreren Decks, aber zu wenige Exemplare: ${esc(o.shared_shortages.slice(0, 6).join(", "))}${o.shared_shortages.length > 6 ? " …" : ""}</p>` : ""}
    ${o.missing ? `<div class="btn-group">
      <button type="button" class="btn small" id="own-buy">Einkaufsliste mit Preisen</button>
      <button type="button" class="btn small" id="own-copy">Liste kopieren</button>
      <button type="button" class="btn small" id="own-print">Fehlende drucken</button></div>` : '<p class="small ok">Du hast alle Karten dieses Decks.</p>'}`;
}
$("#own-summary").addEventListener("click", async (e) => {
  if (e.target.id === "own-copy") {
    try { await navigator.clipboard.writeText(ownership.shopping_text); toast("Einkaufsliste kopiert – z. B. bei Cardmarket als Wants-Liste einfügen."); }
    catch { toast("Kopieren nicht erlaubt.", "error"); }
  }
  if (e.target.closest("#own-buy")) void openBuylist();
  if (e.target.id === "own-print") {
    $("#print-form").elements.only_missing.checked = true;
    printLoadedFor = null;
    selectTab("drucken");
  }
});

$("#add-printed-btn").addEventListener("click", async () => {
  if (!pctx()) return;
  const opts = printOpts();
  const ok = await ask({ title: "Gedruckte Karten übernehmen?", ok: "Übernehmen",
    text: `${printPlan?.quantity ?? "Alle"} Karten dieses Druckauftrags kommen als Proxy (mit dem gewählten Artwork) in deine Sammlung.` });
  if (!ok) return;
  try {
    const r = await api(`/api/decks/${enc(pctx().slug)}/collection/add-printed`, { method: "POST", body: opts });
    toast(`${r.added} Proxies zur Sammlung hinzugefügt.`);
    await refreshCollectionSummary();
    if (currentDeck && !pctx().order) void loadOwnership(currentDeck);
  } catch (err) { fail(err); }
});

// ============================================================================================
// blacklist
// ============================================================================================
async function refreshBlacklist() {
  const bl = await api("/api/blacklist").catch(() => ({ cards: [], rules: [], catalog: [] }));
  const active = new Set(bl.rules.map((r) => r.rule));
  $("#bl-count").textContent = bl.cards.length + bl.rules.length || "";
  $("#bl-empty").hidden = bl.cards.length > 0;
  $("#bl-list").innerHTML = bl.cards.map((n) => `<li>${esc(n)}<button type="button" title="Entfernen" aria-label="${esc(n)} entfernen" data-name="${esc(n)}">×</button></li>`).join("");
  $("#bl-rules-empty").hidden = bl.rules.length > 0;
  $("#bl-rules").innerHTML = bl.rules.map((r) => `<li>
      <div class="bl-rule-main">
        <strong>${esc(r.label)}</strong>
        <span class="pill ${r.checked ? "ok" : "accent"}">${r.checked ? "wird geprüft" : "Notiz"}</span>
        <p class="muted small">${esc(r.description)}</p>
        ${r.cards ? `<details class="more"><summary>${r.cards.length} Karten</summary><p class="small">${r.cards.map(esc).join(" · ")}</p></details>` : ""}
      </div>
      <button type="button" class="btn ghost small" data-name="${esc(r.rule)}" aria-label="${esc(r.label)} entfernen">Entfernen</button>
    </li>`).join("");
  const hasPrice = bl.rules.some((r) => r.key === "price");
  $("#bl-quick").innerHTML = bl.catalog.filter((c) => !active.has(c.rule))
    .map((c) => `<button type="button" class="chip" data-rule="${esc(c.rule)}" title="${esc(c.description)}">${esc(c.label)}</button>`).join("")
    + (hasPrice ? "" : `<button type="button" class="chip" data-price="1" title="Karten über einem Preis sperren">Teurer als … €</button>`);
}
async function addToBlacklist(add) {
  const r = await api("/api/blacklist", { method: "POST", body: { add } });
  const parts = [];
  if (r.added.length) parts.push(`Karten: ${r.added.join(", ")}`);
  if (r.added_rules.length) parts.push(`Regeln: ${r.added_rules.map((x) => x.label).join(", ")}`);
  $("#bl-msg").textContent = parts.length ? `Hinzugefügt – ${parts.join(" · ")}` : "";
  for (const term of r.not_found) {
    const ok = await ask({ title: `„${term}“ nicht gefunden`, ok: "Als Begriff speichern",
      text: "Das ist weder eine Karte noch ein bekannter Begriff. Als Notiz für dich speichern? Automatisch geprüft wird sie nicht." });
    if (ok) await api("/api/blacklist", { method: "POST", body: { add: [`@${term}`] } }).catch(fail);
  }
  await refreshBlacklist();
}
$("#bl-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("#bl-input").value.trim();
  if (!raw) return;
  const add = raw.split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
  try {
    $("#bl-input").value = "";
    await addToBlacklist(add);
  } catch (err) { $("#bl-msg").textContent = err.message; }
});
$("#bl-quick").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  let rule = btn.dataset.rule;
  if (btn.dataset.price) {
    const v = await ask({ title: "Karten über welchem Preis sperren?", text: "Betrag in Euro (günstigster Druck). Proxy-Decks prüfen ihn genauso.", value: "20", ok: "Sperren" });
    const n = Number.parseFloat(String(v || "").replace(",", "."));
    if (!(n > 0)) return;
    rule = `@price>${n}`;
  }
  await addToBlacklist([rule]).catch(fail);
});
for (const list of ["#bl-list", "#bl-rules"]) {
  $(list).addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-name]");
    if (!btn) return;
    await api("/api/blacklist", { method: "POST", body: { remove: [btn.dataset.name] } }).catch(fail);
    $("#bl-msg").textContent = "";
    void refreshBlacklist();
  });
}

// ============================================================================================
// opponent decks ("Gegnerdecks"): commander + what stood out, linked from the game log
// ============================================================================================
let oppIndex = [];
let oppTags = {};
let currentOpp = null;

async function refreshOpponents() {
  const data = await api("/api/opponents").catch(() => ({ opponents: [], tags: {} }));
  oppIndex = data.opponents;
  oppTags = data.tags;
  $("#opp-count").textContent = oppIndex.length || "";
}

function oppMeta(o) {
  const r = o.record;
  return [o.player && `spielt ${o.player}`, o.bracket && `etwa Bracket ${o.bracket}`,
    r.games ? `deine Bilanz ${r.wins}–${r.losses}${r.draws ? "–" + r.draws : ""} in ${r.games} Partie${r.games === 1 ? "" : "n"}` : "noch keine Partie",
    ...o.tag_labels].filter(Boolean).join(" · ");
}


// game form: quick picks of known opponents
function renderKnownOpps() {
  const box = $("#game-known-opps");
  const top = oppIndex.slice(0, 12);
  box.hidden = !top.length;
  box.innerHTML = top.length ? '<em class="opp-known-label">Zuletzt:</em>' + top.map((o) =>
    `<button type="button" class="chip" data-oid="${esc(o.id)}" title="${esc(oppMeta(o))}">${esc(o.title)}</button>`).join("") : "";
}
$("#game-known-opps").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-oid]");
  if (!b) return;
  const o = oppIndex.find((x) => x.id === b.dataset.oid);
  if (o) addGameOpp(o.commanders[0], o.id);
});

async function showOpponents(id) {
  $("#opp-list-view").hidden = !!id;
  $("#opp-view").hidden = !id;
  await refreshOpponents();
  if (!id) {
    currentOpp = null;
    $("#opp-new-box").open = !oppIndex.length;
    $("#opp-empty").hidden = !!oppIndex.length;
    $("#opp-list").innerHTML = oppIndex.map((o) => `<a class="panel order-row opp-row" href="#/opponents/${enc(o.id)}">
        ${o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy">` : ""}
        <div><h3>${esc(o.title)}</h3><p class="muted small">${esc(oppMeta(o))}</p>
          ${o.notes.length ? `<p class="small opp-last">„${esc(o.notes[o.notes.length - 1].text)}“</p>` : ""}</div>
        <span class="muted small">${o.record.last ? esc(fmtDate(o.record.last)) : ""}</span></a>`).join("");
    return;
  }
  const prev = currentOpp?.id;
  try { currentOpp = await api(`/api/opponents/${enc(id)}`); } catch (err) { fail(err); go("#/opponents"); return; }
  renderOpponent();
  if (prev !== id) $("#opp-form").hidden = true;
}

function renderOpponent() {
  const o = currentOpp;
  $("#opp-name").textContent = o.title;
  $("#opp-meta").textContent = oppMeta(o);
  $("#opp-thumb").hidden = !o.image;
  if (o.image) $("#opp-thumb").src = o.image;
  $("#opp-edhrec").href = o.edhrec_url;
  const f = $("#opp-form").elements;
  f.commander.value = o.commanders[0] || "";
  f.partner.value = o.commanders[1] || "";
  f.label.value = o.label || "";
  f.player.value = o.player || "";
  f.bracket.value = o.bracket || "";
  $("#opp-table").innerHTML = '<option value="">–</option>' + tableSets.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  $("#opp-table").value = o.table_rule && tableById(o.table_rule) ? o.table_rule : "";
  $("#opp-tags").innerHTML = Object.entries(oppTags).map(([k, label]) =>
    `<label><input type="checkbox" name="tags" value="${esc(k)}"${o.tags.includes(k) ? " checked" : ""}><span>${esc(label)}</span></label>`).join("");
  $("#opp-notes-empty").hidden = !!o.notes.length;
  const deckName = (slug) => deckIndex.find((d) => d.slug === slug)?.name || slug;
  $("#opp-notes").innerHTML = o.notes.slice().reverse().map((n) => `<li>
      <div><p>${esc(n.text)}</p><span class="muted small">${esc(fmtDate(n.at))}${n.deck_slug ? ` · Partie mit <a href="#/deck/${enc(n.deck_slug)}/partien">${esc(deckName(n.deck_slug))}</a>` : ""}</span></div>
      <button type="button" class="icon-btn" data-note="${esc(n.id)}" aria-label="Notiz löschen" title="Notiz löschen">${icon("x")}</button></li>`).join("");
  const r = o.record;
  $("#opp-record").innerHTML = !r.games ? '<p class="empty-inline">Noch keine Partie gegen dieses Deck festgehalten.</p>'
    : `<div class="kpis"><div><b>${r.games}</b><span>Partien</span></div><div><b>${r.wins}–${r.losses}${r.draws ? "–" + r.draws : ""}</b><span>Siege–Niederlagen</span></div></div>
       ${r.per_deck.length > 1 ? `<p class="game-stats-more">${r.per_deck.map((p) => `${esc(p.name)} ${p.wins}–${p.losses}`).join(" · ")}</p>` : ""}`;
  const labels = { win: "Sieg", loss: "Niederlage", draw: "Unentschieden" };
  $("#opp-games-panel").hidden = !r.history.length;
  $("#opp-games").innerHTML = r.history.map((g) => `<li>
      <div class="when"><span class="res ${esc(g.result)}">${esc(labels[g.result] || g.result)}</span><br><span class="meta">${esc(fmtDate(g.played))}</span></div>
      <div>mit <a href="#/deck/${enc(g.deck_slug)}/partien">${esc(g.deck)}</a>${g.turn ? ` · Zug ${esc(g.turn)}` : ""}${g.note ? `<br><span class="meta">${esc(g.note)}</span>` : ""}</div><span></span></li>`).join("");
}

async function patchOpp(body, msg = "") {
  currentOpp = await api(`/api/opponents/${enc(currentOpp.id)}`, { method: "PATCH", body });
  renderOpponent();
  void refreshOpponents();
  if (msg) toast(msg);
}
$("#opp-new").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    const o = await api("/api/opponents", { method: "POST", body: { commanders: [f.commander.value], label: f.label.value, note: f.note.value } });
    e.target.reset();
    toast(`„${o.title}“ gemerkt.`);
    go(`#/opponents/${enc(o.id)}`);
  } catch (err) { fail(err); }
});
$("#opp-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const fd = new FormData(e.target);
  try {
    await patchOpp({ commanders: [f.commander.value, f.partner.value].filter((x) => x.trim()), label: f.label.value, player: f.player.value,
      bracket: f.bracket.value ? Number(f.bracket.value) : null, table_rule: f.table_rule.value || null, tags: fd.getAll("tags") }, "Gespeichert.");
  } catch (err) { fail(err); }
});
$("#opp-edit").addEventListener("click", () => {
  const form = $("#opp-form");
  form.hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  form.elements.label.focus({ preventScroll: true });
});
$("#opp-note-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const note = e.target.elements.note.value.trim();
  if (!note) return;
  try { await patchOpp({ note }); e.target.reset(); } catch (err) { fail(err); }
});
$("#opp-notes").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-note]");
  if (b) await patchOpp({ remove_note: b.dataset.note }).catch(fail);
});
$("#opp-delete").addEventListener("click", async () => {
  $("#opp-menu").open = false;
  const o = currentOpp;
  if (!(await ask({ title: `„${o.title}“ löschen?`, danger: true, ok: "Löschen",
    text: "Notizen und Steckbrief gehen verloren. Deine Partien bleiben erhalten, nur ohne Verknüpfung." }))) return;
  try {
    await api(`/api/opponents/${enc(o.id)}`, { method: "DELETE" });
    toast(`„${o.title}“ gelöscht.`);
    go("#/opponents");
  } catch (err) { fail(err); }
});
// ============================================================================================
// table rules ("Tischregeln"): rule sets per playgroup, chosen per deck
// ============================================================================================
let tableSets = [];
let tableCatalog = [];
let currentTable = null;

async function refreshTableRules() {
  const data = await api("/api/tablerules").catch(() => ({ sets: [], catalog: [] }));
  tableSets = data.sets;
  tableCatalog = data.catalog;
  $("#tr-count").textContent = tableSets.length || "";
  if (currentDeck) renderDeckTable(currentDeck);
}

function tableById(id) { return tableSets.find((t) => t.id === id) || null; }

function renderDeckTable(d) {
  const sel = $("#deck-table");
  const id = d.table_rule || "";
  sel.innerHTML = '<option value="">Keine Tischregel</option>'
    + tableSets.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  sel.value = tableById(id) ? id : "";
  const box = $("#deck-table-status");
  const t = d.validation?.table_rule;
  if (!id || !t?.name) {
    box.innerHTML = tableSets.length ? "" : `<p class="muted small">Noch keine Tischregeln – <a href="#/tables">jetzt eine anlegen</a>.</p>`;
    return;
  }
  const bad = t.violations || [];
  const summary = (t.summary || []).join(" · ");
  const warnings = (t.warnings || []).map((w) => `<p class="muted small">${esc(w)}</p>`).join("");
  const link = `<a class="link small" href="#/tables/${enc(id)}">Tischregel bearbeiten</a>`;
  if (!bad.length) {
    box.innerHTML = `${summary ? `<p class="muted small">${esc(summary)}</p>` : ""}${warnings}<p class="small">${link}</p>`;
    return;
  }
  box.innerHTML = `<p class="bad-text">${icon("alert")}
      ${bad.length} ${bad.length === 1 ? "Verstoß" : "Verstöße"} gegen „${esc(t.name)}“</p>
    <ul class="tr-violations">${bad.map((v) => `<li>${esc(v.split(": ").slice(1).join(": ") || v)}</li>`).join("")}</ul>
    ${warnings}
    ${summary ? `<p class="muted small">${esc(summary)}</p>` : ""}
    <div class="btn-row">
      <button type="button" class="btn" id="deck-table-fix">${icon("edit")}Karten bearbeiten</button>
      ${link}
    </div>`;
}
$("#deck-table").addEventListener("change", async (e) => {
  const d = currentDeck;
  const id = e.target.value || null;
  try {
    await api(`/api/decks/${enc(d.slug)}/table-rule`, { method: "PUT", body: { table_rule: id } });
    await openDeck(d.slug);
    void refreshDeckList();
    const t = currentDeck.validation?.table_rule;
    toast(!id ? "Tischregel entfernt." : t?.compliant ? `Passt zu „${t.name}“.` : `Tischregel gesetzt – ${t?.violations?.length || 0} Verstöße.`);
  } catch (err) { fail(err); renderDeckTable(d); }
});
$("#deck-table-status").addEventListener("click", (e) => {
  if (!e.target.closest("#deck-table-fix")) return;
  selectTab("karten");
  if (!edit) setEditing(true);
});

async function showTables(id) {
  $("#tr-list-view").hidden = !!id;
  $("#tr-view").hidden = !id;
  await refreshTableRules();
  if (!id) {
    currentTable = null;
    $("#tr-empty").hidden = !!tableSets.length;
    $("#tr-list").innerHTML = tableSets.map((t) => `<a class="panel order-row" href="#/tables/${enc(t.id)}">
        <div><h3>${esc(t.name)}</h3><p class="muted small">${esc(t.summary.join(" · ") || "noch leer")}</p></div>
        <span class="muted small">${t.decks ? `${t.decks} Deck${t.decks === 1 ? "" : "s"}` : ""}</span></a>`).join("");
    return;
  }
  currentTable = tableById(id);
  if (!currentTable) { toast("Diese Tischregel gibt es nicht mehr.", "error"); go("#/tables"); return; }
  $("#tr-decks").innerHTML = "";
  renderTable();
}

function renderTable() {
  const t = currentTable;
  $("#tr-name").textContent = t.name;
  $("#tr-meta").textContent = t.decks ? `Gilt für ${t.decks} Deck${t.decks === 1 ? "" : "s"}.` : "Noch von keinem Deck gewählt.";
  const f = $("#tr-form").elements;
  f.name.value = t.name;
  f.description.value = t.description || "";
  f.max_bracket.value = t.max_bracket || "";
  f.max_game_changers.value = t.max_game_changers ?? "";
  f.max_tutors.value = t.max_tutors ?? "";
  f.deck_budget.value = t.deck_budget ?? "";
  f.no_proxies.checked = !!t.no_proxies;
  const active = new Set(t.rules);
  $("#tr-rules").innerHTML = t.rule_info.map((r) => `<li>
      <div class="bl-rule-main">
        <strong>${esc(r.label)}</strong>
        <span class="pill ${r.checked ? "ok" : "accent"}">${r.checked ? "wird geprüft" : "Absprache"}</span>
        <p class="muted small">${esc(r.description)}</p>
      </div>
      <button type="button" class="btn ghost small" data-remove="${esc(r.rule)}" aria-label="${esc(r.label)} entfernen">Entfernen</button>
    </li>`).join("");
  $("#tr-cards").innerHTML = t.cards.map((n) => `<li>${esc(n)}<button type="button" title="Entfernen" aria-label="${esc(n)} entfernen" data-remove="${esc(n)}">×</button></li>`).join("");
  $("#tr-rules-empty").hidden = !!(t.rules.length || t.cards.length);
  $("#tr-quick").innerHTML = tableCatalog.filter((c) => !active.has(c.rule))
    .map((c) => `<button type="button" class="chip" data-rule="${esc(c.rule)}" title="${esc(c.description)}">${esc(c.label)}</button>`).join("")
    + (t.rules.some((r) => r.startsWith("@price>")) ? "" : `<button type="button" class="chip" data-price="1" title="Karten über einem Preis verbieten">Karten teurer als … €</button>`);
}

async function patchTable(body, msg = "") {
  const r = await api(`/api/tablerules/${enc(currentTable.id)}`, { method: "PATCH", body });
  await refreshTableRules();
  currentTable = tableById(currentTable.id);
  renderTable();
  if (r.revalidated?.length) toast(`${r.revalidated.length} Deck${r.revalidated.length === 1 ? "" : "s"} neu geprüft.`);
  else if (msg) toast(msg);
  return r;
}

$("#tr-new").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const t = await api("/api/tablerules", { method: "POST", body: { name: e.target.elements.name.value } });
    e.target.reset();
    go(`#/tables/${enc(t.id)}`);
  } catch (err) { fail(err); }
});
$("#tr-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const num = (v) => (v === "" ? null : Number(v));
  try {
    await patchTable({
      name: f.name.value, description: f.description.value, max_bracket: num(f.max_bracket.value),
      max_game_changers: num(f.max_game_changers.value), max_tutors: num(f.max_tutors.value),
      deck_budget: num(f.deck_budget.value), no_proxies: f.no_proxies.checked,
    }, "Gespeichert.");
  } catch (err) { fail(err); }
});
async function addToTable(add) {
  const r = await patchTable({ add });
  const parts = [];
  if (r.added?.length) parts.push(`Karten: ${r.added.join(", ")}`);
  if (r.added_rules?.length) parts.push(`Regeln: ${r.added_rules.map((x) => x.label).join(", ")}`);
  $("#tr-msg").textContent = parts.length ? `Hinzugefügt – ${parts.join(" · ")}` : "";
  for (const term of r.not_found || []) {
    const ok = await ask({ title: `„${term}“ nicht gefunden`, ok: "Als Absprache speichern",
      text: "Das ist weder eine Karte noch ein bekannter Begriff. Als freie Absprache speichern? Automatisch geprüft wird sie nicht." });
    if (ok) await patchTable({ add: [`@${term}`] }).catch(fail);
  }
}
$("#tr-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const add = $("#tr-input").value.split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
  if (!add.length) return;
  $("#tr-input").value = "";
  await addToTable(add).catch(fail);
});
$("#tr-quick").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  let rule = btn.dataset.rule;
  if (btn.dataset.price) {
    const v = await ask({ title: "Karten über welchem Preis verbieten?", text: "Betrag in Euro (günstigster Druck).", value: "10", ok: "Verbieten" });
    const n = Number.parseFloat(String(v || "").replace(",", "."));
    if (!(n > 0)) return;
    rule = `@price>${n}`;
  }
  await addToTable([rule]).catch(fail);
});
for (const list of ["#tr-rules", "#tr-cards"]) {
  $(list).addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-remove]");
    if (!btn) return;
    $("#tr-msg").textContent = "";
    await patchTable({ remove: [btn.dataset.remove] }).catch(fail);
  });
}
$("#tr-delete").addEventListener("click", async () => {
  $("#tr-menu").open = false;
  const t = currentTable;
  const ok = await ask({ title: `Tischregel „${t.name}“ löschen?`, danger: true, ok: "Löschen",
    text: t.decks ? `${t.decks} Deck${t.decks === 1 ? "" : "s"} verlieren damit ihre Tischregel (als neue Version gespeichert).` : "" });
  if (!ok) return;
  try {
    await api(`/api/tablerules/${enc(t.id)}`, { method: "DELETE" });
    toast(`„${t.name}“ gelöscht.`);
    if (currentDeck?.table_rule === t.id) await openDeck(currentDeck.slug);
    go("#/tables");
  } catch (err) { fail(err); }
});
$("#tr-check").addEventListener("click", async () => {
  const btn = $("#tr-check");
  btn.disabled = true;
  $("#tr-decks").innerHTML = '<li class="muted small">Prüfe …</li>';
  try {
    const rows = await api(`/api/tablerules/${enc(currentTable.id)}/decks`);
    $("#tr-decks").innerHTML = rows.length ? rows.map((r) => `<li>
        <span class="pill ${r.ok ? "ok" : "bad"}">${icon(r.ok ? "check" : "alert")}${r.ok ? "passt" : `${r.errors.length} ${r.errors.length === 1 ? "Verstoß" : "Verstöße"}`}</span>
        <div><a href="#/deck/${enc(r.slug)}/karten">${esc(r.name)}</a>${r.uses ? ' <span class="muted small">· nutzt diese Tischregel</span>' : ""}
          <span class="muted small">· ${esc(r.commanders.join(" + "))} · Bracket ${esc(r.bracket ?? "?")}</span>
          ${r.errors.length ? `<ul class="tr-violations">${r.errors.map((v) => `<li>${esc(v.split(": ").slice(1).join(": ") || v)}</li>`).join("")}</ul>` : ""}
          ${r.warnings.map((w) => `<p class="muted small">${esc(w.split(": ").slice(1).join(": ") || w)}</p>`).join("")}
        </div></li>`).join("") : '<li class="muted small">Noch keine Decks gespeichert.</li>';
  } catch (err) { fail(err); $("#tr-decks").innerHTML = ""; }
  btn.disabled = false;
});

// ============================================================================================
// settings: backups (export / import / automatic) and the deck trash
// ============================================================================================
const fmtSize = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

async function refreshBackups() {
  let data;
  try { data = await api("/api/backups"); } catch (err) { fail(err); return; }
  const autos = data.backups.filter((b) => b.kind === "auto");
  $("#backup-auto").textContent = `Automatisch: einmal am Tag beim Start der App, die letzten ${data.keep_auto} bleiben erhalten`
    + (autos.length ? ` (zuletzt ${fmtDate(autos[0].created)}).` : " (noch keine).") + ` Ordner: ${data.dir}`;
  $("#backup-list").innerHTML = data.backups.map((b) => `<li>
      <div class="grow"><strong>${esc(fmtDate(b.created) || b.name)}</strong> <span class="muted small">· ${esc(b.kind_label)}
        · ${b.decks ?? "?"} Decks · ${esc(fmtSize(b.size))}</span></div>
      <div class="actions">
        <a class="btn small" href="/api/backups/${enc(b.name)}" download>Herunterladen</a>
        <button type="button" class="btn small" data-restore="${esc(b.name)}">Wiederherstellen …</button>
      </div></li>`).join("") || '<li class="muted small">Noch keine Sicherung.</li>';
}

$("#backup-create").addEventListener("click", async () => {
  try {
    const b = await api("/api/backups", { method: "POST" });
    await refreshBackups();
    toast(`Gesichert: ${b.decks} Decks, ${b.files} Dateien.`);
  } catch (err) { fail(err); }
});
$("#backup-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const res = await fetch("/api/backups/upload", { method: "POST", body: file, headers: { "Content-Type": "application/zip" } });
    const b = await res.json();
    if (!res.ok) throw new Error(b.detail || res.statusText);
    await refreshBackups();
    await restoreBackup(b.name, b);
  } catch (err) { fail(err); }
});
$("#backup-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-restore]");
  if (btn) void restoreBackup(btn.dataset.restore);
});
async function restoreBackup(name, info = null) {
  const ok = await ask({ title: "Sicherung wiederherstellen?", ok: "Wiederherstellen", danger: true,
    text: `${info?.created ? `Stand vom ${fmtDate(info.created)}${info.decks != null ? `, ${info.decks} Decks` : ""}. ` : ""}`
      + "Deine aktuellen Daten werden durch die Sicherung ersetzt. Vorher wird der jetzige Stand automatisch gesichert – du kannst also zurück." });
  if (!ok) return;
  try {
    const r = await api(`/api/backups/${enc(name)}/restore`, { method: "POST" });
    currentDeck = null;
    await Promise.all([refreshDeckList(), refreshTableRules(), refreshOpponents(), refreshBlacklist(), refreshCollectionSummary()]);
    await refreshBackups();
    toast(`Wiederhergestellt: ${r.decks} Decks. Der vorherige Stand liegt als Sicherung bereit.`);
  } catch (err) { fail(err); }
}

async function refreshTrash() {
  let items;
  try { items = await api("/api/trash"); } catch (err) { fail(err); return; }
  $("#nav-trash").hidden = !items.length;
  $("#trash-count").textContent = items.length || "";
  $("#trash-list").innerHTML = items.map((t) => `<li>
      <span class="name">${esc(t.name)}</span>
      <span class="actions">
        <button type="button" class="btn small" data-trash-restore="${esc(t.id)}">Zurückholen</button>
        <button type="button" class="btn ghost small" data-trash-purge="${esc(t.id)}" aria-label="${esc(t.name)} endgültig löschen">Endgültig löschen …</button>
      </span></li>`).join("");
}
async function restoreFromTrash(id) {
  try {
    const r = await api(`/api/trash/${enc(id)}/restore`, { method: "POST" });
    await refreshDeckList();
    toast(`„${r.name}“ ist wieder da.`);
    go(`#/deck/${enc(r.slug)}`);
  } catch (err) { fail(err); }
}
$("#trash-list").addEventListener("click", async (e) => {
  const back = e.target.closest("button[data-trash-restore]");
  if (back) { void restoreFromTrash(back.dataset.trashRestore); return; }
  const purge = e.target.closest("button[data-trash-purge]");
  if (!purge) return;
  if (!(await ask({ title: "Endgültig löschen?", text: "Das Deck mit Versionen und Partien ist danach weg (außer in einer Sicherung).", ok: "Endgültig löschen", danger: true }))) return;
  try { await api(`/api/trash/${enc(purge.dataset.trashPurge)}`, { method: "DELETE" }); void refreshTrash(); } catch (err) { fail(err); }
});
$("#trash-empty").addEventListener("click", async () => {
  if (!(await ask({ title: "Papierkorb leeren?", text: "Alle Decks im Papierkorb werden endgültig gelöscht (außer in einer Sicherung).", ok: "Leeren", danger: true }))) return;
  try { await api("/api/trash", { method: "DELETE" }); void refreshTrash(); } catch (err) { fail(err); }
});

// ============================================================================================
// settings: sync with the own sync server (status, connect, pair another device, devices, conflicts)
// ============================================================================================
let syncInfo = null;
let syncSeenAt = null;  // the last run whose news were shown (no toast for runs before this page load)
let syncPairTimer = null;
const SYNC_POLL_MS = 30000;

const fmtAgo = (ts) => {
  if (!ts) return "nie";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "gerade eben";
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
  const d = Math.round(s / 86400);
  return d === 1 ? "gestern" : `vor ${d} Tagen`;
};
const fmtClock = (ts) => new Date(ts * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const syncHost = (url) => { try { return new URL(url).host; } catch { return url || ""; } };

function syncSummary(run) {
  if (!run) return "Noch nicht abgeglichen.";
  if (run.error) return `<span class="warn">Letzter Abgleich ${esc(fmtAgo(run.at))} hat nicht geklappt: ${esc(run.error)}</span>`;
  const parts = [];
  const more = (n) => (n ? ` und ${n} weitere` : "");
  if (run.incoming?.length) parts.push(`geholt: ${esc(run.incoming.join(", "))}${more(run.incoming_more)}`);
  if (run.outgoing?.length) parts.push(`gesendet: ${esc(run.outgoing.join(", "))}${more(run.outgoing_more)}`);
  if (run.conflicts) parts.push(`<a href="#" data-sync-conflicts>${run.conflicts} ${run.conflicts === 1 ? "Konflikt" : "Konflikte"}</a>`);
  return `Zuletzt abgeglichen ${esc(fmtAgo(run.at))} (${fmtClock(run.at)}) – ${parts.length ? parts.join(" · ") : "alles war schon aktuell"}.`;
}

function renderSyncDot() {
  const dot = $("#sync-dot");
  const on = syncInfo?.connected;
  dot.hidden = !on;
  if (!on) return;
  const bad = syncInfo.revoked || (syncInfo.last && !syncInfo.last.ok);
  dot.className = "sync-dot" + (syncInfo.running ? " busy" : bad ? " bad" : "");
  dot.title = syncInfo.running ? "Sync läuft …" : bad ? "Sync: Problem – siehe Einstellungen" : `Sync: abgeglichen ${fmtAgo(syncInfo.last_ok)}`;
  dot.setAttribute("aria-label", dot.title);
  dot.setAttribute("role", "img");
}

function renderSync() {
  renderSyncDot();
  const st = syncInfo;
  if (!st) return;
  const on = st.connected && !st.revoked;
  $("#sync-off").hidden = on;
  $("#sync-on").hidden = !on;
  $("#sync-revoked").hidden = !st.revoked;
  const f = $("#sync-connect").elements;
  if (!f.name.value) f.name.value = st.device?.name || st.default_name || "";
  if (!on) return;
  const d = st.device;
  const ok = st.last ? st.last.ok : null;
  $("#sync-line").innerHTML = `<span class="dot ${ok === false ? "bad" : ok ? "ok" : ""}" aria-hidden="true"></span>`
    + `<span>Verbunden mit ${esc(syncHost(d.server))} als „${esc(d.name)}“</span>`
    + (st.running ? '<span class="spinner" aria-label="Abgleich läuft"></span>' : "");
  $("#sync-result").innerHTML = syncSummary(st.last)
    + (st.pending_revalidation?.length ? ` <span class="muted">${st.pending_revalidation.length === 1 ? "Ein zusammengeführtes Deck wird" : `${st.pending_revalidation.length} zusammengeführte Decks werden`} noch geprüft (braucht Internet).</span>` : "");
  $("#sync-interval").value = String(st.interval);
  if (![...$("#sync-interval").options].some((o) => o.selected)) $("#sync-interval").value = "5";
  $("#sync-conflict-count").textContent = st.conflicts || "";
  $("#sync-details").textContent = `Server: ${d.server} · Gerät: ${d.name} (${d.device_id}) · verbunden seit ${fmtDate(new Date(d.paired_at * 1000).toISOString())}`;
}

async function refreshSync({ quiet = false } = {}) {
  try { syncInfo = await api("/api/sync"); } catch (err) { if (!quiet) fail(err); return; }
  if (syncSeenAt === null) syncSeenAt = syncInfo.last?.at || 0;
  renderSync();
  syncNews(syncInfo.last);
}

// news from the other devices: one toast per run that brought something in
function syncNews(run) {
  if (!run || !run.at || run.at <= syncSeenAt) return;
  syncSeenAt = run.at;
  if (!run.ok || !run.incoming?.length) return;
  const rest = run.incoming.length - 3 + (run.incoming_more || 0);
  const items = run.incoming.slice(0, 3).join(", ") + (rest > 0 ? ` und ${rest} weitere` : "");
  void refreshDeckList();
  toast(`Neu von deinen anderen Geräten: ${items}`, "info", 9000, { label: "Anzeigen", run: reloadAfterSync });
}

async function reloadAfterSync() {
  await Promise.all([refreshDeckList(), refreshTableRules(), refreshOpponents(), refreshBlacklist(), refreshCollectionSummary(), refreshOrders()]);
  if (edit) { toast("Du bearbeitest gerade dieses Deck – speichere oder verwirf zuerst, dann siehst du den neuen Stand."); return; }
  currentDeck = null;
  void route();
}

async function syncRun() {
  const btn = $("#sync-run");
  btn.disabled = true;
  if (syncInfo) { syncInfo.running = true; renderSync(); }
  try {
    const r = await api("/api/sync/run", { method: "POST" });
    syncInfo = r;
    renderSync();
    if (r.run.error) toast(r.run.error, "error", 7000);
    else if (!r.run.incoming?.length) toast(r.run.outgoing?.length ? "Abgeglichen – deine Änderungen sind auf dem Server." : "Abgeglichen – alles war schon aktuell.");
    syncNews(r.run);
    if (r.run.conflicts) void refreshSyncConflicts();
  } catch (err) { fail(err); void refreshSync({ quiet: true }); } finally { btn.disabled = false; }
}
$("#sync-run").addEventListener("click", syncRun);

$("#sync-connect").elements.link.addEventListener("input", (e) => {
  const v = e.target.value.trim();
  $("#sync-url-row").hidden = !/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(v);  // a bare code needs the address
});
$("#sync-connect").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const btn = $("#sync-connect-btn");
  btn.disabled = true;
  btn.textContent = "Verbinde und gleiche ab …";
  try {
    const r = await api("/api/sync/connect", { method: "POST", body: { link: f.link.value.trim(), url: f.url.value.trim(), name: f.name.value.trim() } });
    syncInfo = r;
    syncSeenAt = r.run?.at || syncSeenAt;
    f.link.value = "";
    renderSync();
    if (r.run?.error) toast(`Verbunden, aber der erste Abgleich hat nicht geklappt: ${r.run.error}`, "error", 8000);
    else toast(r.run?.incoming?.length ? "Verbunden – die Daten der anderen Geräte sind jetzt auch hier." : "Verbunden – deine Daten sind auf dem Server.");
    if (r.run?.incoming?.length) void reloadAfterSync();
  } catch (err) { fail(err); } finally { btn.disabled = false; btn.textContent = "Verbinden"; }
});

$("#sync-interval").addEventListener("change", async (e) => {
  try {
    await api("/api/settings", { method: "POST", body: { sync_interval: Number(e.target.value) } });
    toast(Number(e.target.value) ? "Gespeichert – abgeglichen wird beim Start, nach Änderungen und regelmäßig." : "Gespeichert – abgeglichen wird nur noch per Knopf.");
    void refreshSync({ quiet: true });
  } catch (err) { fail(err); }
});

$("#sync-pair").addEventListener("click", async () => {
  try {
    const p = await api("/api/sync/pair", { method: "POST" });
    $("#sync-qr").innerHTML = p.qr || "";
    $("#sync-qr").hidden = !p.qr;
    $("#sync-code").textContent = p.code;
    $("#sync-copy").dataset.link = p.link;
    $("#sync-pairing").hidden = false;
    clearInterval(syncPairTimer);
    const tick = () => {
      const left = Math.round(p.expires - Date.now() / 1000);
      $("#sync-code-hint").textContent = left > 0
        ? `Gültig noch ${Math.ceil(left / 60)} Min. (bis ${fmtClock(p.expires)}), nur einmal verwendbar.`
        : "Abgelaufen – bitte einen neuen Code erzeugen.";
      if (left <= 0) clearInterval(syncPairTimer);
    };
    tick();
    syncPairTimer = setInterval(tick, 15000);
  } catch (err) { fail(err); }
});
$("#sync-pair-close").addEventListener("click", () => { $("#sync-pairing").hidden = true; clearInterval(syncPairTimer); void refreshSyncDevices(); });
$("#sync-copy").addEventListener("click", async (e) => {
  try { await navigator.clipboard.writeText(e.target.dataset.link); toast("Link kopiert."); }
  catch { await ask({ title: "Kopplungslink", text: "Zum Kopieren markieren:", value: e.target.dataset.link, ok: "Schließen" }); }
});

async function refreshSyncDevices() {
  let data;
  try { data = await api("/api/sync/devices"); } catch (err) { $("#sync-devices").innerHTML = `<li class="muted small">${esc(err.message)}</li>`; return; }
  const kinds = { pc: "PC", phone: "Handy", other: "Gerät" };
  $("#sync-device-count").textContent = data.devices.length || "";
  $("#sync-devices").innerHTML = data.devices.map((d) => {
    const state = d.online ? '<span class="ok">online</span>' : `zuletzt ${esc(fmtAgo(d.last_seen))}`;
    return `<li>
      <div class="grow"><strong>${esc(d.name)}</strong> <span class="muted small">· ${kinds[d.kind] || "Gerät"}${d.this ? " · dieses Gerät" : ""}
        · ${state}</span></div>
      ${d.this ? "" : `<div class="actions"><button type="button" class="btn ghost small" data-sync-revoke="${esc(d.id)}" data-name="${esc(d.name)}">Abmelden …</button></div>`}
    </li>`;
  }).join("") || '<li class="muted small">Keine Geräte.</li>';
}
$("#sync-devices-box").addEventListener("toggle", (e) => { if (e.target.open) void refreshSyncDevices(); });
$("#sync-devices").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-sync-revoke]");
  if (!btn) return;
  if (!(await ask({ title: `„${btn.dataset.name}“ abmelden?`, text: "Das Gerät kann danach nicht mehr abgleichen, bis du es neu koppelst. Seine eigenen Daten bleiben dort erhalten.", ok: "Abmelden", danger: true }))) return;
  try { await api(`/api/sync/devices/${enc(btn.dataset.syncRevoke)}`, { method: "DELETE" }); toast(`„${btn.dataset.name}“ ist abgemeldet.`); void refreshSyncDevices(); } catch (err) { fail(err); }
});

const conflictVal = (v) => {
  if (v === null || v === undefined) return "–";
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > 140 ? t.slice(0, 140) + " …" : t;
};
async function refreshSyncConflicts() {
  let items;
  try { items = await api("/api/sync/conflicts"); } catch (err) { fail(err); return; }
  $("#sync-conflict-count").textContent = items.length || "";
  $("#sync-conflicts-none").hidden = items.length > 0;
  $("#sync-conflicts-clear").hidden = !items.length;
  $("#sync-conflicts").innerHTML = items.slice(0, 100).map((c) => `<li>
      <div class="grow"><strong>${esc(c.label)}</strong> <span class="muted small">· ${esc(fmtDate(c.at))} · ${esc(c.note)}</span>
        <div class="small">Feld <code>${esc(c.where)}</code> · gilt jetzt: <span class="conflict-val">${esc(conflictVal(c.kept))}</span>
          · hier war: <span class="conflict-val">${esc(conflictVal(c.local))}</span></div></div></li>`).join("");
}
$("#sync-conflicts-box").addEventListener("toggle", (e) => { if (e.target.open) void refreshSyncConflicts(); });
$("#sync-result").addEventListener("click", (e) => {
  if (!e.target.closest("[data-sync-conflicts]")) return;
  e.preventDefault();
  $("#sync-conflicts-box").open = true;
  $("#sync-conflicts-box").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#sync-conflicts-clear").addEventListener("click", async () => {
  try { await api("/api/sync/conflicts", { method: "DELETE" }); void refreshSyncConflicts(); void refreshSync({ quiet: true }); } catch (err) { fail(err); }
});

$("#sync-disconnect").addEventListener("click", async () => {
  if (!(await ask({ title: "Dieses Gerät trennen?", text: "Es meldet sich am Server ab und gleicht nicht mehr ab. Alle Daten hier bleiben erhalten; verbindest du es später wieder, geht es dort weiter.", ok: "Trennen", danger: true }))) return;
  try { syncInfo = await api("/api/sync/disconnect", { method: "POST" }); renderSync(); toast("Getrennt – die Daten auf diesem Gerät bleiben erhalten."); } catch (err) { fail(err); }
});

// keep the status fresh while the app is visible; coming back to the window syncs if it has been a while
setInterval(() => { if (document.visibilityState === "visible" && syncInfo?.connected) void refreshSync({ quiet: true }); }, SYNC_POLL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !syncInfo?.connected || syncInfo.revoked || !syncInfo.interval) return;
  if (!syncInfo.running && Date.now() / 1000 - (syncInfo.last?.at || 0) > 60) {
    api("/api/sync/run", { method: "POST" }).then((r) => { syncInfo = r; renderSync(); syncNews(r.run); }, () => {});
  }
});

// ============================================================================================
// settings: proxy printing, AI upscaling, local card DB
// ============================================================================================
let appSettings = {};
function applyFont(font) {
  document.documentElement.dataset.font = font === "inter" ? "inter" : "cascadia";
}
async function loadSettings() {
  appSettings = await api("/api/settings");
  applyFont(appSettings.font);
  applyHoverPreview(appSettings.hover_preview);
  const fontChoice = $("#font-choice");
  if (fontChoice) fontChoice.value = appSettings.font === "inter" ? "inter" : "cascadia";
  const hoverChoice = $("#hover-preview");
  if (hoverChoice) hoverChoice.checked = hoverPreview;
  const f = $("#settings-form").elements;
  const MODEL_HINTS = { "realesrgan-x4plus": " (empfohlen)", "realesrgan-x4plus-anime": " (für Zeichnungen, glättet stärker)" };
  f.upscale_model.innerHTML = appSettings.upscale_models.map((m) => `<option value="${esc(m)}">${esc(m + (MODEL_HINTS[m] || ""))}</option>`).join("")
    || '<option value="">– Programm nicht gefunden –</option>';
  for (const k of ["autofill_path", "mpcfill_server", "cardback_path", "browser", "site", "upscaler_path", "upscale_model", "descreen", "image_generator_url"]) if (f[k]) f[k].value = appSettings[k] ?? "";
  f.upscale.checked = !!appSettings.upscale;
  $("#upscaler-status").innerHTML = appSettings.upscaler_found
    ? `<span class="ok">✓ gefunden:</span> ${esc(appSettings.upscaler_found)}`
    : 'Nicht installiert – nur nötig, wenn du hochskalieren willst (<a href="https://github.com/xinntao/Real-ESRGAN/releases" target="_blank" rel="noopener">Download</a>).';
  $("#print-form").elements.upscale.checked = !!appSettings.upscale;
  $("#autofill-status").innerHTML = appSettings.autofill_found
    ? `<span class="ok">✓ gefunden:</span> ${esc(appSettings.autofill_found)}`
    : '<span class="warn">Nicht gefunden</span> – Pfad eintragen oder die exe in den Ordner <code>tools/</code> legen.';
  const stock = $("#print-form").elements.stock;
  stock.innerHTML = appSettings.stocks.map((s) => `<option ${s === appSettings.stock ? "selected" : ""}>${esc(s)}</option>`).join("");
  $("#print-form").elements.foil.checked = !!appSettings.foil;
  $("#pdf-paper").value = appSettings.paper || "A4";
}
let hoverSave = 0;
$("#hover-preview").addEventListener("change", async (e) => {
  const on = e.target.checked;
  const seq = ++hoverSave;
  applyHoverPreview(on);
  try {
    const saved = await api("/api/settings", { method: "POST", body: { hover_preview: on } });
    if (seq !== hoverSave) return; // a newer toggle or the settings form already saved
    appSettings = saved;
    applyHoverPreview(appSettings.hover_preview);
    e.target.checked = hoverPreview;
  } catch (err) {
    if (seq !== hoverSave) return;
    applyHoverPreview(appSettings.hover_preview);
    e.target.checked = hoverPreview;
    fail(err);
  }
});
$("#font-choice").addEventListener("change", async (e) => {
  const font = e.target.value === "inter" ? "inter" : "cascadia";
  applyFont(font);
  try {
    appSettings = await api("/api/settings", { method: "POST", body: { font } });
    applyFont(appSettings.font);
  } catch (err) {
    applyFont(appSettings.font);
    e.target.value = appSettings.font === "inter" ? "inter" : "cascadia";
    fail(err);
  }
});
$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.upscale = e.target.elements.upscale.checked;
  body.hover_preview = $("#hover-preview").checked; // outside the form; unchecked boxes are omitted from FormData
  hoverSave++;
  try {
    await api("/api/settings", { method: "POST", body });
    await loadSettings();
    toast("Einstellungen gespeichert.");
  } catch (err) { $("#settings-msg").textContent = err.message; }
});

async function refreshDbStatus() {
  const [st, run] = await Promise.all([api("/api/carddb"), api("/api/carddb/refresh")]).catch(() => [{}, {}]);
  const el = $("#db-status");
  if (run.running) {
    el.textContent = "Lade und importiere Bulk-Daten … (All Cards ≈ 375 MB, dauert einige Minuten)";
    $("#db-btn").disabled = true;
    setTimeout(refreshDbStatus, 5000);
    return;
  }
  $("#db-btn").disabled = false;
  if (run.error) el.innerHTML = `<span class="bad">Fehler: ${esc(run.error)}</span>`;
  else if (!st.available) el.innerHTML = '<span class="warn">Nicht vorhanden</span> – ohne lokale Datenbank wird die Scryfall-API live genutzt (langsamer, nur englische Namen).';
  else el.innerHTML = `<span class="ok">✓</span> ${st.cards} Karten, ${st.tags} Tags, ${st.languages.length} Sprachen · Stand ${esc(st.cards_updated_at?.slice(0, 10) ?? "?")}`
    + (st.schema_outdated ? ' · <span class="warn">Update empfohlen:</span> die Datenbank kennt noch keine Rückseiten doppelseitiger Karten'
      : st.needs_refresh ? ' · <span class="warn">Update empfohlen</span>' : "");
  $("#db-btn").textContent = st.available ? "Jetzt aktualisieren" : "Scryfall-Bulk-Daten laden";
}
$("#db-btn").addEventListener("click", async () => {
  await api("/api/carddb/refresh", { method: "POST" }).catch(fail);
  void refreshDbStatus();
});

// ============================================================================================
// collective print orders (Sammelbestellung): cards from several decks + tokens, printed like a deck
// ============================================================================================
let orderIndex = [];
async function refreshOrders() {
  orderIndex = await api("/api/orders").catch(() => orderIndex);
  $("#order-count").textContent = orderIndex.length || "";
  return orderIndex;
}
const orderMeta = (c) => `${c.cards} Karten · ${c.tokens} Tokens · ${c.slots} Druckplätze` + (c.slots ? ` · MPC-Staffel ${c.mpc_bracket}` : "");

async function showOrders(id) {
  $("#orders-list-view").hidden = !!id;
  $("#order-view").hidden = !id;
  if (!id) {
    currentOrder = null;
    await refreshOrders();
    $("#orders-empty").hidden = !!orderIndex.length;
    $("#orders-list").innerHTML = orderIndex.map((o) => `<a class="panel order-row" href="#/orders/${enc(o.id)}">
        <div><h3>${esc(o.name)}</h3><p class="muted small">${esc(orderMeta(o.counts))}${o.counts.sources.length ? " · " + esc(o.counts.sources.join(", ")) : ""}</p></div>
        <span class="muted small">${esc(fmtDate(o.updated))}</span></a>`).join("");
    return;
  }
  try { currentOrder = await api(`/api/orders/${enc(id)}`); } catch (err) { fail(err); go("#/orders"); return; }
  const decks = deckIndex.map((d) => `<option value="${esc(d.slug)}">${esc(d.name)}</option>`).join("");
  $("#oadd-deck").elements.deck.innerHTML = decks || '<option value="">– noch keine Decks –</option>';
  $("#oadd-token-deck").innerHTML = '<option value="">… oder Tokens eines Decks</option>' + decks;
  renderOrder();
  mountPrintStudio("#order-print-slot");
  if (printLoadedFor !== currentOrder.slug) { printLoadedFor = currentOrder.slug; refreshOrderPlan(true); }
}

function renderOrder() {
  const o = currentOrder;
  $("#order-name").textContent = o.name;
  $("#order-meta").textContent = orderMeta(o.counts);
  $("#order-total").textContent = o.counts.slots || "";
  $("#order-items-empty").hidden = !!o.items.length;
  $("#order-export").hidden = !o.items.some((i) => i.kind === "card");
  $("#order-export-file").href = `/api/orders/${enc(o.id)}/export?download=1`;
  const groups = new Map();
  for (const i of o.items) {
    if (!groups.has(i.source)) groups.set(i.source, []);
    groups.get(i.source).push(i);
  }
  $("#order-items").innerHTML = [...groups].map(([source, items]) => `<section class="order-group">
      <div class="order-group-head"><h3>${esc(source)} <span class="count">${items.reduce((n, i) => n + i.qty, 0)}</span></h3>
        <button type="button" class="link-btn" data-source="${esc(source)}">Gruppe entfernen</button></div>
      <ul class="order-items">${items.map((i) => `<li data-item="${esc(i.id)}">
        <input type="number" min="0" max="500" value="${i.qty}" aria-label="Anzahl ${esc(i.name)}">
        <span>${esc(i.name)}${i.kind === "token" ? ` <span class="muted">${esc(i.type_line || "Token")}</span>` : ""}</span>
        <button type="button" class="icon-btn" data-remove="${esc(i.id)}" aria-label="${esc(i.name)} entfernen" title="Entfernen">${icon("x")}</button></li>`).join("")}</ul></section>`).join("");
}

// the order's cards as a Moxfield list (also Archidekt, ManaBox …); tokens are left out
async function copyOrderList() {
  $("#order-menu").open = false;
  if (!currentOrder) return;
  try {
    const res = await fetch(`/api/orders/${enc(currentOrder.id)}/export`);
    if (!res.ok) throw new Error(errorText(res, await res.json().catch(() => ({}))));
    const text = await res.text();
    if (!text.trim()) { toast("Die Bestellung enthält noch keine Karten.", "error"); return; }
    const tokens = Number(res.headers.get("X-Tokens-Left-Out") || 0);
    await navigator.clipboard.writeText(text);
    toast(`Liste kopiert (${text.trim().split("\n").length} Zeilen) – in Moxfield unter „Import“ einfügen.`
      + (tokens ? ` ${tokens} ${tokens === 1 ? "Token-Position ist" : "Token-Positionen sind"} nicht dabei (Moxfield importiert keine Tokens).` : ""), "info", 7000);
  } catch (err) {
    fail(err.name === "NotAllowedError" ? new Error("Kopieren nicht möglich – lade die Liste als .txt herunter.") : err);
  }
}
$("#order-export-copy").addEventListener("click", copyOrderList);
$("#order-export-menu").addEventListener("click", copyOrderList);

// the print preview follows the order (MPC searches are cached, so this is cheap)
const refreshOrderPlan = (() => {
  const run = () => {
    if (!currentOrder || parseHash().view !== "orders") return;
    if (currentOrder.counts.slots) void loadPlan();
    else { printPlan = null; $("#print-grid").innerHTML = ""; $("#print-summary").textContent = "Noch nichts zu drucken – füge oben Karten oder Tokens hinzu."; }
  };
  const later = debounce(run, 700);
  return (now = false) => (now ? run() : later());
})();

function orderChanged(o, msg) {
  currentOrder = o;
  renderOrder();
  refreshOrderPlan();
  void refreshOrders();
  if (msg) toast(msg);
}

async function addToOrder(body, msg) {
  const r = await api(`/api/orders/${enc(currentOrder.id)}/items`, { method: "POST", body });
  orderChanged(r, msg ? msg(r) : `${r.added} hinzugefügt.`);
  return r;
}

$("#order-new").addEventListener("click", async () => {
  const name = await ask({ title: "Neue Sammelbestellung", text: "Wie soll sie heißen?", value: `Bestellung ${new Date().toLocaleDateString("de-DE")}`, ok: "Anlegen" });
  if (!name) return;
  try {
    const o = await api("/api/orders", { method: "POST", body: { name } });
    await refreshOrders();
    go(`#/orders/${enc(o.id)}`);
  } catch (err) { fail(err); }
});
$("#order-rename").addEventListener("click", async () => {
  $("#order-menu").open = false;
  const name = await ask({ title: "Umbenennen", value: currentOrder.name, ok: "Speichern" });
  if (!name) return;
  try { orderChanged(await api(`/api/orders/${enc(currentOrder.id)}`, { method: "PATCH", body: { name } })); } catch (err) { fail(err); }
});
$("#order-delete").addEventListener("click", async () => {
  $("#order-menu").open = false;
  if (!(await ask({ title: "Sammelbestellung löschen?", text: `„${currentOrder.name}“ und ihre Druckdateien werden gelöscht.`, ok: "Löschen", danger: true }))) return;
  try {
    await api(`/api/orders/${enc(currentOrder.id)}`, { method: "DELETE" });
    currentOrder = null;
    printLoadedFor = null;
    mountPrintStudio("#panel-drucken");
    go("#/orders");
  } catch (err) { fail(err); }
});

$("#order-add-kind").addEventListener("change", (e) => {
  for (const f of $$("#order-view .order-add")) f.hidden = f.dataset.kind !== e.target.value;
});
wireAutocomplete($("#oadd-card").elements.name, $("#ac-oadd"));
$("#oadd-card").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    const name = await chooseCard(f.name.value.trim(), { deck: false });
    if (name === null) return;
    await addToOrder({ items: [{ kind: "card", name, qty: Number(f.qty.value) || 1, source: "Einzelkarten" }] });
    e.target.reset();
    f.name.focus();
  } catch (err) { fail(err); }
});
$("#oadd-text").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements, url = f.url.value.trim(), text = f.text.value.trim();
  if (!url && !text) { toast("Füge eine Liste oder einen Deck-Link ein.", "error"); f.url.focus(); return; }
  const btn = e.target.querySelector("[type=submit]");
  btn.disabled = true;
  try {
    await addToOrder({ url: url || null, text: text || null }, (r) => `${r.added} ${r.added === 1 ? "Karte" : "Karten"} hinzugefügt.`);
    e.target.reset();
  } catch (err) { fail(err); }
  finally { btn.disabled = false; }
});
async function renderDeckPick() {
  const f = $("#oadd-deck").elements;
  const pick = f.which.value === "pick";
  $("#oadd-pick").hidden = !pick;
  if (!pick || !f.deck.value) return;
  try {
    const d = await api(`/api/decks/${enc(f.deck.value)}`);
    const names = [...d.commanders, ...d.cards.map((c) => c.name)];
    $("#oadd-pick").innerHTML = names.map((n) => `<label><input type="checkbox" value="${esc(n)}"> ${esc(n)}</label>`).join("");
  } catch (err) { fail(err); }
}
$("#oadd-deck").addEventListener("change", (e) => { if (e.target.name === "which" || e.target.name === "deck") void renderDeckPick(); });
$("#oadd-deck").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = { deck: f.deck.value };
  if (f.which.value === "missing") body.only_missing = true;
  if (f.which.value === "pick") {
    body.names = $$("#oadd-pick input:checked").map((c) => c.value);
    if (!body.names.length) { toast("Wähle mindestens eine Karte aus.", "error"); return; }
  }
  try { await addToOrder(body, (r) => `${r.added} Karten aus „${f.deck.selectedOptions[0].textContent}“ hinzugefügt.`); } catch (err) { fail(err); }
});

// tokens: Scryfall search or the tokens of a deck; one click adds "je N"
let tokenHits = [];
function renderTokenHits(items, msg) {
  tokenHits = items;
  $("#oadd-token-msg").textContent = msg;
  $("#oadd-token-grid").innerHTML = items.map((t, i) => `<button type="button" class="similar" data-t="${i}" title="${esc(t.type_line)}">
      ${t.image ? `<img src="${esc(t.image)}" alt="" loading="lazy">` : `<div class="noimg">${esc(t.name)}</div>`}
      <span class="sim-name">${esc(t.name)}</span><span class="muted">${esc(t.type_line || "")}${t.set_name ? " · " + esc(t.set_name) : ""}</span></button>`).join("");
}
$("#oadd-token-q").addEventListener("input", debounce(async (e) => {
  const q = e.target.value.trim();
  if (q.length < 2) return renderTokenHits([], "");
  $("#oadd-token-deck").value = "";
  try {
    const items = await api(`/api/tokens/search?q=${enc(q)}`);
    renderTokenHits(items, items.length ? "Klick fügt das Token in der gewählten Anzahl hinzu." : "Kein Token gefunden.");
  } catch (err) { renderTokenHits([], err.message); }
}, 300));
$("#oadd-token-deck").addEventListener("change", async (e) => {
  const slug = e.target.value;
  if (!slug) return renderTokenHits([], "");
  try {
    const items = await api(`/api/decks/${enc(slug)}/tokens`);
    const deckName = e.target.selectedOptions[0].textContent;
    renderTokenHits(items.map((t) => ({ ...t, source: `Tokens ${deckName}` })), items.length ? `Tokens, Embleme und Marker von „${deckName}“.` : "Dieses Deck erzeugt keine Tokens.");
  } catch (err) { renderTokenHits([], err.message); }
});
$("#oadd-token-grid").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-t]");
  if (!b) return;
  const t = tokenHits[Number(b.dataset.t)];
  const qty = Math.max(1, Number($("#oadd-token-qty").value) || 1);
  try {
    await addToOrder({ items: [{ kind: "token", name: t.name, qty, type_line: t.type_line, token_id: t.id || null, image: t.image || null, source: t.source || "Tokens" }] },
      () => `${qty}× ${t.name} hinzugefügt.`);
  } catch (err) { fail(err); }
});

$("#order-items").addEventListener("change", async (e) => {
  const li = e.target.closest("li[data-item]");
  if (!li || e.target.type !== "number") return;
  try { orderChanged(await api(`/api/orders/${enc(currentOrder.id)}/items/${enc(li.dataset.item)}`, { method: "PATCH", body: { qty: Number(e.target.value) || 0 } })); }
  catch (err) { fail(err); }
});
$("#order-items").addEventListener("click", async (e) => {
  const rm = e.target.closest("[data-remove]"), grp = e.target.closest("[data-source]");
  try {
    if (rm) orderChanged(await api(`/api/orders/${enc(currentOrder.id)}/items?item=${enc(rm.dataset.remove)}`, { method: "DELETE" }));
    if (grp && (await ask({ title: "Gruppe entfernen?", text: `Alle Positionen aus „${grp.dataset.source}“ entfernen.`, ok: "Entfernen", danger: true }))) {
      orderChanged(await api(`/api/orders/${enc(currentOrder.id)}/items?source=${enc(grp.dataset.source)}`, { method: "DELETE" }));
    }
  } catch (err) { fail(err); }
});

// "In eine Sammelbestellung packen?" – after saving card edits, from the deck menu or the card view
function orderDialog({ title, text, body, missingToggle = false, qtyField = false }) {
  return refreshOrders().then(() => new Promise((resolve) => {
    const dlg = $("#order-dialog"), sel = $("#order-dialog-target");
    $("#order-dialog-title").textContent = title;
    $("#order-dialog-text").textContent = text;
    sel.innerHTML = orderIndex.map((o) => `<option value="${esc(o.id)}">${esc(o.name)} (${o.counts.slots} Druckplätze)</option>`).join("")
      + '<option value="">+ Neue Sammelbestellung …</option>';
    sel.value = orderIndex[0]?.id || "";
    $("#order-dialog-name").value = `Bestellung ${new Date().toLocaleDateString("de-DE")}`;
    const syncName = () => { $("#order-dialog-name-field").hidden = !!sel.value; };
    sel.onchange = syncName;
    syncName();
    $("#order-dialog-missing-row").hidden = !missingToggle;
    $("#order-dialog-qty-row").hidden = !qtyField;
    $("#order-dialog-qty").value = 1;
    $("#order-dialog-missing").checked = missingToggle && !!collSummary?.entries;
    const done = (r) => { dlg.onclose = null; if (dlg.open) dlg.close(); resolve(r); };
    $("#order-dialog-cancel").onclick = () => done(null);
    dlg.onclose = () => resolve(null);
    $("#order-dialog-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        let id = sel.value;
        if (!id) id = (await api("/api/orders", { method: "POST", body: { name: $("#order-dialog-name").value } })).id;
        const payload = { ...body, ...(missingToggle ? { only_missing: $("#order-dialog-missing").checked } : {}) };
        if (qtyField) {
          const qty = Math.max(1, Math.min(99, Math.round(Number($("#order-dialog-qty").value) || 1)));
          payload.items = payload.items.map((i) => ({ ...i, qty }));
        }
        const r = await api(`/api/orders/${enc(id)}/items`, { method: "POST", body: payload });
        void refreshOrders();
        toast(`${r.added} ${r.added === 1 ? "Karte" : "Karten"} in „${r.name}“ – zu finden unter „Sammelbestellungen“.`);
        done(r);
      } catch (err) { fail(err); }
    };
    dlg.showModal();
  }));
}

// ---------- compare with another deck: what a rebuild needs beyond the old deck -> collective order ----------
let dcData = null;
async function openDeckCompare(other = null) {
  if (!currentDeck) return;
  $("#deck-menu").open = false;
  $("#dc-name").textContent = currentDeck.name;
  $("#dc-summary").textContent = "Vergleiche …";
  $("#dc-body").hidden = true;
  if (!$("#deck-compare").open) $("#deck-compare").showModal();
  try {
    const slug = currentDeck.slug;
    const r = await api(`/api/decks/${enc(slug)}/compare${other ? `?other=${enc(other)}` : ""}`);
    if (currentDeck?.slug !== slug) return;
    if (!r.other) { $("#dc-other").innerHTML = ""; $("#dc-summary").textContent = "Es gibt noch kein anderes Deck zum Vergleichen."; return; }
    dcData = r;
    $("#dc-other").innerHTML = r.candidates.map((c) => `<option value="${esc(c.slug)}" ${c.slug === r.other.slug ? "selected" : ""}>${esc(c.name)}`
      + ` – ${c.copied_from ? "Vorlage dieses Decks, " : ""}${c.common} gemeinsame Karten</option>`).join("");
    const hasColl = !!collSummary?.entries;
    $(`#dc-mode [value="${hasColl && r.totals.missing < r.totals.added ? "missing" : "all"}"]`).checked = true;
    $("#dc-mode").hidden = !hasColl;
    renderDeckCompare();
  } catch (err) { $("#dc-summary").textContent = err.message; }
}
const dcMode = () => ($("#dc-mode").hidden ? "all" : $("#dc-mode input:checked")?.value || "all");
const dcQty = (i) => (dcMode() === "missing" ? i.missing : i.qty);
function renderDeckCompare() {
  const r = dcData, cur = currentDeck?.currency || "eur";
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  $("#dc-body").hidden = false;
  $("#dc-summary").innerHTML = `<b>${n(r.totals.added, "Karte", "Karten")}</b> kommen neu dazu`
    + (collSummary?.entries ? `, davon <b>${r.totals.missing}</b> nicht in deiner Sammlung` : "")
    + ` · ${n(r.totals.removed, "Karte wird", "Karten werden")} frei · ${r.totals.common} gemeinsam`;
  $("#dc-added-title").textContent = `Kommt neu dazu (${r.totals.added})`;
  $("#dc-added-hint").textContent = `Karten in „${r.deck.name}“, die „${r.other.name}“ nicht hat.`
    + (dcMode() === "missing" ? " Grau = hast du schon in deiner Sammlung." : "");
  $("#dc-added").innerHTML = r.added.map((i, k) => {
    const q = dcQty(i);
    const status = i.basic ? '<span class="pill">Standardland</span>'
      : i.missing === 0 ? `<span class="pill ok">in Sammlung${i.owned ? ` (${i.owned})` : ""}</span>`
      : collSummary?.entries ? '<span class="pill bad">fehlt</span>' : "";
    return `<li class="${q ? "" : "have"}"><input type="checkbox" data-k="${k}" ${q && !(i.basic && dcMode() === "all") ? "checked" : ""} ${q ? "" : "disabled"} aria-label="${esc(i.name)} bestellen">
      <span class="qty">${q || i.qty}×</span><button type="button" class="name" data-name="${esc(i.name)}" data-k="${k}">${esc(i.name)}${i.commander ? " (Commander)" : ""}</button>
      ${status}<span class="price">${i.price ? esc(fmtPrice(i.price, cur)) : ""}</span></li>`;
  }).join("") || '<li class="muted small">Keine – alle Karten stecken auch im anderen Deck.</li>';
  $("#dc-removed-title").textContent = `Wird frei (${r.totals.removed})`;
  $("#dc-removed-hint").textContent = `Karten aus „${r.other.name}“, die „${r.deck.name}“ nicht braucht.`;
  $("#dc-removed").className = "dc-list plain";
  $("#dc-removed").innerHTML = r.removed.map((i) => `<li><span class="qty">${i.qty}×</span><button type="button" class="name" data-name="${esc(i.name)}">${esc(i.name)}</button>
    <span class="price">${i.price ? esc(fmtPrice(i.price, cur)) : ""}</span></li>`).join("") || '<li class="muted small">Keine.</li>';
  $("#dc-common-title").textContent = `Gemeinsam (${r.totals.common})`;
  $("#dc-common").innerHTML = r.common.map((i) => esc(`${i.qty > 1 ? i.qty + "× " : ""}${i.name}`)).join("<br>");
  updateDcSelection();
}
function dcSelected() {
  return $$("#dc-added input[type=checkbox]:checked").map((b) => dcData.added[Number(b.dataset.k)]).map((i) => ({ ...i, order: dcQty(i) })).filter((i) => i.order > 0);
}
function updateDcSelection() {
  const sel = dcSelected();
  const copies = sel.reduce((a, i) => a + i.order, 0);
  $("#dc-order span").textContent = copies ? `${copies} ${copies === 1 ? "Karte" : "Karten"} zur Sammelbestellung …` : "Zur Sammelbestellung …";
  $("#dc-order").disabled = $("#dc-copy").disabled = !copies;
}
$("#dc-other").addEventListener("change", (e) => openDeckCompare(e.target.value));
$("#dc-mode").addEventListener("change", renderDeckCompare);
$("#dc-added").addEventListener("change", updateDcSelection);
$("#deck-compare").addEventListener("click", (e) => {
  const b = e.target.closest("button.name");
  if (!b) return;
  const col = b.closest("#dc-added, #dc-removed");
  const pool = col?.id === "dc-removed" ? (dcData?.removed || []) : (dcData?.added || []);
  const buttons = col ? [...col.querySelectorAll("button.name")] : [b];
  const list = buttons.map((btn) => {
    const hit = pool.find((x) => x.name === btn.dataset.name) || {};
    return { name: btn.dataset.name, cd: { image: hit.image, image_back: hit.image_back } };
  });
  showCardView(b.dataset.name, list[buttons.indexOf(b)].cd, list, buttons.indexOf(b));
});
$("#dc-close").addEventListener("click", () => $("#deck-compare").close());
$("#dc-copy").addEventListener("click", async () => {
  const text = dcSelected().map((i) => `${i.order} ${i.name}`).join("\n");
  try { await navigator.clipboard.writeText(text); toast("Liste kopiert – z. B. für Moxfield, Cardmarket oder einen Laden."); }
  catch { toast("Kopieren nicht möglich – der Browser erlaubt keinen Zugriff auf die Zwischenablage.", "error"); }
});
$("#dc-order").addEventListener("click", async () => {
  const sel = dcSelected();
  if (!sel.length) return;
  const r = dcData;
  $("#deck-compare").close();
  const copies = sel.reduce((a, i) => a + i.order, 0);
  await orderDialog({ title: "Umbau bestellen",
    text: `${copies} ${copies === 1 ? "Karte" : "Karten"} aus „${r.deck.name}“, die „${r.other.name}“ nicht hat: `
      + sel.slice(0, 6).map((i) => (i.order > 1 ? `${i.order}× ${i.name}` : i.name)).join(", ") + (sel.length > 6 ? ` und ${sel.length - 6} weitere` : "") + ".",
    body: { items: sel.map((i) => ({ kind: "card", name: i.name, qty: i.order, source: `${r.deck.name} (statt ${r.other.name})`, source_slug: r.deck.slug })) } });
});
$("#compare-deck-btn").addEventListener("click", () => openDeckCompare());
$("#dc-open").addEventListener("click", () => openDeckCompare());

// ---------- Einkaufsliste: buy the deck for real at Cardmarket's cheapest printings ----------
let buyData = null;
async function openBuylist() {
  if (!currentDeck) return;
  $("#deck-menu").open = false;
  $("#buy-title").textContent = `Einkaufsliste – ${currentDeck.name}`;
  if (!$("#buylist").open) $("#buylist").showModal();
  await loadBuylist();
}
async function loadBuylist() {
  const slug = currentDeck?.slug;
  if (!slug) return;
  $("#buy-summary").textContent = "Hole die Preise von Cardmarket …";
  $("#buy-body").hidden = true;
  try {
    const r = await api(`/api/decks/${enc(slug)}/buylist?owned=${$("#buy-owned").checked}&proxies=${$("#buy-proxies").checked}`);
    if (currentDeck?.slug !== slug) return;
    buyData = r;
    renderBuyCompare();
    renderBuylist();
  } catch (err) { $("#buy-summary").textContent = err.message; }
}
// compare with 1..N places (Bulk, a binder …) and other decks: picked keys per deck, remembered in this browser
const buyCompareKey = () => `mtgdeck.buycompare.${currentDeck?.slug}`;
function buyPicked() {
  return new Set($$("#buy-compare-decks input:checked").map((b) => b.value));
}
// where a row's card already is, for the picked places: [{label, text}]
function buyWhere(i, picked) {
  return (buyData.places || []).filter((o) => picked.has(o.key)).flatMap((o) => {
    const at = i.places?.[o.key];
    if (o.kind === "deck") {
      const d = i.decks.find((x) => x.slug === o.slug);
      return d || at ? [{ label: o.label, text: d && d.qty > 1 ? `×${d.qty}` : "" }] : [];
    }
    if (!at || !(at.real || at.proxy)) return [];
    return [{ label: o.label, text: [at.real ? `×${at.real}` : "", at.proxy ? `${at.proxy} Proxy` : ""].filter(Boolean).join(" + ") }];
  });
}
function renderBuyCompare() {
  const r = buyData, opts = r.places || [];
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(buyCompareKey()) || "[]"); } catch { saved = []; }
  saved = saved.map((s) => (s.includes(":") ? s : `deck:${s}`));  // picks from before places were added were deck slugs
  const count = (o) => r.items.filter((i) => buyWhere(i, new Set([o.key])).length).length;
  $("#buy-compare").hidden = !opts.length;
  $("#buy-compare-owned").hidden = !r.use_collection;  // owned cards are off the list, so the places count only what is left
  const group = (kind, title) => {
    const list = opts.filter((o) => o.kind === kind);
    return list.length ? `<p class="buy-compare-group muted small">${title}</p>` + list.map((o) => `<label class="check"><input type="checkbox" value="${esc(o.key)}"
      ${saved.includes(o.key) ? "checked" : ""}> <span>${esc(o.label)}${o.shelved ? ' <span class="count">· pausiert</span>' : ""} <span class="count">(${count(o)})</span></span></label>`).join("") : "";
  };
  $("#buy-compare-decks").innerHTML = group("place", "Orte in deiner Sammlung") + group("deck", "Andere Decks");
  if (saved.some((s) => opts.some((o) => o.key === s))) $("#buy-compare").open = true;
  updateBuyCompareTitle();
}
function updateBuyCompareTitle() {
  const n = buyPicked().size;
  $("#buy-compare-title").textContent = n ? `Mit ${n} ${n === 1 ? "Ort" : "Orten"} abgeglichen` : "Mit Orten abgleichen";
  $("#buy-compare-mode").hidden = !n;
}
const buyMode = () => (buyPicked().size ? $("#buy-compare-mode input:checked")?.value || "all" : "all");
const buyMax = () => { const v = Number.parseFloat(String($("#buy-max").value).replace(",", ".")); return Number.isFinite(v) && v >= 0 ? v : null; };
function renderBuylist() {
  const r = buyData, max = buyMax();
  $("#buy-bar").hidden = false;
  $("#buy-checks").hidden = !r.collection_size;
  $("#buy-proxies-box").hidden = !r.use_collection;
  $("#buy-body").hidden = !r.items.length;
  const price = (v) => (v ? esc(fmtPrice(v, "eur")) : "–");
  const shelved = r.use_collection ? r.from_shelved || [] : [];
  const taken = shelved.reduce((a, s) => a + s.qty, 0);
  $("#buy-shelved").hidden = !taken;
  $("#buy-shelved-title").textContent = `${taken} ${taken === 1 ? "Karte" : "Karten"} aus pausierten Decks nehmen`;
  $("#buy-shelved-list").innerHTML = shelved.map((s) => `<li><span class="qty">${s.qty}×</span> ${esc(s.name)}
    <span class="muted small">aus ${s.decks.map((n) => `„${esc(n)}“`).join(", ")}</span></li>`).join("");
  const picked = buyPicked(), mode = buyMode();
  $("#buy-list").innerHTML = r.items.map((i, k) => {
    const inPicked = buyWhere(i, picked);
    if ((mode === "in" && !inPicked.length) || (mode === "none" && inPicked.length)) return "";
    const over = max != null && (i.trend || 0) > max;
    const pills = inPicked.length ? `<span class="buy-in">${inPicked.map((w) =>
      `<span class="pill">${esc(w.label)}${w.text ? ` ${esc(w.text)}` : ""}</span>`).join("")}</span>` : "";
    const owned = [i.real ? `${i.real} echt` : "", i.proxy ? `${i.proxy} Proxy` : ""].filter(Boolean).join(", ");
    const where = i.set_name ? `${esc(i.set_name)}${i.collector_number ? ` #${esc(i.collector_number)}` : ""}`
      : i.source === "scryfall" ? "Preis von Scryfall" : i.source ? "" : "kein Preis gefunden";
    return `<li class="${over ? "have" : ""}"><input type="checkbox" data-k="${k}" ${over ? "" : "checked"} aria-label="${esc(i.name)} kaufen">
      <span class="qty">${i.qty}×</span>
      <span class="buy-card"><a href="${esc(i.url || i.search_url)}" target="_blank" rel="noopener" class="name">${esc(i.name)}</a>
        <span class="muted small">${where}${owned && r.use_collection ? ` · hast du: ${esc(owned)}` : ""}${i.in_decks?.length && r.use_collection
          ? `, steckt in ${i.in_decks.slice(0, 2).map((n) => `„${esc(n)}“`).join(", ")}${i.in_decks.length > 2 ? " …" : ""}` : ""}</span>${pills}</span>
      <span class="price" title="Billigstes Angebot irgendeiner Ausgabe">${price(i.total_low)}</span>
      <span class="price strong" title="Trendpreis der günstigsten Ausgabe">${price(i.total_trend)}</span></li>`;
  }).join("");
  const date = r.price_date ? ` vom ${fmtDate(r.price_date)}` : "";
  $("#buy-note").innerHTML = (r.error ? `<span class="warn">${esc(r.error)} Die Preise kommen deshalb von Scryfall.</span><br>` : "")
    + `Preise: Cardmarket-Preisliste${esc(date)} (einmal am Tag). „Trend“ = üblicher Preis der günstigsten Ausgabe, „ab“ = billigstes Angebot`
    + " irgendeiner Ausgabe, oft gespielt oder in einer anderen Sprache. Was es wirklich kostet, zeigt Cardmarket nach dem Einfügen in eine Wants-Liste.";
  updateBuylistSelection();
}
function buySelected() {
  return $$("#buy-list input[type=checkbox]:checked").map((b) => buyData.items[Number(b.dataset.k)]);
}
function updateBuylistSelection() {
  const r = buyData;
  if (!r) return;
  if (!r.items.length) {
    $("#buy-summary").innerHTML = r.collection_size ? "<b>Nichts zu kaufen</b> – du hast alle Karten dieses Decks als echte Karten." : "<b>Nichts zu kaufen.</b>";
    $("#buy-copy").disabled = true;
    return;
  }
  const sel = buySelected();
  const copies = sel.reduce((a, i) => a + i.qty, 0);
  const sum = (k) => sel.reduce((a, i) => a + (i[k] || 0), 0);
  const shown = $$("#buy-list input[type=checkbox]").length;
  const skipped = shown - sel.length;
  const picked = buyPicked();
  const shared = picked.size ? r.items.filter((i) => buyWhere(i, picked).length).length : 0;
  $("#buy-summary").innerHTML = `<b>${copies} ${copies === 1 ? "Karte" : "Karten"}</b> kaufen · ≈ <b>${esc(fmtPrice(sum("total_trend"), "eur"))}</b> (Trend)`
    + ` · ab ${esc(fmtPrice(sum("total_low"), "eur"))}`
    + (skipped ? ` · ${skipped} ${skipped === 1 ? "Karte bleibt" : "Karten bleiben"} Proxy` : "")
    + (picked.size ? ` · ${shared} von ${r.items.length} ${shared === 1 ? "liegt" : "liegen"} schon an den gewählten Orten` : "")
    + (!r.collection_size ? '<br><span class="muted">Deine Sammlung ist leer, deshalb steht das ganze Deck auf der Liste (ohne Standardländer).</span>'
      : !r.use_collection ? '<br><span class="muted">Ohne Abgleich steht das ganze Deck auf der Liste (ohne Standardländer).</span>'
      : '<br><span class="muted">Karten aus deiner Sammlung fehlen nur, wenn sie schon in einem anderen Deck stecken, das du spielst.</span>');
  $("#buy-copy span").textContent = copies ? `${copies} ${copies === 1 ? "Karte" : "Karten"} für Cardmarket kopieren` : "Für Cardmarket kopieren";
  $("#buy-copy").disabled = !copies;
}
$("#buy-list").addEventListener("change", updateBuylistSelection);
$("#buy-compare-decks").addEventListener("change", () => {
  try { localStorage.setItem(buyCompareKey(), JSON.stringify([...buyPicked()])); } catch { /* only a convenience */ }
  updateBuyCompareTitle();
  renderBuylist();
});
$("#buy-compare-mode").addEventListener("change", renderBuylist);
$("#buy-max").addEventListener("input", () => { if (buyData) renderBuylist(); });
$("#buy-proxies").addEventListener("change", loadBuylist);
$("#buy-owned").addEventListener("change", loadBuylist);
$("#buy-close").addEventListener("click", () => $("#buylist").close());
$("#buy-copy").addEventListener("click", async () => {
  const text = buySelected().map((i) => `${i.qty} ${i.name}`).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Kopiert. Bei Cardmarket unter „Wants“ eine Liste anlegen, einfügen und den Shopping Wizard die günstigsten Verkäufer suchen lassen.", "ok", 9000);
  } catch { toast("Kopieren nicht möglich – der Browser erlaubt keinen Zugriff auf die Zwischenablage.", "error"); }
});
$("#buylist-btn").addEventListener("click", () => openBuylist());

async function offerOrderAfterRebuild(slug, since) {
  if (!slug || !since) return;
  try {
    const r = await api(`/api/decks/${enc(slug)}/added?since=${since}`);
    if (!r.cards || r.version === since) return;
    const names = r.items.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name));
    await orderDialog({
      title: "Neue Karten bestellen?",
      text: `Der Umbau (v${since} → v${r.version}) bringt ${r.cards} neue ${r.cards === 1 ? "Karte" : "Karten"}: `
        + names.slice(0, 8).join(", ") + (names.length > 8 ? ` und ${names.length - 8} weitere` : "") + ". In eine Sammelbestellung packen?",
      body: { deck: slug, since_version: since }, missingToggle: true,
    });
  } catch { /* the rebuild itself worked – the offer is optional */ }
}

$("#order-from-deck").addEventListener("click", () => {
  if (!currentDeck) return;
  $("#deck-menu").open = false;
  const total = currentDeck.cards.reduce((n, c) => n + (c.qty || 1), 0) + currentDeck.commanders.length;
  void orderDialog({ title: "Deck drucken", text: `Karten aus „${currentDeck.name}“ (${total} insgesamt) in eine Sammelbestellung packen.`,
    body: { deck: currentDeck.slug }, missingToggle: true });
});
void refreshOrders();

// ============================================================================================
// about: banner, avatar, version and the channels (a channel without a URL shows as „bald“)
// ============================================================================================
const SOCIAL = [
  { key: "twitter", label: "Twitter", url: "https://twitter.com/ConclaveMTG", note: "@ConclaveMTG" },
  { key: "twitch", label: "Twitch", url: "" },
  { key: "instagram", label: "Instagram", url: "" },
  { key: "youtube", label: "YouTube", url: "" },
  { key: "tiktok", label: "TikTok", url: "" },
  { key: "github", label: "GitHub", url: "https://github.com/liehrdot/Conclave", note: "Quellcode, Ideen und Fehler melden" },
];
// the artists of the 120 card arts in the banner (social media kit, README)
const BANNER_ARTISTS = [
  "Adam Paquette", "Adam Rex", "Alayna Danner", "Alejandro Pacheco", "Alexander Forssberg", "Anastasia Ovchinnikova",
  "Andrew Mar", "Anthony Devine", "April Lee", "Arthur Haas", "Arthur Yuan", "Bastien L. Deharme", "Borja Pindado",
  "Brian Snõddy", "Bruce Brenneise", "Chase Stone", "Chris Ostrowski", "Chris Rahn", "Christine Choi", "Cliff Childs",
  "Cliff Nielsen", "Daarken", "Dallas Williams", "Darius Zablockis", "David Frasheski", "David Álvarez", "Dmitry Burmak",
  "Eric Deschamps", "Eugene Maslovski", "Flavio Greco Paglia", "Gabor Szikszai", "Howard Lyon", "Iga Oliwiak",
  "Immanuela Crovius", "Isis", "Izzy", "James Paick", "James Ryman", "Javier Charro", "Jesper Ejsing", "Jessica Rossier",
  "Johann Bodin", "John Avon", "John Thacker", "Jonas De Ro", "Josu Solano", "Julian Kok Joon Wen", "Jung Park", "Kev Walker",
  "Kevin Sidharta", "Kotakan", "Lindsey Look", "Lordigan", "Lorenzo Mastroianni", "Mark Behm", "Mateus Manhanini",
  "Mike Dringenberg", "Nino Is", "Pace Wilder", "Pavel Kolomeyets", "Philip Straub", "Piotr Dura", "Randy Vargas",
  "Raymond Bonilla", "Raymond Swanland", "Richard Wright", "Rimas Valeikis", "rk post", "Robin Olausson", "Ron Spears",
  "Ryan Alexander Lee", "Ryan Valle", "Rytis Sabaliauskas", "Sarah Finnigan", "Shahab Alizadeh", "Shelly Wan",
  "Steven Belledin", "Svetlin Velinov", "Tatiana Kirgetova", "Thomas Chamberlain-Keen", "Thomas Stoop", "Titus Lunter",
  "Todd Lockwood", "Trevor Claxton", "Vance Kovacs", "Veli Nyström", "Wisnu Tan", "Yeong-Hao Han", "Zack Stella"
];

// „Version x“ on the about page and in its card at the top of the settings
let appVersion = "";
async function showVersion() {
  if (!appVersion) {
    try { appVersion = desktopShell?.version || (await api("/api/health")).version; } catch { return; /* offline: no version line */ }
  }
  for (const el of $$(".about-version-line")) el.textContent = `Version ${appVersion}` + (el.closest(".about-card") ? " · " : "");
}

async function showAbout() {
  $("#about-links").innerHTML = SOCIAL.map((s) => {
    const inner = `<svg class="brand-icon" aria-hidden="true"><use href="#b-${s.key}"/></svg><span><b>${esc(s.label)}</b>`
      + `<span class="muted small">${esc(s.note || (s.url ? s.url.replace(/^https:\/\/(www\.)?/, "") : "bald"))}</span></span>`;
    return s.url
      ? `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${inner}<svg class="icon"><use href="#i-forward"/></svg></a></li>`
      : `<li class="soon" aria-disabled="true">${inner}</li>`;
  }).join("");
  $("#about-artists").textContent = BANNER_ARTISTS.join(" · ");
  await showVersion();
}

// ============================================================================================
// glossary: keywords, actions and Commander terms
// ============================================================================================
let glossaryItems = null;
const GLOSSARY_GROUPS = { keyword: "Schlüsselwörter", action: "Aktionen, Spielsteine & Marker", concept: "Commander-Begriffe & Spielweisen" };
async function loadGlossary() {
  if (!glossaryItems) glossaryItems = await api("/api/glossary");
  return glossaryItems;
}
const glossaryId = (term) => "gl-" + term.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function renderGlossary() {
  const words = $("#gl-filter").value.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (glossaryItems || []).filter((t) => words.every((w) => `${t.term} ${t.de} ${t.text}`.toLowerCase().includes(w)));
  $("#gl-list").innerHTML = Object.entries(GLOSSARY_GROUPS).map(([kind, title]) => {
    const items = hits.filter((t) => t.kind === kind).sort((a, b) => (a.de || a.term).localeCompare(b.de || b.term, "de"));
    return items.length ? `<section class="panel gl-group"><h2>${esc(title)} <span class="count">${items.length}</span></h2><dl>${items.map((t) =>
      `<dt id="${glossaryId(t.term)}" tabindex="-1">${esc(t.de || t.term)}${t.de ? ` <span class="de">(${esc(t.term)})</span>` : ""}</dt><dd>${esc(t.text)}</dd>`).join("")}</dl></section>` : "";
  }).join("") || '<p class="empty-inline">Kein Begriff gefunden.</p>';
}

async function showGlossary(term) {
  try { await loadGlossary(); } catch (err) { return fail(err); }
  if (term) $("#gl-filter").value = "";
  renderGlossary();
  if (term) {
    const el = document.getElementById(glossaryId(term));
    if (el) { el.scrollIntoView({ block: "center" }); el.focus({ preventScroll: true }); }
  }
}
$("#gl-filter").addEventListener("input", debounce(renderGlossary, 120));
loadGlossary().catch(() => {});  // the quick search lists glossary terms too

// ============================================================================================
// quick search (Ctrl+K): decks, pages and actions
// ============================================================================================
let paletteHits = [];
let paletteSel = 0;
function paletteItems() {
  const items = [
    { label: "Neues Deck", hint: "Seite · Strg+N", run: () => go("#/new") },
    { label: "Leeres Deck anlegen", hint: "Neues Deck · Karten von scryfall.com hereinziehen", run: () => { go("#/new"); setImportMode("manual"); $("#manual-cmd").focus(); } },
    { label: "Deck per Link importieren", hint: "Moxfield, Archidekt, …", run: () => { go("#/new"); setImportMode("link"); $("#import-url").focus(); } },
    { label: "Deckliste einfügen", hint: "Neues Deck", run: () => { go("#/new"); setImportMode("text"); $("#import-text").focus(); } },
    { label: "Starterdeck (Precon) importieren", hint: "Neues Deck", run: () => { go("#/new"); setImportMode("precon"); } },
    { label: "Meine Sammlung", hint: "Seite", run: () => go("#/collection") },
    { label: "Karte zur Sammlung hinzufügen", hint: "Sammlung", run: () => { go("#/collection"); openCollAdd(); } },
    { label: "Sammlung importieren", hint: "Sammlung", run: () => { go("#/collection"); $("#coll-import-btn").click(); } },
    { label: "Verkaufen", hint: "Verkaufsliste · Cardmarket", run: () => go("#/sell") },
    { label: "Sammelbestellungen", hint: "Seite", run: () => go("#/orders") },
    { label: "Neue Sammelbestellung", hint: "Sammelbestellungen", run: () => { go("#/orders"); $("#order-new").click(); } },
    { label: "Glossar", hint: "Seite", run: () => go("#/glossary") },
    { label: "Gegnerdecks", hint: "Seite", run: () => go("#/opponents") },
    ...oppIndex.map((o) => ({ label: o.title, hint: "Gegnerdeck", run: () => go(`#/opponents/${enc(o.id)}`) })),
    { label: "Tischregeln", hint: "Seite", run: () => go("#/tables") },
    ...tableSets.map((t) => ({ label: t.name, hint: "Tischregel", run: () => go(`#/tables/${enc(t.id)}`) })),
    { label: "Blacklist", hint: "Seite", run: () => go("#/blacklist") },
    { label: "Einstellungen", hint: "Seite · Strg+,", run: () => go("#/settings") },
    { label: "Über Conclave", hint: "Einstellungen · Version, Kanäle", run: () => go("#/about") },
    { label: "Tastenkürzel", hint: "Übersicht · ?", run: () => openShortcuts() },
  ];
  if (currentDeck && parseHash().view === "deck") {
    const d = currentDeck;
    const tabNames = { karten: "Karten", testen: "Testhand & Wahrscheinlichkeiten", partien: "Partien & Bilanz", verlauf: "Verlauf", drucken: "Drucken" };
    for (const [tab, label] of Object.entries(tabNames)) items.push({ label, hint: d.name, run: () => selectTab(tab) });
    items.push({ label: "Karten bearbeiten", hint: d.name, run: () => { selectTab("karten"); if (!edit) setEditing(true); } });
    items.push({ label: "Einkaufsliste mit Preisen", hint: d.name, run: () => openBuylist() });
    items.push({ label: "Rule 0", hint: d.name, run: () => { selectTab("karten"); void openRule0(); } });
    items.push({ label: "Ziel und Tischregel", hint: d.name, run: () => { selectTab("karten"); $("#deck-target").scrollIntoView({ behavior: "smooth", block: "start" }); } });
    items.push({ label: "Liste kopieren", hint: d.name, run: () => $("#copy-btn").click() });
    items.push({ label: "Mit anderem Deck vergleichen", hint: d.name, run: () => openDeckCompare() });
    items.push({ label: "Partie festhalten", hint: d.name, run: () => { selectTab("partien"); $("#game-form-box").open = true; $("#game-form input[name=result]").focus(); } });
  }
  for (const d of deckIndex) items.push({ label: d.name, hint: `Deck · ${d.commanders.join(" + ")} · ${d.level || ""}`, run: () => go(`#/deck/${enc(d.slug)}`) });
  for (const o of orderIndex) items.push({ label: o.name, hint: `Sammelbestellung · ${o.counts.slots} Druckplätze`, run: () => go(`#/orders/${enc(o.id)}`) });
  for (const t of glossaryItems || []) items.push({ label: t.de ? `${t.de} (${t.term})` : t.term, hint: "Glossar", run: () => go(`#/glossary/${enc(t.term)}`) });
  return items;
}
function renderPalette() {
  const words = $("#palette-input").value.toLowerCase().split(/\s+/).filter(Boolean);
  paletteHits = paletteItems().filter((it) => words.every((w) => `${it.label} ${it.hint}`.toLowerCase().includes(w))).slice(0, 14);
  paletteSel = Math.min(paletteSel, Math.max(0, paletteHits.length - 1));
  $("#palette-list").innerHTML = paletteHits.map((it, i) => `<li role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === paletteSel}">
    <span>${esc(it.label)}</span><span class="muted small">${esc(it.hint)}</span></li>`).join("") || '<li class="muted small">Nichts gefunden.</li>';
  $("#palette-input").setAttribute("aria-activedescendant", paletteHits.length ? `pal-${paletteSel}` : "");
  $(`#pal-${paletteSel}`)?.scrollIntoView({ block: "nearest" });
}
function openPalette() {
  if ($("#palette").open) return;
  $("#palette-input").value = "";
  paletteSel = 0;
  renderPalette();
  setNavOpen(false);
  $("#palette").showModal();
  $("#palette-input").focus();
}
function runPalette(i) {
  const it = paletteHits[i];
  if (!it) return;
  $("#palette").close();
  it.run();
}
$("#palette-btn").addEventListener("click", openPalette);
$("#palette-input").addEventListener("input", () => { paletteSel = 0; renderPalette(); });
$("#palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = paletteHits.length;
    if (n) paletteSel = (paletteSel + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    renderPalette();
  } else if (e.key === "Enter") { e.preventDefault(); runPalette(paletteSel); }
});
$("#palette-list").addEventListener("click", (e) => { const li = e.target.closest("li[data-i]"); if (li) runPalette(Number(li.dataset.i)); });
// ---------- keyboard shortcuts (the palette shows them, "?" opens the overview) ----------
const isTyping = (e) => {
  const t = e.target;
  if (!t || t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return !!t;
  return t.tagName === "INPUT" && !/^(checkbox|radio|button|submit|range|color|file)$/.test(t.type);
};
function openShortcuts() { if (!$("#shortcuts").open) { setNavOpen(false); $("#shortcuts").showModal(); } }
$("#shortcuts-close").addEventListener("click", () => $("#shortcuts").close());
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "k") { e.preventDefault(); openPalette(); }
    else if (k === "n") { e.preventDefault(); go("#/new"); }
    else if (k === ",") { e.preventDefault(); go("#/settings"); }
    else if (k === "s" && edit) { e.preventDefault(); $("#edit-save").click(); }
  } else if (e.key === "?" && !mod && !isTyping(e) && !document.querySelector("dialog[open]")) { e.preventDefault(); openShortcuts(); }
});

// ---------- desktop app (Tauri shell): the panel appears only while the shell polls the backend ----------
let desktopShell = null, desktopAnnounced = null, desktopTimer = null, desktopRetries = 0;
const UPDATE_BUSY = ["preparing", "downloading", "verifying", "installing"];
async function refreshDesktop() {
  let d;
  clearTimeout(desktopTimer);
  try { d = await api("/api/desktop"); } catch {
    // the installer stops the backend: the window keeps the view until the app restarts
    if (["verifying", "installing"].includes(updateView.update?.state)) { renderUpdateView({ ...updateView.update }, { gone: true }); desktopTimer = setTimeout(refreshDesktop, 2000); }
    return;
  }
  desktopShell = d.shell;
  $("#desktop-panel").hidden = !d.shell;
  if (!d.shell) {
    if (store.get("update") && desktopRetries++ < 10) desktopTimer = setTimeout(refreshDesktop, 3000);  // the shell's first poll is still to come
    return;
  }
  $("#desktop-version").textContent = d.shell.version || "–";
  $("#desktop-autostart").checked = !!d.shell.autostart;
  $("#desktop-notify").checked = !!d.notify;
  $("#desktop-preview").checked = !!d.preview;
  const u = d.shell.update;
  renderDesktopUpdate(u);
  followUpdate(u, d.shell.version);
  if (u?.state === "available" && desktopAnnounced !== u.version && !updateView.update) {  // once per announced version
    desktopAnnounced = u.version;
    toast(`Version ${u.version} der Desktop-App ist da.`, "info", 9000, { label: "Ansehen", run: () => go("#/settings") });
  }
  const busy = UPDATE_BUSY.includes(u?.state) || updateView.waiting;
  desktopTimer = setTimeout(refreshDesktop, busy ? 500 : 5 * 60 * 1000);
}
const fmtMB = (bytes) => fmtNum(bytes / 1048576, "", bytes < 10 * 1048576 ? 1 : 0);
function fmtLeft(s) {
  if (!Number.isFinite(s) || s < 0) return "";
  if (s < 5) return "gleich fertig";
  if (s < 60) return `noch etwa ${Math.ceil(s / 5) * 5} s`;
  return `noch etwa ${Math.ceil(s / 60)} Min.`;
}
function renderDesktopUpdate(u) {
  const el = $("#desktop-update");
  $("#desktop-install").hidden = u?.state !== "available";
  $("#desktop-check").disabled = !!u && UPDATE_BUSY.includes(u.state);
  if (!u) { el.textContent = ""; return; }
  const at = u.checked ? ` (geprüft ${new Date(u.checked * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })})` : "";
  const first = (u.notes || "").split("\n").find((l) => l.trim()) || "";
  const text = {
    unknown: "Noch nicht nach Updates gesucht.",
    none: `Auf dem neuesten Stand${at}.`,
    available: `${/-/.test(u.version) ? "Vorschau-Version" : "Version"} ${u.version} ist da${first ? ` – ${first.slice(0, 140).replace(/[.!]$/, "")}` : ""}.`,
    preparing: "Das Update wird vorbereitet …",
    downloading: `Lädt Version ${u.version} … ${u.total > 0 ? `${Math.floor(((u.downloaded || 0) / u.total) * 100)} %` : `${fmtMB(u.downloaded || 0)} MB`}`,
    verifying: "Prüft die Signatur des Updates …",
    installing: "Installiert – die App startet gleich neu.",
    error: u.failed_step ? `Update fehlgeschlagen: ${updateErrorText(u)}` : `Update-Prüfung fehlgeschlagen: ${u.error || "unbekannter Fehler"}`,
    unconfigured: "Updates sind in diesem Build nicht eingerichtet.",
  }[u.state] || "";
  el.textContent = text;
  el.className = `small ${u.state === "error" ? "warn" : u.state === "available" ? "ok" : "muted"}`;
  if (UPDATE_BUSY.includes(u.state) && !$("#update-view").open) {
    el.append(" ");
    const show = document.createElement("button");
    show.type = "button"; show.className = "link-btn"; show.textContent = "Anzeigen";
    show.addEventListener("click", () => openUpdateView());
    el.append(show);
  }
}

// ---------- the update view: steps, megabytes, speed, errors (the shell pushes its state while it installs) ----------
const UPDATE_STEPS = ["preparing", "downloading", "verifying", "installing", "restarting"];
// request: the command that started it (for „Erneut versuchen“); waiting: sent, but the shell has not answered with a
// newer state (rev) than `sinceRev` yet, so an old error or "available" is not shown as the outcome
const updateView = { request: null, update: null, waiting: false, waitingSince: 0, sinceRev: -1, hidden: false };
function updateErrorText(u) {
  const raw = String(u.error || "");
  if (/^(Version .* läuft schon|Es gibt gerade kein Update)/.test(raw)) return raw;
  return {
    preparing: "Die Update-Infos von GitHub ließen sich nicht laden. Ist das Internet da?",
    downloading: "Der Download ist abgebrochen. Ist das Internet da? „Erneut versuchen“ lädt das Update noch einmal.",
    verifying: "Die heruntergeladene Datei hat keine gültige Signatur. Zur Sicherheit wurde nichts installiert.",
    installing: "Der Installer ließ sich nicht starten. Conclave läuft in der bisherigen Version weiter.",
  }[u.failed_step] || raw || "Unbekannter Fehler.";
}
function openUpdateView() {
  updateView.hidden = false;
  if (!$("#update-view").open) $("#update-view").showModal();
  renderUpdateView(updateView.update || { state: "preparing" });
}
// start an install: "install_update" (the announced update) or "install_version" (any version, also an older one)
async function startUpdate(request) {
  updateView.request = request;
  updateView.update = { state: "preparing", version: request.value || desktopShell?.update?.version, rev: -1 };
  updateView.waiting = true;
  updateView.waitingSince = Date.now();
  updateView.sinceRev = desktopShell?.update?.rev ?? -1;
  store.set("update", JSON.stringify({ to: updateView.update.version || "", from: desktopShell?.version || "", request }));
  openUpdateView();
  await api("/api/desktop/command", { method: "POST", body: request });
  clearTimeout(desktopTimer);
  desktopTimer = setTimeout(refreshDesktop, 400);
}
// what the poll brought: open the view when an install runs (also one started elsewhere), report the end
function followUpdate(u, version) {
  if (!u) return;
  const busy = UPDATE_BUSY.includes(u.state);
  if (updateView.waiting) {
    if ((u.rev ?? 0) > updateView.sinceRev && (busy || u.state === "error")) updateView.waiting = false;
    else if (Date.now() - updateView.waitingSince > 30000) {  // the shell never took the command
      updateView.waiting = false;
      u = { ...u, state: "error", failed_step: "preparing", error: "Die Desktop-App hat den Auftrag nicht angenommen." };
    } else return;  // the command has not reached the shell yet: keep "Vorbereiten"
  }
  if (busy) {
    updateView.update = u;
    if (!updateView.hidden && !$("#update-view").open) $("#update-view").showModal();
    renderUpdateView(u);
  } else if (updateView.update && UPDATE_BUSY.includes(updateView.update.state)) {
    updateView.update = u;  // the install ended without restarting: an error (or nothing happened)
    renderUpdateView(u);
    if (u.state === "error" && !$("#update-view").open) openUpdateView();
  }
  renderUpdateIndicator();
  const pending = (() => { try { return JSON.parse(store.get("update") || "null"); } catch { return null; } })();
  if (pending && !busy) {
    if (pending.to && version === pending.to && pending.from !== version) {
      toast(`Conclave ${version} ist installiert.`, "success", 7000);
      store.set("update", "");
    } else if (u.state === "error" && u.failed_step && !updateView.update) {
      updateView.request = pending.request;  // the app restarted after a failed install: show what went wrong
      updateView.update = u;
      openUpdateView();
      store.set("update", "");
    } else if (u.state !== "error") store.set("update", "");
  }
}
function renderUpdateView(u, { gone = false } = {}) {
  const state = gone ? "restarting" : u.state;
  const failed = state === "error";
  const step = failed ? (u.failed_step || "preparing") : state;
  const at = UPDATE_STEPS.indexOf(step);
  $$("#uv-steps li").forEach((li, i) => {
    li.className = i < at ? "done" : i === at ? (failed ? "failed" : "current") : "";
    li.toggleAttribute("aria-current", i === at);
  });
  const version = u.version || updateView.request?.value || "";
  const preview = /-/.test(version);
  $("#uv-title").textContent = failed ? "Update fehlgeschlagen"
    : version ? `${preview ? "Vorschau " : ""}${version} wird installiert` : "Update wird installiert";
  const from = u.current || desktopShell?.version;
  $("#uv-sub").textContent = from && version ? `Conclave ${from} → ${version}` : "Conclave";
  // percent, megabytes, speed, time left
  const bar = $("#uv-bar"), fill = bar.firstElementChild;
  const measured = state === "downloading" && u.total > 0;
  bar.classList.toggle("indeterminate", state === "preparing" || (state === "downloading" && !measured));
  bar.classList.toggle("working", ["verifying", "installing", "restarting"].includes(state));
  bar.hidden = failed;
  $(".uv-figures").hidden = failed;
  const pct = measured ? Math.min(100, Math.floor((u.downloaded / u.total) * 100))
    : ["verifying", "installing", "restarting"].includes(state) ? 100 : failed ? (u.progress ?? 0) : 0;
  fill.style.width = `${pct}%`;
  if (measured) bar.setAttribute("aria-valuenow", pct); else bar.removeAttribute("aria-valuenow");
  $("#uv-percent").textContent = state === "downloading" ? (measured ? `${pct} %` : fmtMB(u.downloaded || 0) + " MB") : failed ? "" : state === "preparing" ? "" : "100 %";
  let detail = "";
  if (state === "downloading") {
    const parts = [measured ? `${fmtMB(u.downloaded || 0)} von ${fmtMB(u.total)} MB` : "Größe unbekannt"];
    if (u.speed > 0) parts.push(`${fmtNum(u.speed / 1048576, "", 1)} MB/s`);
    if (measured && u.speed > 0) parts.push(fmtLeft((u.total - u.downloaded) / u.speed));
    detail = parts.join(" · ");
  } else if (["verifying", "installing", "restarting"].includes(state) && u.total) detail = `${fmtMB(u.total)} MB geladen`;
  $("#uv-detail").textContent = detail;
  $("#uv-status").textContent = {
    preparing: "Fragt GitHub nach der Update-Datei …",
    downloading: "Lädt das Update herunter. Du kannst so lange weiterarbeiten.",
    verifying: "Prüft die Signatur, damit nur echte Conclave-Updates installiert werden …",
    installing: "Beendet den Hintergrunddienst und startet den Installer …",
    restarting: "Der Installer läuft. Conclave schließt sich kurz und startet danach von selbst neu.",
    error: "",
  }[state] ?? "";
  $("#uv-error").hidden = !failed;
  if (failed) {
    $("#uv-error-text").textContent = updateErrorText(u);
    $("#uv-error-raw").textContent = u.error || "–";
  }
  $("#uv-hide").hidden = failed || ["installing", "restarting"].includes(state);
  $("#uv-close").hidden = !failed;
  $("#uv-log").hidden = !failed;
  $("#uv-retry").hidden = !failed || !updateView.request || /^Version .* läuft schon/.test(u.error || "");
  $("#update-view .dialog-actions").hidden = $$("#update-view .dialog-actions .btn").every((b) => b.hidden);
  renderUpdateIndicator();
}
// the sidebar pill while the view is hidden: a ring with the percentage
function renderUpdateIndicator() {
  const u = updateView.update, ind = $("#update-indicator");
  const show = !!u && !$("#update-view").open && (UPDATE_BUSY.includes(u.state) || (u.state === "error" && updateView.hidden));
  ind.hidden = !show;
  if (!show) return;
  const pct = u.state === "downloading" && u.total > 0 ? Math.floor((u.downloaded / u.total) * 100) : u.state === "preparing" ? 0 : 100;
  ind.style.setProperty("--p", pct);
  ind.classList.toggle("failed", u.state === "error");
  $("#update-indicator-text").textContent = u.state === "error" ? "Update fehlgeschlagen"
    : u.state === "downloading" ? `Update lädt … ${u.total > 0 ? pct + " %" : ""}` : "Update wird installiert …";
}
$("#update-indicator").addEventListener("click", openUpdateView);
$("#uv-hide").addEventListener("click", () => { updateView.hidden = true; $("#update-view").close(); renderUpdateIndicator(); });
$("#uv-close").addEventListener("click", () => { updateView.hidden = false; updateView.update = null; $("#update-view").close(); renderUpdateIndicator(); });
$("#uv-log").addEventListener("click", () => api("/api/desktop/command", { method: "POST", body: { type: "open_log" } }).catch(fail));
$("#uv-retry").addEventListener("click", () => { if (updateView.request) startUpdate(updateView.request).catch(fail); });
$("#update-view").addEventListener("cancel", (e) => {  // Esc: hide while downloading, never during the install itself
  const st = updateView.update?.state;
  e.preventDefault();
  if (st === "error" || !UPDATE_BUSY.includes(st)) $("#uv-close").click();
  else if (!["installing"].includes(st)) $("#uv-hide").click();
});
$("#desktop-check").addEventListener("click", async () => {
  try {
    await api("/api/desktop/command", { method: "POST", body: { type: "check_update" } });
    $("#desktop-update").textContent = "Suche nach Updates …";
    clearTimeout(desktopTimer);
    desktopTimer = setTimeout(refreshDesktop, 15000);
  } catch (err) { fail(err); }
});
$("#desktop-install").addEventListener("click", () => startUpdate({ type: "install_update" }).catch(fail));
// preview builds and switching to any other version (also back to an older one)
let desktopReleases = [];
const versionKey = (v) => {  // 0.1.10-preview.3 sorts after 0.1.9 and before 0.1.10
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[^.]+\.(\d+))?/.exec(v || "") || [];
  return [+m[1] || 0, +m[2] || 0, +m[3] || 0, m[4] === undefined ? Infinity : +m[4]];
};
const olderThan = (a, b) => { const x = versionKey(a), y = versionKey(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };
async function loadDesktopVersions() {
  const sel = $("#desktop-versions"), note = $("#desktop-versions-note"), current = desktopShell?.version;
  note.textContent = "Lädt die Versionen von GitHub …";
  $("#desktop-switch").disabled = true;
  try { desktopReleases = (await api("/api/desktop/releases")).releases; } catch (err) { note.textContent = err.message; return; }
  sel.innerHTML = desktopReleases.map((r) => {
    const date = r.date ? new Date(r.date).toLocaleDateString("de-DE", { day: "numeric", month: "short" }) : "";
    const label = `${r.version}${r.preview ? " · Vorschau" : ""}${date ? ` · ${date}` : ""}${r.version === current ? " · läuft gerade" : ""}`;
    return `<option value="${esc(r.version)}"${r.version === current ? " disabled" : ""}>${esc(label)}</option>`;
  }).join("");
  const pick = desktopReleases.find((r) => r.version !== current && olderThan(r.version, current)) || desktopReleases.find((r) => r.version !== current);
  if (pick) sel.value = pick.version;
  note.textContent = desktopReleases.length ? "" : "Keine Versionen gefunden.";
  $("#desktop-switch").disabled = !pick;
}
$("#desktop-other").addEventListener("toggle", (e) => { if (e.target.open) void loadDesktopVersions(); });
$("#desktop-versions").addEventListener("change", () => { $("#desktop-switch").disabled = !$("#desktop-versions").value; });
$("#desktop-preview").addEventListener("change", async (e) => {
  try {
    await api("/api/settings", { method: "POST", body: { desktop_preview: e.target.checked } });
    await api("/api/desktop/command", { method: "POST", body: { type: "check_update" } });
    toast(e.target.checked ? "Vorschau-Versionen werden ab jetzt angeboten." : "Nur noch freigegebene Versionen. Eine Vorschau bleibt, bis die nächste Version kommt.");
    if ($("#desktop-other").open) void loadDesktopVersions();
    clearTimeout(desktopTimer);
    desktopTimer = setTimeout(refreshDesktop, 15000);
  } catch (err) { fail(err); }
});
$("#desktop-switch").addEventListener("click", async () => {
  const version = $("#desktop-versions").value, current = desktopShell?.version;
  const r = desktopReleases.find((x) => x.version === version);
  if (!r) return;
  const older = olderThan(version, current);
  const ok = await ask({
    title: `Zu Version ${version} wechseln?`,
    text: older
      ? `Version ${version} ist älter als ${current}. Was danach dazukam, fehlt dort. Vorher wird eine Sicherung deiner Daten angelegt, dann startet die App neu. Neuere Versionen bietet sie dir weiter an.`
      : `Vorher wird eine Sicherung deiner Daten angelegt, dann startet die App neu.`,
    ok: "Wechseln",
  });
  if (!ok) return;
  try {
    await api("/api/backups", { method: "POST" });
    await startUpdate({ type: "install_version", value: version });
  } catch (err) { fail(err); }
});
$("#desktop-autostart").addEventListener("change", async (e) => {
  try {
    await api("/api/desktop/command", { method: "POST", body: { type: "autostart", value: e.target.checked } });
    toast(e.target.checked ? "Startet künftig beim Anmelden im Hintergrund." : "Startet nicht mehr automatisch.");
  } catch (err) { fail(err); }
});
$("#desktop-notify").addEventListener("change", async (e) => {
  try { await api("/api/settings", { method: "POST", body: { desktop_notify: e.target.checked } }); } catch (err) { fail(err); }
});
$("#desktop-data").addEventListener("click", () => api("/api/desktop/command", { method: "POST", body: { type: "open_data" } }).catch(fail));
$("#desktop-log").addEventListener("click", () => api("/api/desktop/command", { method: "POST", body: { type: "open_log" } }).catch(fail));
if (/Mac|iPhone|iPad/.test(navigator.platform)) $("#palette-btn kbd").textContent = "⌘ K";

// ============================================================================================
// start
// ============================================================================================
wireAutocomplete($("#bl-input"), $("#ac-bl"));
wireAutocomplete($("#tr-input"), $("#ac-tr"));
wireAutocomplete($("#opp-new [name=commander]"), $("#ac-opp-new"));
wireAutocomplete($("#opp-form [name=commander]"), $("#ac-opp-edit"));
wireAutocomplete($("#opp-form [name=partner]"), $("#ac-opp-partner"));
void refreshBlacklist();
loadSettings().catch((err) => console.error(err));
Promise.all([initBrackets(), refreshDeckList(), refreshCollectionSummary(), refreshTableRules(), refreshOpponents(), refreshSales()]).then(route, (err) => { fail(err); void route(); });
void refreshSync({ quiet: true });
// the desktop shell polls the backend a few seconds after the start; sooner after an update, to report how it went
setTimeout(refreshDesktop, store.get("update") ? 4000 : 20000);
