"use strict";
// The desktop GUI, part 18 of 21: Sammelbestellungen, deck compare and the Einkaufsliste.
// index.html loads the parts in order; they share one global scope.

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
// where a row's card already is, for the picked places: [{label, text, planned}]; planned = a deck only lists it, you have no copy
function buyWhere(i, picked) {
  return (buyData.places || []).filter((o) => picked.has(o.key)).flatMap((o) => {
    const at = i.places?.[o.key];
    if (o.kind === "deck") {
      const d = i.decks.find((x) => x.slug === o.slug);
      if (d?.planned && !at) return [{ label: o.label, text: "nur geplant", planned: true }];
      return d || at ? [{ label: o.label, text: d && d.qty > 1 ? `×${d.qty}` : "" }] : [];
    }
    if (!at || !(at.real || at.proxy)) return [];
    return [{ label: o.label, text: [at.real ? `×${at.real}` : "", at.proxy ? `${at.proxy} Proxy` : ""].filter(Boolean).join(" + ") }];
  });
}
// the picked places that really hold the card (a deck that only plans it does not)
const buyHeld = (i, picked) => buyWhere(i, picked).filter((w) => !w.planned);
function renderBuyCompare() {
  const r = buyData, opts = r.places || [];
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(buyCompareKey()) || "[]"); } catch { saved = []; }
  saved = saved.map((s) => (s.includes(":") ? s : `deck:${s}`));  // picks from before places were added were deck slugs
  const count = (o) => r.items.filter((i) => buyHeld(i, new Set([o.key])).length).length;
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
    const inPicked = buyWhere(i, picked), held = inPicked.filter((w) => !w.planned).length;
    if ((mode === "in" && !held) || (mode === "none" && held)) return "";
    const over = max != null && (i.trend || 0) > max;
    const pills = inPicked.length ? `<span class="buy-in">${inPicked.map((w) =>
      `<span class="pill${w.planned ? " planned" : ""}"${w.planned ? ' title="Steht in der Deckliste, aber du hast keine Karte davon"' : ""}>${esc(w.label)}${w.text ? ` ${esc(w.text)}` : ""}</span>`).join("")}</span>` : "";
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
  const shared = picked.size ? r.items.filter((i) => buyHeld(i, picked).length).length : 0;
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
