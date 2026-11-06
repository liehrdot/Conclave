"use strict";
// The desktop GUI, part 7 of 21: the collection in the deck: ownership badges, moving copies in, copies stored elsewhere.
// index.html loads the parts in order; they share one global scope.

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
  if ($("#away").open && away?.slug === slug) await openAway();
  if (currentDeck?.slug === slug) await loadOwnership(currentDeck);
}

// ---------- the deck's cards you own that lie at another Ort (Bulk, a binder, another deck) ----------
let away = null;  // stored_elsewhere() of the open deck
let awayMoved = [];  // [{name, from, moved}] put into the deck while the dialog is open: „Zurücklegen“ (the toast sits behind the dialog)
async function openAway() {
  const slug = currentDeck?.slug;
  if (!slug) return;
  if (!$("#away").open || away?.slug !== slug) awayMoved = [];
  const filter = OWN_FILTERS[store.get("awayfilter")] ? store.get("awayfilter") : "all";
  $("#away-filter").querySelector(`input[value="${filter}"]`).checked = true;
  $("#away-decks").checked = store.get("awaydecks") === "1";
  try { away = await api(`/api/decks/${enc(slug)}/elsewhere`); } catch (err) { return fail(err); }
  if (currentDeck?.slug !== slug) return;
  $("#away-title").textContent = `Woanders gelagert: ${currentDeck.name}`;
  renderAway();
  const dlg = $("#away");
  if (!dlg.open) dlg.showModal();
}
// the shown copies, grouped by where they lie: free-text places first, then no Ort, then other decks
function awayGroups() {
  const want = OWN_FILTERS[$("#away-filter").querySelector("input:checked").value];
  const fromDecks = $("#away-decks").checked;
  const groups = new Map();
  for (const r of away?.rows || []) {
    for (const c of r.copies) {
      if (!want(c) || (c.used_by && !fromDecks)) continue;
      const key = placeKey(c);
      if (!groups.has(key)) {
        const rank = c.place_deck ? 2 : key === "none" ? 1 : 0;
        groups.set(key, { key, rank, label: placeLabel(c) || "Ohne Ort", items: [] });
      }
      groups.get(key).items.push({ row: r, copy: c });
    }
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, "de"));
}
function renderAway() {
  const groups = awayGroups();
  const shown = new Set(groups.flatMap((g) => g.items.map((i) => i.row.name)));
  const hiddenPlayed = (away?.rows || []).filter((r) => !shown.has(r.name) && r.copies.some((c) => c.used_by)).length;
  $("#away-text").textContent = away?.cards
    ? `${away.cards} ${away.cards === 1 ? "Karte dieses Decks hast du" : "Karten dieses Decks hast du"}, aber ${away.cards === 1 ? "sie liegt" : "sie liegen"} nicht im Deck. „Ins Deck“ setzt den Ort auf dieses Deck.`
    : "Alles, was du von diesem Deck besitzt, liegt schon im Deck.";
  const row = ({ row: r, copy: c }) => {
    const facts = [`${c.qty}×`, c.proxy ? "Proxy" : "Echt", copyLabel({ ...c, proxy: false })].filter(Boolean).join(" · ");
    const take = Math.min(c.qty, Math.max(1, r.open));
    return `<div class="oc-row">
      ${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" data-img="${esc(c.image)}" class="card">` : '<span class="oc-noimg"></span>'}
      <div><b>${esc(r.name)}</b><small>${esc(facts)}</small>
        <small>Im Deck: ${r.placed} von ${r.need}</small>
        ${c.used_by ? `<small class="warn">Wird in „${esc(c.used_by)}“ gespielt</small>` : ""}</div>
      <span class="oc-act">
        ${c.qty > 1 ? `<input type="number" min="1" max="${c.qty}" value="${take}" aria-label="Wie viele davon?" data-qty>` : ""}
        <button type="button" class="btn small" data-move="${esc(c.id)}" data-name="${esc(r.name)}">Ins Deck</button></span></div>`;
  };
  const back = awayMoved.length ? `<h3>Gerade ins Deck gelegt</h3>${awayMoved.map((m, i) => `<div class="oc-row">
      ${m.image ? `<img src="${esc(m.image)}" alt="" loading="lazy">` : '<span class="oc-noimg"></span>'}<div><b>${esc(m.name)}</b><small>${m.moved.qty}× aus „${esc(m.from)}“</small></div>
      <button type="button" class="btn small" data-back="${i}">Zurücklegen</button></div>`).join("")}` : "";
  $("#away-list").innerHTML = back + (groups.length
    ? groups.map((g) => `<h3>${esc(g.label)} <span class="count">· ${g.items.length} ${g.items.length === 1 ? "Karte" : "Karten"}</span></h3>${g.items.map(row).join("")}`).join("")
    : `<p class="muted small">${away?.cards ? "Keine Exemplare für diese Auswahl." : ""}</p>`);
  if (hiddenPlayed && !$("#away-decks").checked)
    $("#away-list").insertAdjacentHTML("beforeend", `<p class="muted small">${hiddenPlayed} ${hiddenPlayed === 1 ? "weitere Karte liegt" : "weitere Karten liegen"} nur in Decks, die sie spielen – siehe „Auch aus Decks, die die Karte spielen“.</p>`);
  $("#away-copy").disabled = !groups.length;
}
$("#away-filter").addEventListener("change", (e) => { store.set("awayfilter", e.target.value); renderAway(); });
$("#away-decks").addEventListener("change", (e) => { store.set("awaydecks", e.target.checked ? "1" : "0"); renderAway(); });
$("#away-close").addEventListener("click", () => $("#away").close());
$("#away").addEventListener("close", () => { away = null; awayMoved = []; });
$("#away-btn").addEventListener("click", (e) => { e.target.closest("details")?.removeAttribute("open"); void openAway(); });
// a pick list per place: what to take out of the Bulk, the binder …
$("#away-copy").addEventListener("click", async () => {
  const text = awayGroups().map((g) => `${g.label}:\n${g.items.map(({ row: r, copy: c }) => `${Math.min(c.qty, r.open)} ${r.name}${c.proxy ? " (Proxy)" : ""}`).join("\n")}`).join("\n\n");
  try { await navigator.clipboard.writeText(text); toast("Liste kopiert – sortiert nach Ort."); }
  catch { toast("Kopieren nicht erlaubt.", "error"); }
});
$("#away-list").addEventListener("click", async (e) => {
  const back = e.target.closest("[data-back]");
  if (back && away && awayMoved[back.dataset.back]) {
    const m = awayMoved[back.dataset.back];
    back.disabled = true;
    awayMoved = awayMoved.filter((x) => x !== m);
    return undoOwnMove(away.slug, m.name, m.moved).catch((err) => { back.disabled = false; awayMoved.push(m); fail(err); });
  }
  const btn = e.target.closest("[data-move]");
  if (!btn || !away) return;
  const { slug } = away, name = btn.dataset.name;
  const entry = away.rows.flatMap((r) => r.copies).find((c) => c.id === btn.dataset.move);
  if (!entry) return;
  const input = btn.closest(".oc-row").querySelector("[data-qty]");
  const qty = input ? Math.min(entry.qty, Math.max(1, Math.round(Number(input.value) || 1))) : entry.qty;
  btn.disabled = true;
  try {
    const moved = await api(`/api/decks/${enc(slug)}/copies/move`, { method: "POST", body: { id: entry.id, qty } });
    const deckName = currentDeck?.slug === slug ? currentDeck.name : slug;
    const m = { name, from: placeLabel(entry) || "Ohne Ort", image: entry.image, moved };
    awayMoved.push(m);
    toast(`${moved.qty}× ${name} liegt jetzt in „${deckName}“.`, "ok", 6000,
      { label: "Rückgängig", run: () => { awayMoved = awayMoved.filter((x) => x !== m); return undoOwnMove(slug, name, moved).catch(fail); } });
    await afterOwnMove(slug, name);
  } catch (err) { btn.disabled = false; fail(err); }
});

// the foil look of an own copy (`foil_kind` from the printing's Scryfall promo types), named like on the card
const FOIL_NAMES = {
  foil: "Foil", etched: "Etched Foil", surge: "Surge Foil", ripple: "Ripple Foil", galaxy: "Galaxy Foil", confetti: "Confetti Foil",
  halo: "Halo Foil", textured: "Textured Foil", oilslick: "Oil Slick Foil", rainbow: "Rainbow Foil", gilded: "Gilded Foil",
  fracture: "Fracture Foil", mana: "Mana Foil",
};
const foilName = (c) => FOIL_NAMES[c?.foil_kind] || "Foil";

function copyLabel(c) {
  const lang = c.lang && c.lang !== "en" ? (LANG_NAMES[c.lang] || c.lang.toUpperCase()) : "";
  return [c.set_name || (c.set || "").toUpperCase(), c.collector_number ? `#${c.collector_number}` : "", c.foil ? foilName(c) : "", lang, c.proxy ? "Proxy" : ""]
    .filter(Boolean).join(" · ");
}
