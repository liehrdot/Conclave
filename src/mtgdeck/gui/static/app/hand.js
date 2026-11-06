"use strict";
// The desktop GUI, part 8 of 21: the Testen tab: test hand, its rating and the draw odds.
// index.html loads the parts in order; they share one global scope.

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
  renderHandGuide(r.guide || [], r.score != null);
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
// the short list to glance at during a real game (issue #99): the same marks the rating uses, ticked for the hand
function renderHandGuide(points, rated) {
  const box = $("#hand-guide");
  box.hidden = !points.length;
  if (!points.length) return;
  const met = points.filter((p) => p.ok).length;
  const mark = (p) => !rated ? "" : p.ok
    ? '<span class="hg-mark ok" aria-label="erfüllt">✓</span>' : '<span class="hg-mark bad" aria-label="fehlt">✗</span>';
  box.innerHTML = `
    <div class="hg-head"><h3>Worauf achten?</h3>
      <span class="muted small">${rated ? `Diese Hand: ${met} von ${points.length}` : "Für eine gute Starthand dieses Decks"}</span></div>
    <ul class="hg-list${rated ? " rated" : ""}">${points.map((p) => `
      <li class="${rated ? (p.ok ? "ok" : "bad") : ""}" title="${esc(p.detail)}">${mark(p)}<div><b>${esc(p.title)}</b><span class="muted small">${esc(p.detail)}</span></div></li>`).join("")}
    </ul>
    <p class="muted small hg-foot">Sofort Mulligan bei keinem oder einem Land ohne Ramp und bei fast nur Ländern. Der erste Mulligan ist frei.</p>`;
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
