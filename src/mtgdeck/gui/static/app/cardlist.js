"use strict";
// The desktop GUI, part 6 of 21: the Karten tab's card list, its edit mode and cards dragged in from scryfall.com.
// index.html loads the parts in order; they share one global scope.

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
      const data = `data-img="${esc(img || "")}" data-img-back="${esc(back)}" data-name="${esc(c.name)}"${copy?.foil ? ` data-foil="${esc(copy.foil_kind || "foil")}"` : ""}`;
      const label = `${c.qty > 1 ? c.qty + "× " : ""}${c.name}${copy?.foil ? ` (${foilName(copy)})` : ""}`;
      if (grid) {
        return `<div class="card${copy?.foil ? " foil" : ""}" role="button" tabindex="0" ${data} aria-label="${esc(label)} – große Ansicht">
          ${img ? `<img src="${esc(img)}" alt="" loading="lazy">${copy?.foil ? '<span class="foil-sheen" aria-hidden="true"></span>' : ""}` : `<div class="noimg">${esc(c.name)}</div>`}
          ${c.qty > 1 ? `<span class="qty-badge">${c.qty}×</span>` : ""}${own ? `<span class="own-badge">${own}</span>` : ""}</div>`;
      }
      const name = `${esc(c.name)}${cd.image_back ? '<span class="dfc" title="doppelseitig">⇄</span>' : ""}${cd.game_changer ? '<span class="gc" title="Game Changer">GC</span>' : ""}${copy?.foil ? `<span class="foil-tag" title="${esc(foilName(copy))} – liegt so im Deck">${esc(foilName(copy))}</span>` : ""}`;
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
  return !dragFromApp && types.some((t) => DROP_TYPES.includes(t)) && !($("#picker").open && types.includes("Files")) && !isListFileDrag(e);
};
const dropIntoDeck = () => parseHash().view === "deck" && !!currentDeck;
// a decklist file dragged in from the file manager while „Neues Deck“ is open goes into „Liste einfügen“;
// a card picture dragged from scryfall.com also carries „Files“, but always with its link, so it stays a card drop
const isListFileDrag = (e) => {
  const types = [...(e.dataTransfer?.types || [])];
  return !dragFromApp && types.includes("Files") && !types.includes("text/uri-list") && !types.includes("text/html")
    && !document.querySelector("dialog[open]") && !$("#import-box").closest(".view").hidden;
};
document.addEventListener("dragover", (e) => {
  if (!isListFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  $("#import-text").classList.add("file-over");
  clearTimeout(fileOverTimer);
  fileOverTimer = setTimeout(() => $("#import-text").classList.remove("file-over"), 250);
});
let fileOverTimer = 0;
document.addEventListener("drop", (e) => {
  if (!isListFileDrag(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  $("#import-text").classList.remove("file-over");
  const file = e.dataTransfer.files?.[0];
  if (file) void importFromFile(file);
});
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
