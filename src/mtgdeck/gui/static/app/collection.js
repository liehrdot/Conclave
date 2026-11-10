"use strict";
// The desktop GUI, part 14 of 21: Meine Sammlung.
// index.html loads the parts in order; they share one global scope.

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

// import: which app the file comes from (only for the how-to; the backend recognises the format itself)
const IMPORT_APPS = [
  { id: "manabox", label: "ManaBox", steps: ["Öffne in ManaBox „Sammlung“ und wähle einen Binder oder die ganze Sammlung.",
    "Tippe auf ⋯ › „Exportieren“ › „CSV“ und schick dir die Datei auf den PC."], note: "Binder werden zu Orten." },
  { id: "moxfield", label: "Moxfield", moxfield: true, steps: ["Öffne auf moxfield.com deine „Collection“.",
    "Klicke auf „More“ › „Export“ und speichere die CSV-Datei."], note: "Proxys aus Moxfield bleiben Proxys." },
  { id: "archidekt", label: "Archidekt", steps: ["Öffne auf archidekt.com deine „Collection“.", "Klicke auf „Export“, wähle CSV und speichere die Datei."] },
  { id: "dragonshield", label: "Dragon Shield", steps: ["Öffne in der Dragon-Shield-App den Ordner (oder „All Cards“).",
    "Wähle „Export“ › „CSV“ und schick dir die Datei auf den PC."], note: "Ordner werden zu Orten." },
  { id: "deckbox", label: "Deckbox · Delver Lens", steps: ["Deckbox: „Inventory“ öffnen, oben rechts „Export“ klicken, Datei speichern.",
    "Delver Lens: „Export“ › Format „Deckbox“ wählen."] },
  { id: "tcgplayer", label: "TCGplayer", steps: ["Öffne in der TCGplayer-App deine Sammlung.", "Wähle „Export“ › „CSV“ und schick dir die Datei auf den PC."] },
  { id: "other", label: "Andere", steps: ["Jede CSV mit einer Kopfzeile geht, wenn sie eine Spalte „Name“ oder „Scryfall ID“ hat.",
    "Anzahl, Set-Code oder Set-Name, Nummer, Foil, Sprache und Ort werden erkannt, wenn es sie gibt."],
    note: "Auch Cardsphere, Helvault, MTGGoldfish und Deckstats. Oder eine Liste wie „2 Sol Ring (C21) 263 *F*“." },
];
let collImportApp = "";
function renderImportApps() {
  $("#coll-import-apps").innerHTML = IMPORT_APPS.map((a) =>
    `<button type="button" class="chip" data-app="${a.id}" aria-pressed="${a.id === collImportApp}">${esc(a.label)}</button>`).join("");
  const app = IMPORT_APPS.find((a) => a.id === collImportApp);
  const guide = $("#coll-import-guide");
  guide.hidden = !app;
  if (!app) return;
  guide.innerHTML = `<ol>${app.steps.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>${app.note ? `<p class="muted">${esc(app.note)}</p>` : ""}`
    + (app.moxfield ? `<div id="coll-mox-slot"></div>` : "");
  if (app.moxfield) void moxfieldCollectionButton();
}
async function moxfieldCollectionButton() {
  if (!(await moxfieldWindow()) || !$("#coll-mox-slot")) return;
  $("#coll-mox-slot").innerHTML = `<button type="button" class="btn" id="coll-mox-open">Moxfield-Fenster öffnen</button>
    <p class="muted">Melde dich dort an und klicke bei deiner Collection auf „Export“. Conclave übernimmt die Datei direkt.</p>`;
}
$("#coll-import-apps").addEventListener("click", (e) => {
  const b = e.target.closest("[data-app]");
  if (!b) return;
  collImportApp = collImportApp === b.dataset.app ? "" : b.dataset.app;
  store.set("importapp", collImportApp);
  renderImportApps();
});
$("#coll-import-guide").addEventListener("click", (e) => {
  if (!e.target.closest("#coll-mox-open")) return;
  location.href = "https://moxfield.com/collection";  // the desktop shell catches this and opens its Moxfield window
});
// the Moxfield window hands over the CSV its own „Export“ produced, in parts (see moxfield.js)
let moxParts = null;
function takeMoxfieldPart(d) {
  const parts = Math.min(Number(d.parts) || 1, 64), i = Number(d.part) || 0;
  if (typeof d.csv !== "string" || i < 0 || i >= parts) return;
  if (!moxParts || moxParts.id !== d.id) moxParts = { id: d.id, parts, got: [] };
  moxParts.got[i] = d.csv;
  if (moxParts.got.filter((x) => typeof x === "string").length < moxParts.parts) return;
  const csv = moxParts.got.join("");
  moxParts = null;
  takeMoxfieldCollection(csv);
}
function takeMoxfieldCollection(csv) {
  if (typeof csv !== "string" || !csv.trim()) { toast("Moxfield hat keine Sammlung geliefert.", "error"); return; }
  if (parseHash().view !== "collection") go("#/collection");
  const dlg = $("#coll-import-dialog");
  if (!dlg.open) { openCollImport(); }
  $("#coll-import-text").value = csv;
  showCollImportFile("Moxfield-Export", csv);
  void previewCollImport();
}

function resetCollImportFile() {
  $("#coll-import-drop").classList.remove("has-file", "dragging");
  $("#coll-import-file-name").textContent = "Datei hierher ziehen";
  $("#coll-import-file-hint").innerHTML = 'CSV oder TXT · oder <span class="link">Datei auswählen …</span>';
}
function showCollImportFile(name, text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  $("#coll-import-drop").classList.add("has-file");
  $("#coll-import-file-name").textContent = name;
  $("#coll-import-file-hint").innerHTML = `${fmtNum(lines)} Zeilen gelesen · <span class="link">Andere Datei …</span>`;
}
async function readCollImportFile(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast("Die Datei ist zu groß (höchstens 5 MB).", "error"); return; }
  $("#coll-import-text").value = decodeDeckFile(await file.arrayBuffer());
  showCollImportFile(file.name, $("#coll-import-text").value);
  void previewCollImport();
}

// preview: what the import would add, before anything is saved
let collPreviewSeq = 0, collPreviewTimer = 0, collPreviewCards = 0;
function resetCollPreview() {
  collPreviewSeq++;
  collPreviewCards = 0;
  $("#coll-import-preview").hidden = true;
  $("#coll-import-ok").textContent = "Importieren";
}
async function previewCollImport() {
  clearTimeout(collPreviewTimer);
  const text = $("#coll-import-text").value;
  if (!text.trim()) { resetCollPreview(); return; }
  const seq = ++collPreviewSeq, box = $("#coll-import-preview");
  box.hidden = false;
  box.classList.add("busy");
  if (!box.textContent.trim()) box.innerHTML = `<span class="muted">Prüfe die Karten …</span>`;
  try {
    const p = await api("/api/collection/import/preview", { method: "POST", body: { text, proxy: $("#coll-import-proxy").checked } });
    if (seq !== collPreviewSeq) return;
    renderCollPreview(p);
  } catch (err) {
    if (seq !== collPreviewSeq) return;
    collPreviewCards = 0;
    box.innerHTML = `<span class="cip-miss">${esc(err.message)}</span>`;
    $("#coll-import-ok").textContent = "Importieren";
  } finally { if (seq === collPreviewSeq) box.classList.remove("busy"); }
}
function renderCollPreview(p) {
  collPreviewCards = p.cards;
  const source = p.source === "Liste" ? "Kartenliste" : p.source === "CSV" ? "CSV-Datei" : `${p.source}-Export`;
  const facts = [`${fmtNum(p.entries)} ${p.entries === 1 ? "Eintrag" : "Einträge"}`,
    p.cards > p.with_printing ? `${fmtNum(p.cards - p.with_printing)} ohne Ausgabe` : "",
    p.foil ? `${fmtNum(p.foil)} Foil` : "", p.proxy ? `${fmtNum(p.proxy)} Proxy` : ""].filter(Boolean).join(" · ");
  const places = p.places.length ? `<span class="muted">Orte: ${p.places.slice(0, 4).map((x) => `${esc(x.place)} (${fmtNum(x.cards)})`).join(", ")}${p.places.length > 4 ? ` und ${p.places.length - 4} weitere` : ""}</span>` : "";
  const miss = p.not_found.length ? `<span class="cip-miss">${fmtNum(p.not_found.length)} nicht gefunden: ${esc(p.not_found.slice(0, 6).join(", "))}${p.not_found.length > 6 ? " …" : ""}</span>` : "";
  const rows = p.rows.map((r) => `<li><span class="q">${fmtNum(r.qty)}×</span><span class="n">${esc(r.name)}</span>
    <span class="m">${esc([r.set ? `${r.set.toUpperCase()} ${r.collector_number || ""}`.trim() : "", r.foil ? "Foil" : "", r.proxy ? "Proxy" : "", r.lang && r.lang !== "en" ? r.lang.toUpperCase() : ""].filter(Boolean).join(" · "))}</span></li>`).join("");
  $("#coll-import-preview").innerHTML = `<div class="cip-head"><strong>${fmtNum(p.cards)} ${p.cards === 1 ? "Karte" : "Karten"}</strong>
    <span class="cip-facts">${esc(source)} erkannt · ${facts}</span></div>${places}${miss}
    ${rows ? `<ul>${rows}</ul>${p.cards > p.rows.reduce((n, r) => n + r.qty, 0) ? `<span class="muted">…</span>` : ""}` : ""}`;
  $("#coll-import-ok").textContent = p.cards ? `${fmtNum(p.cards)} ${p.cards === 1 ? "Karte" : "Karten"} importieren` : "Importieren";
}

function openCollImport() {
  $("#coll-import-form").reset();
  resetCollImportFile();
  resetCollPreview();
  collImportApp = store.get("importapp") || "";
  renderImportApps();
  $("#coll-import-dialog").showModal();
}
$("#coll-import-btn").addEventListener("click", openCollImport);
$("#coll-import-cancel").addEventListener("click", () => $("#coll-import-dialog").close());
$("#coll-import-close").addEventListener("click", () => $("#coll-import-dialog").close());
$("#coll-import-file").addEventListener("change", (e) => { void readCollImportFile(e.target.files[0]); e.target.value = ""; });
$("#coll-import-text").addEventListener("input", () => {
  if ($("#coll-import-drop").classList.contains("has-file")) resetCollImportFile();
  clearTimeout(collPreviewTimer);
  collPreviewTimer = setTimeout(() => void previewCollImport(), 700);
});
$("#coll-import-proxy").addEventListener("change", () => { if ($("#coll-import-text").value.trim()) void previewCollImport(); });
const collImportDrop = $("#coll-import-drop");
collImportDrop.addEventListener("dragover", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  collImportDrop.classList.add("dragging");
});
collImportDrop.addEventListener("dragleave", (e) => { if (!collImportDrop.contains(e.relatedTarget)) collImportDrop.classList.remove("dragging"); });
// a file dropped anywhere on the open dialog counts, so a slightly missed drop doesn't open the file in the window
$("#coll-import-dialog").addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
$("#coll-import-dialog").addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  e.stopPropagation();
  collImportDrop.classList.remove("dragging");
  void readCollImportFile(e.dataTransfer.files[0]);
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
    toast(`${fmtNum(r.added)} Karten importiert.${r.not_found.length ? ` Nicht gefunden (${r.not_found.length}): ${r.not_found.slice(0, 5).join(", ")}${r.not_found.length > 5 ? " …" : ""}` : ""}`,
      r.not_found.length ? "error" : "info", 8000);
    await loadCollection();
  } catch (err) { fail(err); }
  finally { btn.disabled = false; btn.textContent = collPreviewCards ? `${fmtNum(collPreviewCards)} Karten importieren` : "Importieren"; }
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
