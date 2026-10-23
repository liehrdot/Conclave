// A round's numbers, summary and log: shared by the Runden-Helfer (round.js) and the game sheets (forms.js).

import { shortName } from "./data.js";
import { redraw as redrawSheet, toast } from "./ui.js";
import { $, esc, icon, nowIso, plural } from "./util.js";

// ---------- the round's numbers, always derived from its log (so undo is just "drop the last entry") ----------
/** {life, poison, turn, cmd: {name: n}, from: {name: n}, out: [commander, …]} of a round (or a saved ``game.round``);
 *  ``out`` = the opponents that are out, first out first (by their commander). */
export function totals(round) {
  const t = { life: round.start_life, poison: 0, turn: 1, cmd: {}, from: {}, out: [] };
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
    else if (e.kind === "out" && e.from && !t.out.includes(e.from)) t.out.push(e.from);
  }
  t.poison = Math.max(0, t.poison);
  for (const k in t.cmd) t.cmd[k] = Math.max(0, t.cmd[k]);
  return t;
}

// ---------- summary and log – used live and for saved games ----------
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
  if (e.kind === "out") return `${shortName(e.from) || "Ein Gegner"} ist raus`;
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
          onNote?.();
          redrawSheet();
          toast("Notiz gespeichert", { ok: true });
        });
      },
    };
  };
}
