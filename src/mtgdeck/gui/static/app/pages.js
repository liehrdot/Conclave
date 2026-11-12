"use strict";
// The desktop GUI, part 19 of 21: Über Conclave, the glossary, the quick search and the keyboard shortcuts.
// index.html loads the parts in order; they share one global scope.

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
    { label: "Was ist neu?", hint: "Neu in dieser Version", run: () => openWhatsNew() },
  ];
  if (currentDeck && parseHash().view === "deck") {
    const d = currentDeck;
    const tabNames = { karten: "Karten", testen: "Testhand & Wahrscheinlichkeiten", partien: "Partien & Bilanz", verlauf: "Verlauf", drucken: "Drucken" };
    for (const [tab, label] of Object.entries(tabNames)) items.push({ label, hint: d.name, run: () => selectTab(tab) });
    items.push({ label: "Karten bearbeiten", hint: d.name, run: () => { selectTab("karten"); if (!edit) setEditing(true); } });
    items.push({ label: "Einkaufsliste mit Preisen", hint: d.name, run: () => openBuylist() });
    items.push({ label: "Woanders gelagerte Karten", hint: `${d.name} · liegen im Bulk oder an einem anderen Ort`, run: () => openAway() });
    items.push({ label: "Spieltisch", hint: `${d.name} · Goldfish: ein paar Züge allein spielen`, run: () => { selectTab("testen"); void ptOpen(); } });
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
