// Conclave – Spieltisch: goldfish a deck for a few real turns (Testen tab).
// Board state only: the user moves every card, no card does anything by itself and no rule is checked.
// Loaded after app.js and uses its globals ($, esc, enc, ask, toast, shuffle, isLand, currentDeck, CARD_BACK, showCardView).

const PT_TURNS = 7;                // the turns the bar counts; playing on is allowed
const PT_UNDO = 80;                // undo steps kept
const PT_ZONES = ["library", "hand", "main", "lands", "graveyard", "exile", "command"];
const PT_FIELD = ["main", "lands"];  // the battlefield's two rows
const PT_NAMES = { library: "Bibliothek", hand: "Hand", main: "Spielfeld", lands: "Spielfeld", graveyard: "Friedhof", exile: "Exil", command: "Kommandozone" };
// pt = { slug, data: card_data, seq, turn (0 = starting hand), life, mull, bottom, lands (played this turn),
//        casts: {commander: n}, zones: {zone: [{id, name, tapped, cmd, flipped, counters: {label: n}, token}]},
//        log: [[text]] per turn (0 = start), turns: {turn: {lands, mana, hand, drops}} at each turn's end,
//        drawn (cards drawn after keeping), cmdTurn (the commander's first turn on the field), kept: the hand rating's input,
//        summed (the summary after turn 7 was shown), estimate (the hand rating's answer, loaded once),
//        tokens: the deck's own tokens (loaded once), undo: [json] }
// a token carries its own picture and type line (`img`, `type`), since card_data only knows the deck's cards
let pt = null;

const ptCd = (c) => c.token ? { image: c.img, type_line: c.type } : pt.data[c.name] || {};
// the face that is up: the back of a double-faced card once it is turned over
const ptImage = (c) => (c.flipped && ptCd(c).image_back) || ptCd(c).image;
// the front face decides the row: „Sorcery // Land“ (modal double-faced) is played as a spell unless dropped on the land row
const ptFrontType = (c) => (ptCd(c).type_line || "").split(" // ")[0];
const ptCounters = ["+1/+1", "-1/-1", "Loyalität", "Ladung", "Gift"];  // quick picks; any other name works too
const ptIsLand = (c) => /\bLand\b/.test(ptFrontType(c));
const ptIsSpell = (c) => /\b(Instant|Sorcery)\b/.test(ptFrontType(c));
const ptField = () => PT_FIELD.flatMap((z) => pt.zones[z]);

function ptFind(id) {
  for (const z of PT_ZONES) {
    const i = pt.zones[z].findIndex((c) => c.id === id);
    if (i >= 0) return { zone: z, i, card: pt.zones[z][i] };
  }
  return null;
}

// ---------- state changes (each one is a single undo step) ----------
const PT_KEPT_STATE = ["turn", "life", "mull", "bottom", "lands", "casts", "seq", "zones", "log", "turns", "drawn", "cmdTurn", "kept", "summed"];
function ptSave() {
  pt.undo.push(JSON.stringify(Object.fromEntries(PT_KEPT_STATE.map((k) => [k, pt[k]]))));
  if (pt.undo.length > PT_UNDO) pt.undo.shift();
}
function ptUndo() {
  const last = pt?.undo.pop();
  if (!last) return;
  Object.assign(pt, JSON.parse(last));
  ptRender();
}

function ptNew(deck) {
  const data = deck.card_data || {};
  let seq = 0;
  const card = (name, cmd = false) => ({ id: ++seq, name, tapped: false, cmd });  // pt.seq goes on from here for tokens
  const library = shuffle(deck.cards.flatMap((c) => Array.from({ length: c.qty || 1 }, () => card(c.name))));
  pt = { slug: deck.slug, data, seq: 0, tokens: null, turn: 0, life: 40, mull: 0, bottom: 0, lands: 0, casts: {}, undo: [],
    log: [], turns: {}, drawn: 0, cmdTurn: null, kept: null, summed: false, estimate: null,
    zones: { library, hand: library.splice(0, 7), main: [], lands: [], graveyard: [], exile: [],
      command: (deck.commanders || []).map((n) => card(n, true)) } };
  pt.seq = seq;
  ptRender();
}

function ptMulligan() {
  if (pt.turn) return;
  ptSave();
  const z = pt.zones;
  z.library = shuffle([...z.library, ...z.hand]);
  z.hand = z.library.splice(0, 7);
  pt.mull += 1;
  pt.bottom = Math.max(0, pt.mull - 1);  // London mulligan, the first one is free in Commander
  ptRender();
}

function ptDraw(n = 1) {
  const z = pt.zones;
  if (!z.library.length) return toast("Die Bibliothek ist leer.", "error");
  ptSave();
  n = Math.min(n, z.library.length);
  z.hand.push(...z.library.splice(0, n));
  if (pt.turn) {
    pt.drawn += n;
    ptLog(n === 1 ? "1 Karte gezogen" : `${n} Karten gezogen`);
  }
  ptRender();
}

function ptNext() {
  if (!pt.turn) {  // keep the starting hand
    if (pt.bottom) return;
    ptSave();
    const onDraw = $("#pt-draw1").checked;
    pt.kept = { cards: pt.zones.hand.map((c) => c.name), mulligans: pt.mull, on_draw: onDraw };
    ptLog(pt.mull ? `Behalten nach ${pt.mull} Mulligan${pt.mull > 1 ? "s" : ""}: ${pt.zones.hand.length} Karten` : "Starthand behalten");
    pt.turn = 1;
    if (onDraw && pt.zones.library.length) {
      pt.zones.hand.push(pt.zones.library.shift());
      pt.drawn += 1;
    }
    return ptRender();
  }
  ptSave();
  pt.turns[pt.turn] = ptTurnStats();
  if (pt.turn === PT_TURNS && !pt.summed) {  // the end of turn 7: the summary first, „Weiterspielen“ goes on
    pt.summed = true;
    ptRender();
    return ptSummary();
  }
  pt.turn += 1;
  pt.lands = 0;
  for (const c of ptField()) c.tapped = false;
  if (pt.zones.library.length) {
    pt.zones.hand.push(pt.zones.library.shift());
    pt.drawn += 1;
  } else toast("Die Bibliothek ist leer – kein Zug.", "error");
  ptRender();
}

function ptUntapAll() {
  if (!ptField().some((c) => c.tapped)) return;
  ptSave();
  for (const c of ptField()) c.tapped = false;
  ptRender();
}

function ptTap(id) {
  const f = ptFind(id);
  if (!f || !PT_FIELD.includes(f.zone)) return;
  ptSave();
  f.card.tapped = !f.card.tapped;
  ptRender();
}

// moves a card. to: a zone, "field" (the row its type belongs to), "top"/"bottom" (library); index = position in a row
function ptMove(id, to, index = null) {
  const f = ptFind(id);
  if (!f) return;
  const c = f.card;
  if (to === "field") to = ptIsLand(c) ? "lands" : "main";
  let zone = to === "top" || to === "bottom" ? "library" : to;
  if (c.cmd && (zone === "graveyard" || zone === "exile")) zone = "command";  // a commander goes back to the command zone
  if (zone === f.zone && !PT_FIELD.includes(zone) && zone !== "library") return;  // inside the library: to its top or bottom
  ptSave();
  pt.zones[f.zone].splice(f.i, 1);
  ptLogMove(c, f.zone, zone);
  if (!PT_FIELD.includes(zone)) {  // leaving the battlefield: a fresh card again
    c.tapped = false;
    c.flipped = false;
    delete c.counters;
    if (c.token) return ptRender();  // a token ceases to exist
  }
  if (f.zone === "command" && PT_FIELD.includes(zone)) {
    pt.casts[c.name] = (pt.casts[c.name] || 0) + 1;
    if (pt.turn && pt.cmdTurn === null) pt.cmdTurn = pt.turn;
  }
  if (f.zone === "hand" && zone === "lands" && pt.turn) pt.lands += 1;
  const list = pt.zones[zone];
  if (to === "top") list.unshift(c);
  else if (index !== null && index >= 0 && index <= list.length) list.splice(index, 0, c);
  else list.push(c);
  ptRender();
}

// a click on a hand card: play it (lands to their row, instants and sorceries resolve into the graveyard)
function ptPlay(id) {
  const f = ptFind(id);
  if (!f) return;
  if (!pt.turn) {
    if (pt.bottom) {  // the cards a mulligan puts under the library
      ptSave();
      pt.zones.library.push(...pt.zones.hand.splice(f.i, 1));
      pt.bottom -= 1;
      ptRender();
    }
    return;
  }
  ptMove(id, ptIsSpell(f.card) ? "graveyard" : "field");
}

function ptFlip(id) {
  const f = ptFind(id);
  if (!f || !ptCd(f.card).image_back) return;
  ptSave();
  f.card.flipped = !f.card.flipped;
  ptRender();
}

// adds n counters of a kind (negative takes them off); +1/+1 and -1/-1 cancel each other out
function ptCounter(id, kind, n = 1) {
  const f = ptFind(id);
  if (!f || !PT_FIELD.includes(f.zone)) return;
  ptSave();
  const ctr = f.card.counters ||= {};
  const other = { "+1/+1": "-1/-1", "-1/-1": "+1/+1" }[kind];
  if (other && n > 0 && ctr[other]) {
    const cancel = Math.min(n, ctr[other]);
    ctr[other] -= cancel;
    n -= cancel;
    if (!ctr[other]) delete ctr[other];
  }
  ctr[kind] = (ctr[kind] || 0) + n;
  if (ctr[kind] <= 0) delete ctr[kind];
  if (!Object.keys(ctr).length) delete f.card.counters;
  ptRender();
}
async function ptCounterAsk(id) {
  const kind = await ask({ title: "Marke hinzufügen", text: `Welche Marke? Zum Beispiel ${ptCounters.join(", ")}.`, value: "Loyalität", ok: "Hinzufügen" });
  if (!kind) return;
  const n = await ask({ title: `${kind}-Marken`, text: "Wie viele?", value: "1", ok: "Hinzufügen" });
  const count = Math.max(1, Math.min(99, Math.round(Number(n) || 0)));
  if (n) ptCounter(id, kind.slice(0, 24), count);
}

// tokens onto the battlefield: {name, type_line, image}, qty copies
function ptMakeToken(t, qty = 1) {
  ptSave();
  ptLog(`${qty > 1 ? `${qty}× ` : ""}${t.name} (Token)`);
  for (let i = 0; i < qty; i++) {
    pt.zones[/\bLand\b/.test(t.type_line || "") ? "lands" : "main"].push({ id: ++pt.seq, name: t.name, token: true, img: t.image || "", type: t.type_line || "Token", tapped: false, cmd: false });
  }
  ptRender();
}
function ptCopy(id) {
  const f = ptFind(id);
  if (!f) return;
  ptMakeToken({ name: f.card.name, type_line: `Token ${ptFrontType(f.card)}`, image: ptImage(f.card) });
}

// the library's top: draw / mill n, or look at the top n
async function ptAskCount(title, text, value = "3") {
  const n = await ask({ title, text, value, ok: "OK" });
  return n ? Math.max(1, Math.min(pt.zones.library.length, Math.round(Number(n) || 0))) : 0;
}
async function ptMill() {
  const n = await ptAskCount("Karten fräsen", "Wie viele Karten oben von der Bibliothek in den Friedhof?");
  if (!n) return;
  ptSave();
  pt.zones.graveyard.push(...pt.zones.library.splice(0, n));
  ptLog(n === 1 ? "1 Karte gefräst" : `${n} Karten gefräst`);
  ptRender();
}
async function ptDrawMany() {
  const n = await ptAskCount("Karten ziehen", "Wie viele Karten?", "2");
  if (n) ptDraw(n);
}
async function ptLookTop() {
  const n = await ptAskCount("Oben ansehen", "Wie viele Karten oben von der Bibliothek? (Scry, Surveil, „schau dir die obersten … an“)");
  if (n) ptZoneView("library", pt.zones.library.slice(0, n).map((c) => c.id));
}

function ptShuffle() {
  ptSave();
  shuffle(pt.zones.library);
  ptRender();
  toast("Bibliothek gemischt.", "ok", 2000);
}

// ---------- turn log and summary ----------
const PT_FROM = { graveyard: "aus dem Friedhof", exile: "aus dem Exil", library: "aus der Bibliothek" };
function ptLog(text) {
  (pt.log[pt.turn] ||= []).push(text);
}
// a play is the bare name (as in the mockup), every other move says where the card went
function ptLogMove(c, from, to) {
  const field = (z) => PT_FIELD.includes(z);
  if (field(from) && field(to)) return;  // from one row to the other
  if (from === "library" && to === "library") return;
  if (field(to)) ptLog(from === "hand" ? c.name : from === "command" ? `${c.name} (Commander)` : `${c.name} ${PT_FROM[from] || ""}`.trim());
  else if (from === "hand" && to === "graveyard" && ptIsSpell(c)) ptLog(c.name);
  else if (pt.turn) ptLog(`${c.name} → ${PT_NAMES[to]}`);
}
// the board at the end of a turn; mana = lands plus what rocks and dorks add (card_data.taps_for)
function ptTurnStats() {
  const z = pt.zones;
  const rocks = z.main.reduce((n, c) => n + (pt.data[c.name]?.taps_for || 0), 0);
  return { lands: z.lands.length, mana: z.lands.length + rocks, hand: z.hand.length, drops: pt.lands };
}
// the turn so far for the summary, ended turns as recorded
const ptStatsOf = (t) => pt.turns[t] || (t === pt.turn ? ptTurnStats() : null);

function ptLogHtml() {
  const rows = [];
  for (let t = 0; t <= pt.turn; t++) {
    const items = pt.log[t] || [];
    if (!t && !items.length) continue;
    rows.push(`<li${t === pt.turn ? ' class="now"' : ""}><b>${t ? `Zug ${t}` : "Start"}</b>
      <span>${items.length ? items.map(esc).join(", ") : t === pt.turn ? "…" : "nichts gespielt"}</span></li>`);
  }
  return rows.join("") || `<li class="muted">Noch nichts passiert.</li>`;
}

// what the hand rating expected of the kept hand (its goldfish: a land each turn, then ramp and the cheapest spells)
async function ptEstimate() {
  if (!pt.kept) return null;
  const key = JSON.stringify(pt.kept);
  if (pt.estimate?.key !== key) {
    try {
      const r = await api(`/api/decks/${enc(pt.slug)}/hand`, { method: "POST", body: pt.kept });
      pt.estimate = { key, facts: r.facts || {} };
    } catch {
      return null;  // the summary works without it
    }
  }
  return pt.estimate.facts;
}

async function ptSummary() {
  if (!pt.turn) return;
  const turns = Array.from({ length: pt.turn }, (_, i) => i + 1);
  const stats = turns.map(ptStatsOf);
  const est = await ptEstimate();
  const guess = est?.mana_by_turn || [];
  const ended = turns.filter((t) => pt.turns[t]);
  const missed = ended.filter((t) => !pt.turns[t].drops);
  const at4 = ptStatsOf(4);
  const cmd = pt.cmdTurn ? `Zug ${pt.cmdTurn}` : "noch nicht";
  const facts = [
    ["Commander", cmd, est?.commander ? (est.commander_turn ? `Zug ${est.commander_turn}` : "nach Zug 6") : null],
    ["Mana in Zug 4", at4 ? fmtNum(at4.mana) : "–", guess[3] !== undefined ? fmtNum(guess[3]) : null],
    ["Landdrops", ended.length ? `${ended.length - missed.length} von ${ended.length}` : "–", null],
    ["Karten gezogen", fmtNum(pt.drawn), null],
    ["Leben", fmtNum(pt.life), null],
  ];
  $("#pt-sum-title").textContent = pt.turn <= PT_TURNS && pt.summed ? `${PT_TURNS} Züge mit ${currentDeck?.name || "dem Deck"}` : `Bis Zug ${pt.turn}`;
  $("#pt-sum-facts").innerHTML = facts.map(([k, v, g]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd>${g ? `<dd class="pt-guess">Schätzung: ${esc(g)}</dd>` : ""}</div>`).join("");
  $("#pt-sum-note").textContent = missed.length ? `Kein Land gespielt in Zug ${missed.join(", ")}.`
    : est ? "„Schätzung“ = was die Bewertung der Starthand deiner behaltenen Hand zugetraut hat (ein Land pro Zug, dann Ramp und die billigsten Karten)." : "";
  $("#pt-sum-rows").innerHTML = turns.map((t, i) => {
    const s = stats[i];
    return `<tr><th scope="row">${t}</th><td>${s ? s.lands : "–"}</td><td>${s ? s.mana : "–"}</td><td class="muted">${guess[i] ?? "–"}</td>
      <td>${s ? s.hand : "–"}</td><td class="pt-sum-plays">${esc((pt.log[t] || []).join(", ")) || '<span class="muted">nichts gespielt</span>'}</td></tr>`;
  }).join("");
  $("#pt-sum-go").textContent = pt.turn === PT_TURNS && pt.summed ? "Weiterspielen" : "Zurück zum Tisch";
  $("#pt-summary").showModal();
}

// ---------- drawing the table ----------
function ptCardHtml(c) {
  const cd = ptCd(c), shown = ptImage(c);
  const back = c.flipped ? cd.image : cd.image_back;  // the hover preview shows the other side second
  const img = shown ? `<img src="${esc(shown)}" alt="${esc(c.name)}" draggable="false" loading="lazy">` : `<span class="noimg">${esc(c.name)}</span>`;
  const ctr = Object.entries(c.counters || {});
  const badges = ctr.length ? `<span class="pt-ctrs">${ctr.map(([k, n]) => `<span class="pt-ctr">${k === "+1/+1" || k === "-1/-1" ? `${n > 1 ? `${n}× ` : ""}${esc(k)}` : `${esc(k)} ${n}`}</span>`).join("")}</span>` : "";
  const says = [c.tapped && "getappt", c.flipped && "Rückseite", c.token && "Token", ...ctr.map(([k, n]) => `${n} ${k}`)].filter(Boolean).join(", ");
  return `<button type="button" class="pt-card card${c.tapped ? " tapped" : ""}${c.token ? " token" : ""}" draggable="true" data-id="${c.id}"
    data-img="${esc(shown || "")}" data-img-back="${esc(back || "")}" data-name="${esc(c.name)}"
    aria-label="${esc(c.name)}${says ? ` (${esc(says)})` : ""}">${img}${badges}${c.token ? '<span class="pt-token-tag">Token</span>' : ""}</button>`;
}

function ptPile(zone) {
  const list = pt.zones[zone];
  const count = `<span class="pt-count">${list.length}</span>`;
  if (zone === "library") {
    return list.length ? `<button type="button" class="pt-card back" data-act="draw" title="Klick: Karte ziehen · Rechtsklick: mehr" aria-label="Bibliothek, ${list.length} Karten – Karte ziehen">
      <img src="${CARD_BACK}" alt="" draggable="false"></button>${count}` : `<span class="pt-empty">leer</span>`;
  }
  if (zone === "command") {
    return list.map((c) => {
      const tax = (pt.casts[c.name] || 0) * 2;
      return `<span class="pt-stack">${ptCardHtml(c)}${tax ? `<span class="pt-tax" title="Commander-Steuer">+${tax}</span>` : ""}</span>`;
    }).join("") || `<span class="pt-empty">leer</span>`;
  }
  if (!list.length) return `<span class="pt-empty">leer</span>`;
  return `<span class="pt-stack" data-act="view" title="Klick: alle ansehen">${ptCardHtml(list[list.length - 1])}</span>${count}`;
}

function ptRender() {
  if (!pt) return;
  preview.hidden = true;  // the card under the pointer is replaced; moving the mouse shows it again
  const z = pt.zones, start = !pt.turn;
  $("#pt-title").textContent = start ? (pt.mull ? `Starthand · ${pt.mull}. Mulligan` : "Starthand")
    : pt.turn <= PT_TURNS ? `Zug ${pt.turn} von ${PT_TURNS}` : `Zug ${pt.turn}`;
  $("#pt-dots").innerHTML = Array.from({ length: PT_TURNS }, (_, i) =>
    `<i class="${i + 1 < pt.turn ? "done" : i + 1 === pt.turn ? "now" : ""}"></i>`).join("");
  const onField = z.lands.length;
  const untapped = z.lands.filter((c) => !c.tapped).length;
  $("#pt-pills").innerHTML = start ? "" : [
    `<span class="pt-pill${pt.lands ? " ok" : ""}">${pt.lands ? (pt.lands > 1 ? `${pt.lands} Länder gespielt` : "Land gespielt") : "Noch kein Land"}</span>`,
    `<span class="pt-pill">Länder: ${onField}${onField ? ` · ${untapped} ungetappt` : ""}</span>`,
  ].join("");
  $("#pt-life").textContent = pt.life;
  $("#pt-mull").hidden = !start;
  const next = $("#pt-next");
  const last = pt.turn === PT_TURNS && !pt.summed;
  next.textContent = start ? "Behalten" : last ? "Auswertung ›" : "Nächster Zug ›";
  next.disabled = start && pt.bottom > 0;
  next.title = start ? "" : last ? `Beendet Zug ${PT_TURNS} und zeigt, wie die Züge gelaufen sind (N)` : "Enttappt alles und zieht eine Karte (N)";
  $("#pt-undo").disabled = !pt.undo.length;
  const hint = $("#pt-hint");
  hint.textContent = start
    ? pt.bottom ? `Leg noch ${pt.bottom} ${pt.bottom === 1 ? "Karte" : "Karten"} unter die Bibliothek – klick sie an.`
      : pt.mull === 1 ? "Der erste Mulligan ist in Commander frei: du behältst alle 7 Karten." : "Behalten oder Mulligan?"
    : pt.turn === 1 && !ptField().length ? "Klick eine Karte auf der Hand, um sie auszuspielen, oder zieh sie dorthin, wo sie hin soll. Rechtsklick zeigt alle Züge." : "";
  hint.hidden = !hint.textContent;
  for (const zone of ["library", "graveyard", "exile", "command"]) $(`#pt-${zone}`).innerHTML = ptPile(zone);
  $("#pt-main").innerHTML = z.main.map((c) => ptCardHtml(c)).join("");
  $("#pt-lands").innerHTML = z.lands.map((c) => ptCardHtml(c)).join("");
  $("#pt-hand").innerHTML = z.hand.map((c) => ptCardHtml(c)).join("");
  $("#pt-hand").classList.toggle("bottoming", start && pt.bottom > 0);
  $("#pt-hand-count").textContent = `· ${z.hand.length}`;
  const log = $("#pt-log");
  log.innerHTML = ptLogHtml();
  log.scrollTop = log.scrollHeight;  // the newest turn stays in view
  $("#pt-sum-open").disabled = !pt.turn;
}

// ---------- open and close ----------
async function ptOpen() {
  const d = currentDeck;
  if (!d) return;
  if (!pt || pt.slug !== d.slug) ptNew(d);
  else ptRender();
  $("#pt-draw1").checked = store.get("ptdraw1") !== "0";
  $("#playtable").showModal();
}
async function ptClose() {
  ptMenuClose();
  if (pt && pt.turn && !(await ask({ title: "Spieltisch schließen?", text: "Das Spiel bleibt liegen, bis du ein anderes Deck testest oder neu startest.", ok: "Schließen" }))) return;
  $("#playtable").close();
}
$("#pt-open").addEventListener("click", ptOpen);
$("#pt-close").addEventListener("click", ptClose);
$("#playtable").addEventListener("cancel", (e) => {  // Esc: close an open menu first
  e.preventDefault();
  if (!$("#pt-menu").hidden) return ptMenuClose();
  void ptClose();
});
$("#pt-next").addEventListener("click", () => ptNext());
$("#pt-mull").addEventListener("click", () => ptMulligan());
$("#pt-undo").addEventListener("click", () => ptUndo());
$("#pt-restart").addEventListener("click", async () => {
  if (pt.turn && !(await ask({ title: "Neu starten?", text: "Das Spiel wird abgeräumt, du ziehst eine neue Starthand.", ok: "Neu starten" }))) return;
  ptNew(currentDeck);
});
$("#pt-sum-open").addEventListener("click", () => ptSummary());
$("#pt-sum-close").addEventListener("click", () => $("#pt-summary").close());
$("#pt-sum-go").addEventListener("click", () => {
  $("#pt-summary").close();
  if (pt.turn === PT_TURNS && pt.summed) ptNext();  // on to turn 8
});
$("#pt-sum-restart").addEventListener("click", () => {
  $("#pt-summary").close();
  ptNew(currentDeck);
});
$("#pt-draw1").addEventListener("change", (e) => store.set("ptdraw1", e.target.checked ? "1" : "0"));
$$("[data-life]").forEach((b) => b.addEventListener("click", (e) => {
  ptSave();
  pt.life += Number(b.dataset.life) * (e.shiftKey ? 5 : 1);
  ptRender();
}));

// ---------- clicks ----------
$("#playtable").addEventListener("click", (e) => {
  if (!e.target.closest("#pt-menu")) ptMenuClose();
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "draw") return ptDraw();
  if (act === "view") return ptZoneView(e.target.closest(".pt-zone").dataset.zone);
  const el = e.target.closest(".pt-card[data-id]");
  if (!el) return;
  const id = Number(el.dataset.id), f = ptFind(id);
  if (!f) return;
  if (f.zone === "hand") ptPlay(id);
  else if (PT_FIELD.includes(f.zone)) ptTap(id);
  else if (f.zone === "command") ptMove(id, "field");
});
$("#playtable").addEventListener("dblclick", (e) => {
  const el = e.target.closest(".pt-card[data-id]");
  if (el && ptFind(Number(el.dataset.id))?.zone !== "hand") ptShow(Number(el.dataset.id));
});
function ptShow(id) {
  const f = ptFind(id);
  if (f) showCardView(f.card.name, ptCd(f.card), null, -1);
}

// ---------- context menu ----------
function ptMenuClose() {
  const m = $("#pt-menu");
  if (m.contains(document.activeElement)) document.activeElement.blur();  // or the next key would land in the hidden menu
  m.hidden = true;
}
function ptMenu(x, y, items) {
  const m = $("#pt-menu");
  m.innerHTML = items.map((it, i) => it === "-" ? "<hr>"
    : `<button type="button" role="menuitem" data-i="${i}">${esc(it.label)}${it.key ? `<kbd>${esc(it.key)}</kbd>` : ""}</button>`).join("");
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  m.onclick = (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    ptMenuClose();
    items[Number(b.dataset.i)].run();
  };
  m.querySelector("button")?.focus();
}
function ptCardMenu(id) {
  const f = ptFind(id), c = f.card, onField = PT_FIELD.includes(f.zone);
  const to = (zone) => () => ptMove(id, zone);
  const items = [];
  if (f.zone === "hand") items.push({ label: ptIsSpell(c) ? "Wirken (in den Friedhof)" : "Ausspielen", run: () => ptPlay(id) });
  if (f.zone === "command") items.push({ label: "Wirken", run: to("field") });
  if (onField) {
    items.push({ label: c.tapped ? "Enttappen" : "Tappen", key: "Klick", run: () => ptTap(id) },
      { label: "+1/+1-Marke", key: "+", run: () => ptCounter(id, "+1/+1") },
      { label: "−1/−1-Marke", key: "−", run: () => ptCounter(id, "-1/-1") },
      { label: "Andere Marke …", run: () => ptCounterAsk(id) });
    for (const k of Object.keys(c.counters || {})) items.push({ label: `Eine ${k}-Marke weg`, run: () => ptCounter(id, k, -1) });
    items.push({ label: "Kopie als Token", key: "K", run: () => ptCopy(id) });
  }
  if (ptCd(c).image_back && f.zone !== "library") items.push({ label: c.flipped ? "Vorderseite zeigen" : "Umdrehen (Rückseite)", key: "F", run: () => ptFlip(id) });
  if (!onField && f.zone !== "command" && f.zone !== "hand") items.push({ label: "Aufs Spielfeld", run: to("field") });
  if (f.zone === "hand" && ptIsLand(c) === false && /\bLand\b/.test(ptCd(c).type_line || "")) items.push({ label: "Als Land spielen (Rückseite)", run: to("lands") });
  items.push("-");
  if (f.zone !== "graveyard") items.push({ label: onField ? "Opfern / In den Friedhof" : f.zone === "hand" ? "Abwerfen" : "In den Friedhof", key: "S", run: to("graveyard") });
  if (f.zone !== "exile") items.push({ label: "Ins Exil", key: "E", run: to("exile") });
  if (f.zone !== "hand") items.push({ label: "Auf die Hand", key: "H", run: to("hand") });
  items.push({ label: "Oben auf die Bibliothek", run: to("top") }, { label: "Unter die Bibliothek", run: to("bottom") });
  if (c.cmd && f.zone !== "command") items.push({ label: "In die Kommandozone", run: to("command") });
  items.push("-", { label: "Karte ansehen", key: "Doppelklick", run: () => ptShow(id) });
  return items;
}
function ptLibraryMenu() {
  const n = pt.zones.library.length;
  return [
    { label: "Karte ziehen", key: "D", run: () => ptDraw() },
    { label: "Mehrere Karten ziehen …", run: () => ptDrawMany() },
    { label: "Oben ansehen …", key: "L", run: () => ptLookTop() },
    { label: "Karten fräsen …", run: () => ptMill() },
    { label: "Bibliothek durchsuchen …", run: () => ptZoneView("library") },
    { label: "Mischen", run: () => ptShuffle() },
  ].filter(() => n);
}
$("#playtable").addEventListener("contextmenu", (e) => {
  const el = e.target.closest(".pt-card[data-id]");
  const zone = e.target.closest(".pt-zone")?.dataset.zone;
  let items = null;
  if (el) items = ptCardMenu(Number(el.dataset.id));
  else if (zone === "library") items = ptLibraryMenu();
  else if (zone === "graveyard" || zone === "exile") items = pt.zones[zone].length ? [{ label: `${PT_NAMES[zone]} ansehen`, run: () => ptZoneView(zone) }] : null;
  else if (zone === "battlefield") items = [{ label: "Token erzeugen …", key: "T", run: () => ptTokenView() }, { label: "Alles enttappen", key: "U", run: () => ptUntapAll() }];
  if (!items?.length) return;
  e.preventDefault();
  preview.hidden = true;
  ptMenu(e.clientX, e.clientY, items);
});

// ---------- drag and drop between zones ----------
let ptDragId = null;
$("#playtable").addEventListener("dragstart", (e) => {
  const el = e.target.closest(".pt-card[data-id]");
  if (!el) return;
  ptDragId = Number(el.dataset.id);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", el.dataset.name);
  preview.hidden = true;
  ptMenuClose();
});
$("#playtable").addEventListener("dragend", () => {
  ptDragId = null;
  $$("#playtable .drop").forEach((x) => x.classList.remove("drop"));
});
$("#playtable").addEventListener("dragover", (e) => {
  if (ptDragId === null) return;
  const zone = e.target.closest(".pt-zone");
  if (!zone) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  $$("#playtable .drop").forEach((x) => x !== zone && x.classList.remove("drop"));
  zone.classList.add("drop");
});
$("#playtable").addEventListener("dragleave", (e) => {
  const zone = e.target.closest(".pt-zone");
  if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove("drop");
});
$("#playtable").addEventListener("drop", (e) => {
  const zoneEl = e.target.closest(".pt-zone");
  if (ptDragId === null || !zoneEl) return;
  e.preventDefault();
  e.stopPropagation();  // not a card drop from scryfall.com
  zoneEl.classList.remove("drop");
  const id = ptDragId;
  ptDragId = null;
  const zone = zoneEl.dataset.zone;
  if (zone === "battlefield" || zone === "hand") {
    // the position among the cards of the row: before the first card whose middle is right of the pointer
    const row = zone === "hand" ? $("#pt-hand") : zoneEl;
    const others = [...row.querySelectorAll(".pt-card[data-id]")].filter((x) => Number(x.dataset.id) !== id);
    let index = others.findIndex((x) => { const r = x.getBoundingClientRect(); return e.clientY < r.bottom && e.clientX < r.left + r.width / 2; });
    if (index < 0) index = others.length;
    const target = zone === "hand" ? "hand" : zoneEl.dataset.row;
    const f = ptFind(id);
    if (f.zone === target) {  // reorder inside the row
      ptSave();
      pt.zones[target].splice(f.i, 1);
      pt.zones[target].splice(index, 0, f.card);
      return ptRender();
    }
    return ptMove(id, target, index);
  }
  ptMove(id, zone === "library" ? "top" : zone);
});

// ---------- keyboard ----------
// the card under the pointer gets the card keys (S, E, H, F, K, + and −); a re-render replaces it, so look it up by id
let ptHover = null;
$("#playtable").addEventListener("mouseover", (e) => { ptHover = e.target.closest(".pt-card[data-id]"); });
$("#playtable").addEventListener("mouseleave", () => { ptHover = null; });
// on the document: after a drag the focus can sit outside the dialog
const ptOnTop = () => $("#playtable").open && $$("dialog[open]").every((d) => d.id === "playtable");
document.addEventListener("keydown", (e) => {
  if (!pt || !ptOnTop() || isTyping(e) || e.target.closest?.("#pt-menu")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); return ptUndo(); }
  if (mod || e.altKey) return;
  const k = e.key.toLowerCase();
  const card = Number((document.activeElement?.closest?.(".pt-card[data-id]") || ptHover)?.dataset.id) || null;
  const onCard = { s: "graveyard", e: "exile", h: "hand" }[k];
  if (k === "d" && pt.turn) { e.preventDefault(); ptDraw(); }
  else if (k === "n") { e.preventDefault(); ptNext(); }
  else if (k === "u") { e.preventDefault(); ptUntapAll(); }
  else if (k === "t" && pt.turn) { e.preventDefault(); void ptTokenView(); }
  else if (k === "l" && pt.turn) { e.preventDefault(); void ptLookTop(); }
  else if (card && onCard) { e.preventDefault(); preview.hidden = true; ptHover = null; ptMove(card, onCard); }
  else if (card && k === "f") { e.preventDefault(); ptFlip(card); }
  else if (card && k === "k") { e.preventDefault(); ptCopy(card); }
  else if (card && (e.key === "+" || e.key === "-")) { e.preventDefault(); ptCounter(card, e.key === "+" ? "+1/+1" : "-1/-1"); }
  else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
    const el = document.activeElement?.closest?.(".pt-card[data-id]");
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    ptMenu(r.left + 8, r.bottom - 8, ptCardMenu(Number(el.dataset.id)));
  }
});
$("#pt-menu").addEventListener("keydown", (e) => {
  if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
  e.preventDefault();
  const items = [...$("#pt-menu").querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
});

// ---------- a zone as a list: graveyard, exile, searching the library, or its top cards ----------
let ptViewZone = null, ptViewTop = null;  // ptViewTop = the ids of the top cards being looked at (no shuffle afterwards)
function ptZoneView(zone, top = null) {
  ptViewZone = zone;
  ptViewTop = top;
  $("#pt-zv-title").textContent = top ? `Die obersten ${top.length} Karten` : zone === "library" ? "Bibliothek durchsuchen" : PT_NAMES[zone];
  $("#pt-zv-note").textContent = top ? "Von oben nach unten. „Nach oben“ legt eine Karte ganz nach oben, „Unten“ unter die Bibliothek."
    : zone === "library" ? "Alphabetisch, damit du nicht die Reihenfolge siehst. Beim Schließen wird gemischt." : "";
  $("#pt-zv-q").value = "";
  $("#pt-zv-q").hidden = !!top;
  ptZoneViewRender();
  $("#pt-zone-view").showModal();
  $("#pt-zv-q").focus();
}
function ptZoneViewRender() {
  const zone = ptViewZone, q = $("#pt-zv-q").value.trim().toLowerCase();
  let list = [...pt.zones[zone]];
  if (ptViewTop) list = list.filter((c) => ptViewTop.includes(c.id));  // library order = top first
  else if (zone === "library") {  // one row per card name: 30 Forests are one row
    const byName = new Map();
    for (const c of list) byName.set(c.name, [...(byName.get(c.name) || []), c]);
    list = [...byName.values()].map((same) => ({ ...same[0], n: same.length })).sort((a, b) => a.name.localeCompare(b.name));
  } else list.reverse();  // the newest card first
  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q) || (ptCd(c).type_line || "").toLowerCase().includes(q));
  const moves = ptViewTop ? [["top", "Nach oben"], ["bottom", "Unten"], ["hand", "Hand"], ["field", "Spielfeld"], ["graveyard", "Friedhof"], ["exile", "Exil"]]
    : [["hand", "Hand"], ["field", "Spielfeld"], ["graveyard", "Friedhof"], ["exile", "Exil"], ["top", "Oben"]].filter(([to]) => to !== zone);
  $("#pt-zv-list").innerHTML = list.map((c) => {
    const cd = ptCd(c), img = ptImage(c);
    return `<div class="pt-zv-row">
      <span class="thumb card" data-img="${esc(img || "")}" data-img-back="${esc(cd.image_back || "")}" data-name="${esc(c.name)}">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ""}</span>
      <span class="pt-zv-name"><span>${c.n > 1 ? `${c.n}× ` : ""}${esc(c.name)}</span><span class="muted small">${esc(cd.type_line || "")}</span></span>
      <span class="pt-zv-moves">${moves.map(([to, label]) => `<button type="button" class="btn small" data-move="${to}" data-id="${c.id}">${label}</button>`).join("")}</span>
    </div>`;
  }).join("") || `<p class="muted small">${q ? "Keine Karte passt." : "Hier liegt nichts."}</p>`;
}
$("#pt-zv-q").addEventListener("input", ptZoneViewRender);
$("#pt-zv-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-move]");
  if (!b) return;
  const id = Number(b.dataset.id);
  ptMove(id, b.dataset.move);
  if (ptViewTop && b.dataset.move !== "top") ptViewTop = ptViewTop.filter((x) => x !== id);
  if (!pt.zones[ptViewZone].length || ptViewTop?.length === 0) return $("#pt-zone-view").close();
  ptZoneViewRender();
});
$("#pt-zv-close").addEventListener("click", () => $("#pt-zone-view").close());
$("#pt-zone-view").addEventListener("close", () => {
  if (ptViewZone === "library" && !ptViewTop && pt.zones.library.length) {  // a search shuffles the library afterwards
    shuffle(pt.zones.library);
    toast("Bibliothek gemischt.", "ok", 2000);
  }
  ptViewZone = ptViewTop = null;
  preview.hidden = true;
});

// ---------- tokens: the deck's own ones first, any other by name ----------
async function ptTokenView() {
  $("#pt-tok-q").value = "";
  $("#pt-tok-found").innerHTML = "";
  $("#pt-tokens").showModal();
  const box = $("#pt-tok-deck");
  if (!pt.tokens) {
    box.innerHTML = `<p class="muted small">Lade die Tokens des Decks …</p>`;
    try { pt.tokens = await api(`/api/decks/${enc(pt.slug)}/tokens`); } catch (err) { box.innerHTML = `<p class="muted small">${esc(err.message)}</p>`; return; }
  }
  box.innerHTML = ptTokenList(pt.tokens, "Dieses Deck erzeugt keine bekannten Tokens – such unten nach einem.");
}
function ptTokenList(list, empty, attr = "tok") {
  return list.length ? `<div class="pt-tok-grid">${list.map((t, i) => `<button type="button" class="pt-tok card" data-${attr}="${i}" data-img="${esc(t.image || "")}" data-name="${esc(t.name)}"
      title="${esc(t.type_line || "")}${t.from?.length ? ` – von ${esc(t.from.join(", "))}` : ""}">${t.image ? `<img src="${esc(t.image)}" alt="" loading="lazy">` : `<span class="noimg">${esc(t.name)}</span>`}<span>${esc(t.name)}</span></button>`).join("")}</div>`
    : `<p class="muted small">${empty}</p>`;
}
const ptTokenSearch = debounce(async () => {
  const q = $("#pt-tok-q").value.trim();
  if (q.length < 2) return void ($("#pt-tok-found").innerHTML = "");
  try {
    const found = await api(`/api/tokens/search?q=${enc(q)}`);
    if ($("#pt-tok-q").value.trim() !== q) return;
    ptFound = found.slice(0, 24);
    $("#pt-tok-found").innerHTML = ptTokenList(ptFound, "Kein Token mit diesem Namen.", "found");
  } catch (err) { $("#pt-tok-found").innerHTML = `<p class="muted small">${esc(err.message)}</p>`; }
}, 300);
let ptFound = [];
$("#pt-tok-q").addEventListener("input", ptTokenSearch);
$("#pt-tokens").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tok], [data-found]");
  if (!b) return;
  const t = b.dataset.tok !== undefined ? (pt.tokens || [])[Number(b.dataset.tok)] : ptFound[Number(b.dataset.found)];
  if (!t) return;
  const qty = Math.max(1, Math.min(30, Math.round(Number($("#pt-tok-qty").value) || 1)));
  $("#pt-tokens").close();
  ptMakeToken(t, qty);
  toast(`${qty}× ${t.name} aufs Spielfeld gelegt.`, "ok", 2500);
});
$("#pt-tok-close").addEventListener("click", () => $("#pt-tokens").close());
$("#pt-tokens").addEventListener("close", () => { preview.hidden = true; });
