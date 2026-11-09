"use strict";
// The desktop GUI, part 9 of 21: tokens, replacement suggestions, card search by description and the deck actions.
// index.html loads the parts in order; they share one global scope.

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
  // a modal dialog sits in the top layer: the preview has to live inside it to show above it
  const host = el.closest("dialog[open]") || document.body;
  if (preview.parentElement !== host) host.appendChild(preview);
  preview.classList.toggle("big", !!el.closest("#playtable"));  // the play table shows cards large enough to read
  const [front, back] = preview.querySelectorAll("img");
  front.src = el.dataset.img;
  back.hidden = back.parentElement.hidden = !el.dataset.imgBack;  // double-faced: both sides side by side
  preview.classList.toggle("foil", !!el.dataset.foil);
  preview.dataset.foil = el.dataset.foil || "";
  if (el.dataset.imgBack) back.src = el.dataset.imgBack;
  preview.hidden = false;
});
document.addEventListener("mouseout", (e) => { if (e.target.closest(".card[data-img]")) preview.hidden = true; });
document.addEventListener("mousemove", (e) => {
  if (preview.hidden) return;
  const w = preview.offsetWidth + 20, h = preview.offsetHeight || 350;
  const x = e.clientX + w > window.innerWidth ? Math.max(8, e.clientX - w) : e.clientX + 20;
  const y = Math.min(e.clientY - 40, window.innerHeight - h - 8);
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
    `<figure class="card3d-wrap${copy?.foil ? " foil" : ""}"${copy?.foil ? ` data-foil="${esc(copy.foil_kind || "foil")}"` : ""}><div class="card3d" title="Ziehen zum Drehen, Doppelklick dreht um">
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

// escape a rules text, turning {G}-symbols into pills and glossary terms into buttons (explained in English on
// the card's English side)
function rulesHtml(text, terms, english = false) {
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
      out += `<button type="button" class="term" data-term="${esc(term)}" title="${esc((english ? entry?.text_en : entry?.text) || "")}">${esc(hit)}</button>`;
    }
    last = m.index + hit.length;
  }
  return out + esc(text.slice(last));
}

function renderCardText(data) {
  const german = cardLang === "de" && data.printed;
  const english = cardLang === "en";
  const faces = german ? data.printed.faces : data.faces;
  $("#card-view-rules").innerHTML = faces.map((f, i) => `<div class="face">
      <div class="head"><span>${esc(f.name)}</span><span>${(data.faces[i]?.mana_cost || "").match(/\{[^{}]{1,12}\}/g)?.map(manaHtml).join("") || ""}</span></div>
      <div class="type">${esc(f.type_line)}</div>
      ${f.text.split("\n").filter(Boolean).map((line) => `<p>${rulesHtml(line, data.terms, english)}</p>`).join("") || '<p class="muted small">Kein Regeltext.</p>'}
    </div>`).join("")
    + (data.pt && faces.length === 1 ? `<p class="pt">${esc(data.pt)}</p>` : "");
  const note = $("#card-view-note");
  if (cardLang !== "de") { note.hidden = true; note.textContent = ""; }
  else if (!data.printed) { note.hidden = false; note.textContent = "Keine deutsche Ausgabe – englischer Oracle-Text."; }
  else { note.hidden = false; note.textContent = `Drucktext${data.printed.set_name ? " aus " + data.printed.set_name : ""}. Maßgeblich ist der englische Oracle-Text.`; }
  $("#card-view-terms").hidden = !data.terms.length;
  $("#card-view-terms").lang = english ? "en" : "de";
  $("#card-view-terms-title").textContent = english ? "Terms on this card" : "Begriffe auf dieser Karte";
  $("#card-view-terms-list").innerHTML = data.terms.map((t) => english
    ? `<dt data-term="${esc(t.term)}">${esc(t.term)}</dt><dd data-term="${esc(t.term)}">${esc(t.text_en || t.text)}</dd>`
    : `<dt data-term="${esc(t.term)}">${esc(t.de || t.term)}${t.de ? ` <span class="de">(${esc(t.term)})</span>` : ""}</dt><dd data-term="${esc(t.term)}">${esc(t.text)}</dd>`).join("");
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
async function renameDeck() {
  if (!currentDeck) return;
  const deck = currentDeck;
  const name = await ask({ title: "Deck umbenennen", value: deck.name, ok: "Speichern" });
  if (!name || name === deck.name) return;
  try {
    await api(`/api/decks/${enc(deck.slug)}/name`, { method: "PUT", body: { name } });
    currentDeck = null;
    await refreshDeckList();
    await route();
    toast(`Deck heißt jetzt „${name}“.`, "ok");
  } catch (err) { fail(err); }
}
$("#rename-deck-btn").addEventListener("click", () => void renameDeck());
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
