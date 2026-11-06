"use strict";
// The desktop GUI, part 15 of 21: the Verkaufsliste and selling on Cardmarket.
// index.html loads the parts in order; they share one global scope.

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
    ${o.elsewhere?.cards ? `<p class="small away-line">${o.elsewhere.cards === 1 ? "1 Karte hast du, sie liegt" : `${o.elsewhere.cards} Karten hast du, sie liegen`} aber woanders${o.elsewhere.played ? ` (${o.elsewhere.played} davon nur in Decks, die sie spielen)` : " (z. B. im Bulk)"}.
      <button type="button" class="btn small" id="own-away">Woanders gelagert …</button></p>` : ""}
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
  if (e.target.closest("#own-away")) void openAway();
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
