// Runden-Helfer: the user's own game state while a round runs – a big life total, commander damage per opposing
// commander, poison and the user's turns – and a log of everything that happened, turn by turn. It lives only on
// this phone (localStorage, saved on every tap) until the round ends: then the game sheet opens prefilled from it
// and the log goes along with the game (``game.round``), like any game entered by hand.

import { currentDeck, deckBy, oppBy, oppName, shortName, state } from "./data.js";
import { gameSheet, opponentPicker } from "./forms.js";
import * as scry from "./scry.js";
import { art, paint } from "./screens.js";
import { closeSheet, openSheet, redraw as redrawSheet, toast } from "./ui.js";
import { $, $$, esc, icon, load, nowIso, plural, save, uid, vibrate } from "./util.js";

const KEY = "amtisch.round";
const REMATCH_HOURS = 8;     // like the game sheet: the last game's opponents are offered again
const MERGE_MS = 4000;       // taps on the same counter within this time become one log entry ("−5", not five "−1")
const EVENTS_MAX = 400;      // like sync/appops.py
const OUT = { life: 0, poison: 10, cmd: 21 };
export const START_LIFE = [40, 30, 20];

let r = load(KEY, null);     // the running round, or null

const persist = () => save(KEY, r);
export const running = () => !!r && !!deckBy(r.deck);

// ---------- the round's numbers, always derived from its log (so undo is just "drop the last entry") ----------
/** {life, poison, turn, cmd: {name: n}, from: {name: n}} of a round (or a saved ``game.round``). */
export function totals(round) {
  const t = { life: round.start_life, poison: 0, turn: 1, cmd: {}, from: {} };
  for (const e of round.events || []) {
    if (e.kind === "life") {
      t.life += e.delta;
      if (e.from && e.delta < 0) t.from[e.from] = (t.from[e.from] || 0) - e.delta;
    } else if (e.kind === "cmd") {
      t.cmd[e.from] = (t.cmd[e.from] || 0) + e.delta;
      t.life -= e.delta;  // commander damage is damage: it costs life too
      t.from[e.from] = (t.from[e.from] || 0) + e.delta;
    } else if (e.kind === "poison") t.poison += e.delta;
    else if (e.kind === "turn") t.turn = e.turn;
  }
  t.poison = Math.max(0, t.poison);
  for (const k in t.cmd) t.cmd[k] = Math.max(0, t.cmd[k]);
  return t;
}

/** Why the user is out ({kind, from}), or null. */
export function outReason(round, t = totals(round)) {
  if (t.life <= OUT.life) return { kind: "life" };
  if (t.poison >= OUT.poison) return { kind: "poison" };
  const hit = Object.entries(t.cmd).find(([, n]) => n >= OUT.cmd);
  return hit ? { kind: "cmd", from: hit[0] } : null;
}

// the opposing commanders, each with its own commander damage (partners count separately)
function commanders(round) {
  return round.opps.flatMap((o, i) => {
    const known = o.id ? oppBy(o.id) : null;
    const names = known?.commanders?.length ? known.commanders : [o.commander];
    return names.filter(Boolean).map((name) => ({ name, opp: i, colors: o.colors || known?.colors || "" }));
  });
}
const oppLabel = (o) => (o.id && oppBy(o.id) ? oppName(oppBy(o.id)) : shortName(o.commander));

function log(kind, delta, from = null) {
  const t = totals(r);
  const last = r.events[r.events.length - 1];
  const now = Date.now();
  if (last && last.kind === kind && last.turn === t.turn && (last.from || null) === from && now - new Date(last.at).getTime() < MERGE_MS
      && Math.sign(last.delta) === Math.sign(delta)) {
    last.delta += delta;
    last.at = nowIso();
  } else {
    r.events.push({ turn: t.turn, kind, delta, ...(from ? { from } : {}), at: nowIso() });
    if (r.events.length > EVENTS_MAX) r.events.splice(1, r.events.length - EVENTS_MAX);
  }
  r.events[r.events.length - 1].life = totals(r).life;
  persist();
}

// ======================================================================================
// Start
// ======================================================================================
export function startSheet() {
  if (running()) { location.hash = "#/runde"; return; }
  const last = state.snap.games[0];
  const recent = last && Date.now() - new Date(last.played).getTime() < REMATCH_HOURS * 3600e3;
  const f = {
    deck: currentDeck()?.slug, life: state.prefs.roundLife || 40,
    opps: recent ? (last.opponent_ids || []).map((id, i) => ({ id, commander: last.opponents?.[i] || oppBy(id)?.commanders?.[0] || "" })).filter((o) => o.id || o.commander) : [],
    rematch: false,
  };
  f.rematch = f.opps.length > 0;
  const page = ({ push }) => ({
    title: "Runde starten",
    body: `
      <div class="field-label">Dein Deck</div>
      <div class="chips scroll" id="r-deck" role="radiogroup" aria-label="Dein Deck">${state.snap.decks.map((d) => `<button class="deckpill" type="button" role="radio" data-deck="${esc(d.slug)}" aria-pressed="${d.slug === f.deck}" aria-checked="${d.slug === f.deck}">
          <span class="art" data-bg="${esc(d.colors)}">${art(d.commanders[0])}</span><span class="label">${esc(d.name)}</span></button>`).join("")}</div>
      <div class="field-label">Gegner ${f.rematch ? `<span class="hint">wie die letzte Partie</span>` : `<span class="hint">für Commander-Schaden</span>`}</div>
      <div class="chips" id="r-opps">${f.opps.map((o, i) => `<span class="chip opp">${art(o.commander || oppBy(o.id)?.commanders?.[0] || "")}<span>${esc(oppLabel(o))}</span>
          <button class="x" type="button" data-remove="${i}" aria-label="${esc(oppLabel(o))} entfernen">${icon("x", "xs")}</button></span>`).join("")}
        <button class="chip add" type="button" id="r-add-opp">${icon("plus")}${f.opps.length ? "Gegner" : "Gegner hinzufügen"}</button></div>
      <div class="field-label">Startleben</div>
      <div class="segmented" role="radiogroup" aria-label="Startleben">${START_LIFE.map((n) => `<button type="button" role="radio" data-life="${n}" aria-pressed="${f.life === n}" aria-checked="${f.life === n}">${n}</button>`).join("")}</div>
      <p class="hint-small">Alles bleibt auf diesem Handy, bis du die Runde beendest – dann wird sie als Partie gespeichert.</p>`,
    foot: `<button class="btn primary big" type="button" id="r-go" ${f.deck ? "" : "disabled"}>Los geht's</button>`,
    bind(el) {
      scry.hydrate(el); paint(el);
      $(`#r-deck [aria-pressed="true"]`, el)?.scrollIntoView({ inline: "center", block: "nearest" });
      for (const b of $$("[data-deck]", el)) b.addEventListener("click", () => { f.deck = b.dataset.deck; redrawSheet(); });
      for (const b of $$("[data-life]", el)) b.addEventListener("click", () => { f.life = Number(b.dataset.life); redrawSheet(); });
      for (const b of $$("[data-remove]", el)) b.addEventListener("click", () => { f.opps.splice(Number(b.dataset.remove), 1); f.rematch = false; redrawSheet(); });
      $("#r-add-opp", el).addEventListener("click", () => push(opponentPicker(f, "Runde", () => { f.rematch = false; })));
      $("#r-go", el).addEventListener("click", () => {
        r = { id: uid(), deck: f.deck, start_life: f.life, started: nowIso(), opps: f.opps.map((o) => ({ id: o.id || null, commander: o.commander || oppBy(o.id)?.commanders?.[0] || "", colors: o.colors || "" })),
          events: [] };
        persist();
        import("./data.js").then((m) => { m.setPref("roundLife", f.life); m.setPref("deck", f.deck); });
        vibrate(18);
        closeSheet();
        setTimeout(() => { location.hash = "#/runde"; }, 60);
      });
    },
  });
  openSheet(page, { full: true });
}

// ======================================================================================
// The round screen (#/runde)
// ======================================================================================
export function roundScreen() {
  if (!running()) {
    return { html: `<div class="empty">${icon("clock")}<h3>Keine Runde läuft</h3><p>Starte eine auf dem Tisch-Tab.</p>
      <div class="btn-col"><a class="btn tint" href="#/tisch">Zum Tisch</a></div></div>`, bar: { title: "Runde", back: { href: "#/tisch", label: "Tisch" }, always: true } };
  }
  const d = deckBy(r.deck);
  const cmds = commanders(r);
  const html = `
    <div class="round" id="round">
      <div class="round-top">
        <a class="icon-btn filled" href="#/tisch" aria-label="Runde in den Hintergrund – sie läuft weiter">${icon("chev-l")}</a>
        <div class="round-title"><span class="kicker">${esc(d.name)}</span><span class="t" id="r-turn"></span></div>
        <button class="btn tint small" type="button" id="r-end">Beenden</button>
      </div>
      <div class="round-out" id="r-out" hidden></div>
      <section class="life-card" data-bg="${esc(d.colors)}">
        ${art(d.commanders[0])}
        <div class="life-inner">
          <button class="life-btn" type="button" data-life="-1" aria-label="Ein Leben weniger"><span>−</span></button>
          <div class="life-num" aria-live="polite"><output id="r-life"></output><span class="life-label">Leben</span><span class="life-delta" id="r-delta"></span></div>
          <button class="life-btn" type="button" data-life="1" aria-label="Ein Leben mehr"><span>+</span></button>
        </div>
        <div class="from-row" id="r-from" hidden>
        <span class="from-label">Schaden von</span>
        ${r.opps.map((o) => `<button class="from-chip" type="button" data-from="${esc(o.commander)}" aria-pressed="false">${art(o.commander || "", "art")}<span>${esc(oppLabel(o))}</span></button>`).join("")}
      </div>
      </section>

      <div class="field-label">Commander-Schaden <span class="hint">tippen = +1, kostet auch Leben</span></div>
      <div class="dmg-grid">
        ${cmds.map((c) => `<div class="dmg-tile" data-cmd-tile="${esc(c.name)}">
          <button class="dmg-main" type="button" data-cmd="${esc(c.name)}" aria-label="Commander-Schaden von ${esc(shortName(c.name))} plus eins">
            <span class="dmg-art" data-bg="${esc(c.colors)}">${art(c.name, "art")}</span>
            <span class="dmg-name">${esc(shortName(c.name))}</span>
            <span class="dmg-val"><b data-val></b><small>/21</small></span>
            <span class="dmg-bar"><span data-bar></span></span>
          </button>
          <button class="dmg-minus" type="button" data-cmd-minus="${esc(c.name)}" aria-label="Commander-Schaden von ${esc(shortName(c.name))} minus eins">−</button>
        </div>`).join("")}
        <div class="dmg-tile poison">
          <button class="dmg-main" type="button" data-poison="1" aria-label="Giftmarke plus eins">
            <span class="dmg-art poison-art">${icon("alert")}</span>
            <span class="dmg-name">Gift</span>
            <span class="dmg-val"><b data-val></b><small>/10</small></span>
            <span class="dmg-bar"><span data-bar></span></span>
          </button>
          <button class="dmg-minus" type="button" data-poison="-1" aria-label="Giftmarke minus eins">−</button>
        </div>
      </div>
      ${cmds.length ? "" : `<p class="hint-small">Ohne Gegner gibt es keinen Commander-Schaden – Gegner lassen sich beim Start wählen.</p>`}
      <div class="round-bar">
        <button class="icon-btn filled" type="button" id="r-undo" aria-label="Rückgängig">${icon("undo")}</button>
        <button class="btn primary big" type="button" id="r-next"></button>
        <button class="icon-btn filled" type="button" id="r-log" aria-label="Verlauf">${icon("clock")}</button>
      </div>
    </div>`;
  return { html, immersive: true, wake: true, bar: { title: "Runde" }, bind: bindRound };
}

let deltaTimer = null;
function update(el) {
  if (!r) return;
  const t = totals(r);
  $("#r-life", el).textContent = t.life;
  $("#r-turn", el).textContent = `Zug ${t.turn} · ${minutes(r.started)}`;
  $("#r-next", el).textContent = `Zug ${t.turn + 1} beginnt`;
  $("#r-undo", el).disabled = !r.events.some((x) => x.kind !== "note");
  $(".life-card", el).classList.toggle("low", t.life <= 10);
  for (const tile of $$("[data-cmd-tile]", el)) {
    const n = t.cmd[tile.dataset.cmdTile] || 0;
    $("[data-val]", tile).textContent = n;
    $("[data-bar]", tile).style.width = `${Math.min(100, (100 * n) / OUT.cmd)}%`;
    tile.classList.toggle("hot", n >= 15);
    $(".dmg-minus", tile).disabled = !n;
  }
  const p = $(".dmg-tile.poison", el);
  $("[data-val]", p).textContent = t.poison;
  $("[data-bar]", p).style.width = `${Math.min(100, (100 * t.poison) / OUT.poison)}%`;
  p.classList.toggle("hot", t.poison >= 7);
  $(".dmg-minus", p).disabled = !t.poison;
  // the latest life loss can be put on someone
  const last = r.events[r.events.length - 1];
  const from = $("#r-from", el);
  from.hidden = !(last && last.kind === "life" && last.delta < 0 && r.opps.length);
  for (const b of $$("[data-from]", from)) b.setAttribute("aria-pressed", String(!!last && last.from === b.dataset.from));
  // the running change, e.g. "−5"
  const delta = $("#r-delta", el);
  if (last && Date.now() - new Date(last.at).getTime() < MERGE_MS && (last.kind === "life" || last.kind === "cmd")) {
    const lifeDelta = last.kind === "cmd" ? -last.delta : last.delta;
    delta.textContent = lifeDelta > 0 ? `+${lifeDelta}` : `−${-lifeDelta}`;
    delta.className = `life-delta show ${lifeDelta > 0 ? "up" : "down"}`;
    clearTimeout(deltaTimer);
    deltaTimer = setTimeout(() => { delta.className = "life-delta"; }, 1600);
  }
  const out = outReason(r, t);
  const box = $("#r-out", el);
  box.hidden = !out;
  if (out) {
    const why = out.kind === "life" ? "Deine Leben sind auf 0" : out.kind === "poison" ? "10 Giftmarken" : `21 Commander-Schaden von ${shortName(out.from)}`;
    if (box.dataset.why !== why) {
      box.dataset.why = why;
      box.innerHTML = `<div class="main"><b>Du bist raus</b><span>${esc(why)}.</span></div>
        <button class="btn" type="button" data-out-undo>Rückgängig</button><button class="btn primary" type="button" data-out-save>Als Niederlage speichern</button>`;
      $("[data-out-undo]", box).addEventListener("click", () => undoLast(el));
      $("[data-out-save]", box).addEventListener("click", () => endRound("loss"));
      vibrate(40);
    }
  } else box.dataset.why = "";
}

const minutes = (iso) => { const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); return m < 60 ? `${m} Min.` : `${Math.floor(m / 60)} Std. ${m % 60} Min.`; };

// takes back the last change of a counter or the turn (notes stay)
function undoLast(el) {
  const i = r.events.findLastIndex((x) => x.kind !== "note");
  if (i < 0) return;
  const [e] = r.events.splice(i, 1);
  persist();
  update(el);
  toast(undoText(e));
}
const undoText = (e) => (e.kind === "turn" ? `Zurück in Zug ${e.turn - 1}` : `Zurückgenommen: ${eventText(e)}`);

// press = one step, holding repeats (faster after a moment)
function repeatable(btn, step) {
  let timer = null, n = 0;
  const stop = () => { clearTimeout(timer); timer = null; };
  btn.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    n = 0;
    step(); vibrate(8);
    const again = () => { n++; step(); timer = setTimeout(again, n > 8 ? 70 : 140); };
    timer = setTimeout(again, 420);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(ev, stop);
  btn.addEventListener("click", (e) => { if (e.detail === 0) step(); });  // keyboard
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
}

let ticker = null;
function bindRound(el) {
  clearInterval(ticker);
  ticker = setInterval(() => { if ($("#r-turn") && r) $("#r-turn").textContent = `Zug ${totals(r).turn} · ${minutes(r.started)}`; else clearInterval(ticker); }, 30000);
  for (const b of $$("[data-life]", el)) repeatable(b, () => { log("life", Number(b.dataset.life), keepFrom(Number(b.dataset.life))); update(el); });
  for (const b of $$("[data-cmd]", el)) repeatable(b, () => { log("cmd", 1, b.dataset.cmd); update(el); });
  for (const b of $$("[data-cmd-minus]", el)) b.addEventListener("click", () => { if (totals(r).cmd[b.dataset.cmdMinus]) { log("cmd", -1, b.dataset.cmdMinus); update(el); } });
  for (const b of $$("[data-poison]", el)) b.addEventListener("click", () => { const dlt = Number(b.dataset.poison); if (dlt > 0 || totals(r).poison) { log("poison", dlt); vibrate(8); update(el); } });
  for (const b of $$("[data-from]", el)) b.addEventListener("click", () => {
    const last = r.events[r.events.length - 1];
    if (!last || last.kind !== "life") return;
    if (last.from === b.dataset.from) delete last.from; else last.from = b.dataset.from;
    persist(); update(el);
  });
  $("#r-undo", el).addEventListener("click", () => undoLast(el));
  $("#r-next", el).addEventListener("click", () => {
    const t = totals(r);
    r.events.push({ turn: t.turn + 1, kind: "turn", delta: 1, life: t.life, at: nowIso() });
    persist(); vibrate(18); update(el);
    toast(`Zug ${t.turn + 1}`, { sub: turnRecap(t.turn) });
  });
  $("#r-log", el).addEventListener("click", () => openSheet(roundLogPage(r, "Verlauf", { live: true, onNote: () => update(el) }), { full: true }));
  $("#r-end", el).addEventListener("click", () => endRound(null));
  update(el);
}

// a life loss right after another one from the same opponent keeps that opponent
function keepFrom(delta) {
  const last = r.events[r.events.length - 1];
  return delta < 0 && last?.kind === "life" && last.delta < 0 && last.from && Date.now() - new Date(last.at).getTime() < MERGE_MS ? last.from : null;
}

// "Zug 3: −7 Leben, 1 Gift" – what the turn that just ended cost
function turnRecap(turn) {
  const ev = r.events.filter((e) => e.turn === turn && e.kind !== "turn");
  if (!ev.length) return "Ruhiger Zug – nichts passiert.";
  let life = 0, poison = 0, cmd = 0;
  for (const e of ev) { if (e.kind === "life") life += e.delta; else if (e.kind === "cmd") { cmd += e.delta; life -= e.delta; } else if (e.kind === "poison") poison += e.delta; }
  return `Zug ${turn}: ${[life ? `${life > 0 ? "+" : "−"}${Math.abs(life)} Leben` : "", cmd ? `${cmd} Commander-Schaden` : "", poison ? `${poison > 0 ? "+" : ""}${poison} Gift` : ""].filter(Boolean).join(", ") || "ausgeglichen"}`;
}

// ---------- end: the game sheet, prefilled; saving it ends the round ----------
function endRound(result) {
  const t = totals(r);
  const out = outReason(r, t);
  const how = out?.kind === "cmd" ? "commander" : null;
  const round = { start_life: r.start_life, started: r.started, ended: nowIso(), life: t.life, poison: t.poison, turns: t.turn,
    cmd: Object.entries(t.cmd).filter(([, n]) => n).map(([name, dmg]) => ({ name, dmg })), events: r.events };
  gameSheet({
    prefill: { id: r.id, deck: r.deck, result: result || (out ? "loss" : null), turn: t.turn <= 60 ? t.turn : null, how, opps: r.opps.map((o) => ({ ...o })) },
    round,
    onSaved: () => { r = null; persist(); location.hash = "#/tisch"; },
  });
}

export function discardRound() { r = null; persist(); }

// ======================================================================================
// Summary and log – used live and for saved games
// ======================================================================================
/** One group with the round's end state, for the game sheet and the game detail. */
export function roundSummary(round) {
  const cmd = (round.cmd || []).filter((c) => c.dmg).sort((a, b) => b.dmg - a.dmg);
  return `<div class="round-sum">
    <div class="rs-main"><b>${esc(round.life)}</b><span>Leben am Ende</span></div>
    <div class="rs-cell"><b>${esc(round.turns)}</b><span>${round.turns === 1 ? "Zug" : "Züge"}</span></div>
    <div class="rs-cell"><b>${esc(round.poison || 0)}</b><span>Gift</span></div>
    ${sparkline(round)}
    ${cmd.length ? `<div class="rs-cmd">${cmd.map((c) => `<span>${esc(shortName(c.name))} <b>${esc(c.dmg)}</b></span>`).join("")}</div>` : ""}
  </div>`;
}

// life at the end of each turn, as a small line (SVG attributes only – the CSP allows no inline styles)
function sparkline(round) {
  const turns = Math.max(1, round.turns || totals(round).turn);
  const pts = [round.start_life];
  let life = round.start_life;
  for (let n = 1; n <= turns; n++) {
    for (const e of round.events || []) if (e.turn === n) { if (e.kind === "life") life += e.delta; else if (e.kind === "cmd") life -= e.delta; }
    pts.push(life);
  }
  if (pts.length < 3) return "";
  const W = 300, H = 56, max = Math.max(round.start_life, ...pts), min = Math.min(0, ...pts);
  const xy = pts.map((v, i) => `${((i / (pts.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - min) / (max - min || 1)) * (H - 8)).toFixed(1)}`);
  return `<svg class="rs-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Leben pro Zug: ${pts.join(", ")}">
    <polyline points="${xy.join(" ")}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

export function eventText(e) {
  const from = e.from ? ` von ${shortName(e.from)}` : "";
  if (e.kind === "life") return `${e.delta > 0 ? "+" : "−"}${Math.abs(e.delta)} Leben${e.delta < 0 ? from : ""}`;
  if (e.kind === "cmd") return `${e.delta > 0 ? "" : "−"}${Math.abs(e.delta)} Commander-Schaden${from}`;
  if (e.kind === "poison") return `${e.delta > 0 ? "+" : "−"}${plural(Math.abs(e.delta), "Giftmarke", "Giftmarken")}`;
  if (e.kind === "note") return e.text || "";
  return "";
}

/** A sheet page with the round's log, turn by turn (newest first). ``live`` adds a note field for the current turn. */
export function roundLogPage(round, title, { live = false, onNote = null } = {}) {
  return ({ pop }) => {
    const t = totals(round);
    const turns = [];
    for (let n = t.turn; n >= 1; n--) {
      const ev = (round.events || []).filter((e) => e.turn === n && e.kind !== "turn");
      const lifeEnd = [...(round.events || [])].reverse().find((e) => e.turn <= n && typeof e.life === "number")?.life ?? round.start_life;
      turns.push({ n, ev, lifeEnd });
    }
    const page = !!pop && !live;  // pushed into another sheet (the game detail)
    return {
      title: live ? "Verlauf" : `Verlauf · ${title}`,
      left: page ? `<button class="back-btn" type="button" data-sheet-back>${icon("chev-l")}<span>Partie</span></button>` : `<button class="btn plain" type="button" data-sheet-close>Schließen</button>`,
      body: `
        ${live ? `<form class="note-add" id="r-note"><textarea class="textarea" name="text" rows="2" placeholder="Notiz zu Zug ${t.turn} – was ist passiert?" enterkeyhint="done"></textarea>
          <div class="btn-row-end"><button class="btn tint" type="submit">Notiz speichern</button></div></form>` : ""}
        ${turns.map(({ n, ev, lifeEnd }) => `<div class="cat-head"><span>Zug ${n}${live && n === t.turn ? " · läuft" : ""}</span><span>${esc(lifeEnd)} Leben</span></div>
          <div class="group">${ev.length ? [...ev].reverse().map((e) => `<div class="row log-row ${e.kind}${e.delta > 0 ? " gain" : ""}"><span class="log-dot" aria-hidden="true"></span>
            <span class="main"><span class="title wrap">${esc(eventText(e))}</span><span class="subtitle">${esc(new Date(e.at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }))}${typeof e.life === "number" && e.kind !== "note" ? ` · ${e.life} Leben` : ""}</span></span></div>`).join("")
            : `<div class="row"><span class="main"><span class="subtitle">Nichts passiert</span></span></div>`}</div>`).join("")}
        <p class="hint-small">Start mit ${esc(round.start_life)} Leben · ${esc(new Date(round.started).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" }))}</p>`,
      bind(el) {
        $("#r-note", el)?.addEventListener("submit", (e) => {
          e.preventDefault();
          const text = e.target.text.value.trim();
          if (!text) return;
          round.events.push({ turn: totals(round).turn, kind: "note", delta: 0, text: text.slice(0, 500), at: nowIso() });
          persist();
          onNote?.();
          redrawSheet();
          toast("Notiz gespeichert", { ok: true });
        });
      },
    };
  };
}

/** The card on the Tisch tab: start a round, or get back into the running one. */
export function roundCard() {
  if (!state.snap.decks.length) return "";
  if (!running()) {
    return `<button class="round-start" type="button" id="round-start">
      <span class="rs-icon" aria-hidden="true">${icon("heart")}</span>
      <span class="main"><span class="title">Runde starten</span><span class="subtitle">Leben, Commander-Schaden, Gift und Züge – am Ende als Partie gespeichert</span></span>
      ${icon("chev-r", "sm chev")}</button>`;
  }
  const t = totals(r);
  const d = deckBy(r.deck);
  return `<a class="round-live" href="#/runde">
    <span class="live-dot" aria-hidden="true"></span>
    <span class="main"><span class="title">Runde läuft · Zug ${t.turn}</span><span class="subtitle">${esc(d.name)} · ${esc(minutes(r.started))}</span></span>
    <span class="live-life"><b>${t.life}</b><small>Leben</small></span>${icon("chev-r", "sm chev")}</a>`;
}
