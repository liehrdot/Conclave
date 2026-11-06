"use strict";
// The desktop GUI, part 13 of 21: the Drucken tab: print studio, before/after view, MPC Autofill terminal.
// index.html loads the parts in order; they share one global scope.

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
