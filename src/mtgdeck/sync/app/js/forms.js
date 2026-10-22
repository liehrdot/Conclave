// Sheets for input and quick looks: log a game (with the opponent picker as a second page), record an opponent
// deck, switch tonight's deck, look at a card, a game, the settings.

import { currentDeck, deckBy, disconnect, dropOp, endDemo, failedOps, gamesOf, isDemo, op, oppBy, oppName, pendingCount, resetDemo, serverCall, setPref, shortName, state, undo, wake } from "./data.js";
import * as scry from "./scry.js";
import { roundLogPage, roundSummary } from "./round.js";
import { art, paint, rememberCard } from "./screens.js";
import { closeSheet, openSheet, popPage, pushPage, redraw, toast } from "./ui.js";
import { $, $$, RESULT_TEXT, ago, dateLong, debounce, esc, genitive, icon, load, mana, pips, plural, rulesText, save, uid, vibrate } from "./util.js";

const KEY_DRAFT = "amtisch.draft.game";
const REMATCH_HOURS = 8;  // within this time the last game's opponents are taken over

// ======================================================================================
// Partie eintragen
// ======================================================================================
let g = null;  // the form state while the sheet is open

function freshGame() {
  const last = state.snap.games[0];
  const deck = currentDeck();
  const recent = last && Date.now() - new Date(last.played).getTime() < REMATCH_HOURS * 3600e3;
  const opps = recent ? (last.opponent_ids || []).map((id, i) => ({ id, commander: last.opponents?.[i] || oppBy(id)?.commanders?.[0] || "" })).filter((o) => o.id || o.commander) : [];
  return { id: uid(), deck: deck?.slug, result: null, opps, rematch: recent && opps.length > 0, issues: [], turn: null, how: null, started: null, mvp: "", note: "" };
}

/** The game sheet. ``fromRound`` = a finished round of the Runden-Helfer: the form comes prefilled from it, the
 *  round's log goes along with the game, and ``fromRound.onSaved`` runs once the game is saved. */
export function gameSheet(fromRound = null) {
  const draft = fromRound ? null : load(KEY_DRAFT, null);
  const restored = !!(draft && state.snap.decks.some((d) => d.slug === draft.deck));
  g = fromRound ? { ...freshGame(), ...fromRound.prefill, round: fromRound.round, rematch: false } : restored ? draft : freshGame();
  g.restored = restored;
  openSheet(gamePage, { full: true, onClose: () => {
    if (g?.round) { if (g.saved) fromRound.onSaved?.(); }
    else if (g) save(KEY_DRAFT, g.saved ? null : g);
    g = null;
  } });
}
const keep = () => { if (g && !g.round) save(KEY_DRAFT, g); };

// reasons for a loss: the ones that happen to you most first, then a sensible default order
const ISSUE_ORDER = ["combo", "few_lands", "slow", "no_removal", "wiped", "no_draw", "commander_removed", "flood", "colors", "no_win", "fliers", "too_strong"];
function sortedIssues() {
  const count = {};
  for (const x of state.snap.games) for (const k of x.issues || []) count[k] = (count[k] || 0) + 1;
  const rank = (k) => (ISSUE_ORDER.indexOf(k) + 1 || 99);
  return [...state.snap.options.issues].sort((a, b) => (count[b[0]] || 0) - (count[a[0]] || 0) || rank(a[0]) - rank(b[0]));
}

function gamePage({ push }) {
  const decks = state.snap.decks;
  const issues = sortedIssues();
  const deck = deckBy(g.deck);
  const detailsOpen = !!state.prefs.detailsOpen;
  const howLabel = Object.fromEntries(state.snap.options.how);
  const summary = [g.turn ? `Zug ${g.turn}` : "", g.how ? howLabel[g.how] : "", g.mvp ? g.mvp : "", g.note ? "Notiz" : ""].filter(Boolean).join(" · ");
  const label = g.result ? `${RESULT_TEXT[g.result]} speichern` : "Speichern";
  const startedOpts = [["me", "Ich"], ...g.opps.map((o, i) => [String(i), shortName(o.commander || oppName(oppBy(o.id)))])];
  return {
    title: "Partie",
    body: `
      ${g.round ? roundSummary(g.round) : ""}
      ${g.restored ? `<div class="draft-note">${icon("note", "xs")} Entwurf wiederhergestellt<button class="btn" type="button" id="draft-drop">Verwerfen</button></div>` : ""}
      <div class="field-label">Dein Deck</div>
      <div class="chips scroll" id="deck-pick" role="radiogroup" aria-label="Dein Deck">${decks.map((d) => `<button class="deckpill" type="button" role="radio" data-deck="${esc(d.slug)}" aria-pressed="${d.slug === g.deck}" aria-checked="${d.slug === g.deck}">
          <span class="art" data-bg="${esc(d.colors)}">${art(d.commanders[0])}</span><span class="label">${esc(d.name)}</span></button>`).join("")}</div>
      <div class="field-label">Ergebnis</div>
      <div class="segmented result" role="radiogroup" aria-label="Ergebnis">${["win", "loss", "draw"].map((r) => `<button type="button" role="radio" data-v="${r}" aria-pressed="${g.result === r}" aria-checked="${g.result === r}">${RESULT_TEXT[r]}</button>`).join("")}</div>
      <div class="field-label">Gegner ${g.rematch ? `<span class="hint">wie die letzte Partie</span>` : `<span class="hint">optional</span>`}</div>
      <div class="chips" id="opp-chips">${g.opps.map((o, i) => {
        const known = o.id ? oppBy(o.id) : null;
        const name = known ? oppName(known) : shortName(o.commander);
        return `<span class="chip opp" data-i="${i}">${art(o.commander || known?.commanders?.[0] || "")}<span>${esc(name)}</span>
          <button class="x" type="button" data-remove="${i}" aria-label="${esc(name)} entfernen">${icon("x", "xs")}</button></span>`;
      }).join("")}<button class="chip add" type="button" id="add-opp">${icon("plus")}${g.opps.length ? "Gegner" : "Gegner hinzufügen"}</button></div>
      ${g.result === "loss" || g.result === "draw" ? `
        <div class="field-label">Woran lag's? <span class="hint">optional</span></div>
        <div class="chips" id="issues">${issues.slice(0, g.allIssues ? issues.length : 6).map(([k, l]) => `<button class="chip" type="button" data-issue="${k}" aria-pressed="${g.issues.includes(k)}">${esc(l)}</button>`).join("")}
          ${g.allIssues ? "" : `<button class="chip add" type="button" id="more-issues">mehr …</button>`}</div>` : ""}
      <button class="disclose" type="button" id="details-toggle" aria-expanded="${detailsOpen}" aria-controls="details">${icon("chev-r", "sm")}Mehr Details${!detailsOpen && summary ? `<span class="summary">${esc(summary)}</span>` : ""}</button>
      <div id="details" ${detailsOpen ? "" : "hidden"}>
        <div class="field-label">Zug <span class="hint">in dem die Partie endete</span></div>
        <div class="chips scroll" id="turns">${Array.from({ length: 18 }, (_, i) => i + 3).map((n) => `<button class="chip" type="button" data-turn="${n}" aria-pressed="${g.turn === n}">${n}</button>`).join("")}</div>
        <div class="field-label">Wie entschieden?</div>
        <div class="chips" id="how">${state.snap.options.how.map(([k, l]) => `<button class="chip" type="button" data-how="${k}" aria-pressed="${g.how === k}">${esc(l)}</button>`).join("")}</div>
        <div class="field-label">Wer hat angefangen?</div>
        <div class="chips" id="started">${startedOpts.map(([k, l]) => `<button class="chip" type="button" data-started="${k}" aria-pressed="${g.started === k}">${esc(l)}</button>`).join("")}</div>
        <div class="field-label">Beste Karte</div>
        <input class="input" id="mvp" value="${esc(g.mvp)}" placeholder="Karte aus ${esc(deck?.name || "deinem Deck")}" autocomplete="off" autocapitalize="off" enterkeyhint="done">
        <div class="chips" id="mvp-hits"></div>
        <div class="field-label">Notiz</div>
        <textarea class="textarea" id="note" placeholder="Was war besonders?" enterkeyhint="done">${esc(g.note)}</textarea>
      </div>`,
    foot: `<button class="btn primary big" type="button" id="save-game" ${g.result ? "" : "disabled"}>${esc(label)}</button>
      ${g.result ? "" : `<p class="hint-small center">Wähle das Ergebnis – der Rest ist optional.</p>`}`,
    bind(el) {
      scry.hydrate(el); paint(el);
      const sel = $(`#deck-pick [aria-pressed="true"]`, el);
      sel?.scrollIntoView({ inline: "center", block: "nearest" });
      $("#draft-drop", el)?.addEventListener("click", () => { g = freshGame(); save(KEY_DRAFT, null); redraw(); });
      for (const b of $$("[data-deck]", el)) b.addEventListener("click", () => { g.deck = b.dataset.deck; g.mvp = ""; keep(); redraw(); });
      for (const b of $$("[data-v]", el)) b.addEventListener("click", () => { g.result = b.dataset.v; vibrate(); keep(); redraw(); });
      for (const b of $$("[data-remove]", el)) b.addEventListener("click", () => {
        g.opps.splice(Number(b.dataset.remove), 1); g.rematch = false; g.started = null; keep(); redraw();
      });
      $("#add-opp", el).addEventListener("click", () => push(opponentPicker(g, "Partie", () => { g.rematch = false; g.started = null; keep(); })));
      $("#more-issues", el)?.addEventListener("click", () => { g.allIssues = true; redraw(); });
      for (const b of $$("[data-issue]", el)) b.addEventListener("click", () => toggleIn(g.issues, b.dataset.issue, b));
      $("#details-toggle", el).addEventListener("click", () => { setPref("detailsOpen", !state.prefs.detailsOpen); redraw(); });
      for (const b of $$("[data-turn]", el)) b.addEventListener("click", () => { g.turn = g.turn === Number(b.dataset.turn) ? null : Number(b.dataset.turn); keep(); single(el, "data-turn", g.turn); });
      for (const b of $$("[data-how]", el)) b.addEventListener("click", () => { g.how = g.how === b.dataset.how ? null : b.dataset.how; keep(); single(el, "data-how", g.how); });
      for (const b of $$("[data-started]", el)) b.addEventListener("click", () => { g.started = g.started === b.dataset.started ? null : b.dataset.started; keep(); single(el, "data-started", g.started); });
      const turnSel = $("#turns [aria-pressed=true]", el) || $(`#turns [data-turn="8"]`, el);
      turnSel?.scrollIntoView({ inline: "center", block: "nearest" });
      const mvp = $("#mvp", el);
      if (mvp) {
        const names = deck ? [...deck.commanders, ...deck.cards.map((c) => c.name)] : [];
        const hits = $("#mvp-hits", el);
        const show = () => {
          const q = mvp.value.trim().toLowerCase();
          const list = q.length < 2 ? [] : names.filter((n) => n.toLowerCase().includes(q)).slice(0, 5);
          hits.innerHTML = list.map((n) => `<button class="chip" type="button" data-mvp="${esc(n)}">${esc(n)}</button>`).join("");
          for (const b of $$("[data-mvp]", hits)) b.addEventListener("click", () => { g.mvp = b.dataset.mvp; mvp.value = g.mvp; hits.innerHTML = ""; keep(); mvp.blur(); });
        };
        mvp.addEventListener("input", () => { g.mvp = mvp.value; keep(); show(); });
      }
      $("#note", el)?.addEventListener("input", (e) => { g.note = e.target.value; keep(); });
      $("#save-game", el).addEventListener("click", saveGame);
    },
  };
}

function toggleIn(list, key, btn) {
  const i = list.indexOf(key);
  if (i >= 0) list.splice(i, 1); else list.push(key);
  btn.setAttribute("aria-pressed", i < 0);
  keep();
}
function single(el, attr, value) {
  for (const b of $$(`[${attr}]`, el)) b.setAttribute("aria-pressed", String(b.getAttribute(attr) === String(value)));
}

function saveGame() {
  if (!g?.result) return;
  const deck = deckBy(g.deck);
  const game = { id: g.id, deck: g.deck, result: g.result, turn: g.turn, issues: g.result === "win" ? [] : g.issues,
    how: g.how, started: g.started === null ? null : g.started === "me" ? "me" : Number(g.started), mvp: g.mvp.trim() || null, note: g.note.trim() };
  if (g.round) game.round = g.round;
  const opponents = g.opps.map((o) => {
    const commander = o.commander || oppBy(o.id)?.commanders?.[0] || "";
    return { id: o.id || null, commander, colors: o.colors || "", new_id: o.id ? null : uid().slice(0, 8), note: o.note || "",
      image: o.id ? null : scry.cached(commander)?.image || null };
  });
  const entry = op("game.add", { game, opponents });
  setPref("deck", g.deck);
  g.saved = true;
  save(KEY_DRAFT, null);
  vibrate(18);
  closeSheet();
  toast(`${RESULT_TEXT[game.result]} gespeichert`, { ok: true, sub: celebrate(game, deck), action: { label: "Rückgängig", run: () => { undo(entry); toast("Partie entfernt"); } } });
}

// one quiet line of context instead of confetti
function celebrate(game, deck) {
  const mine = gamesOf(game.deck);
  if (game.result === "win") {
    const wins = mine.filter((x) => x.result === "win").length;
    const one = (state.snap.games[0]?.opponent_ids || []).filter(Boolean);
    if (one.length === 1) {
      const o = oppBy(one[0]);
      if (o && o.record.games > 1) return `Gegen ${oppName(o)} jetzt ${o.record.wins}:${o.record.losses}`;
    }
    return `${wins}. Sieg mit ${shortName(deck?.name)}`;
  }
  return `${shortName(deck?.name)}: ${mine.filter((x) => x.result === "win").length}:${mine.filter((x) => x.result === "loss").length}`;
}

// ---- opponent picker (second page of the game sheet and of the round start) ----
let pickQuery = "";
/** A sheet page that picks opponents into ``target.opps``; ``onChange`` runs after every change. */
export const opponentPicker = (target, backLabel, onChange) => (api) => pickerPage(api, target, backLabel, onChange);
function pickerPage({ pop }, g, backLabel, onChange) {
  const keep = onChange;
  const chosen = new Set(g.opps.map((o) => o.id).filter(Boolean));
  const opps = state.snap.opponents;
  return {
    title: "Gegner",
    left: `<button class="back-btn" type="button" data-sheet-back>${icon("chev-l")}<span>${esc(backLabel)}</span></button>`,
    right: `<button class="btn plain" type="button" id="pick-done"><b>Fertig</b></button>`,
    body: `
      <label class="search"><span class="sr">Gegner oder Commander suchen</span>${icon("search")}
        <input class="input" id="pick-q" type="search" placeholder="Gegner oder Commander" value="${esc(pickQuery)}" autocomplete="off" autocapitalize="off" enterkeyhint="search"></label>
      <div id="pick-new"></div>
      <div class="field-label" id="pick-head">${opps.length ? "Deine Runde" : ""}</div>
      <div class="group result-list" id="pick-list">${opps.map((o) => `<button class="row" type="button" data-pick="${esc(o.id)}" aria-pressed="${chosen.has(o.id)}">
          <span class="thumb round" data-bg="${esc(o.colors)}">${art(o.commanders[0], "art", "thumb round")}</span>
          <span class="main"><span class="title">${esc(oppName(o))}</span><span class="subtitle">${esc([o.player, o.record.games ? `${plural(o.record.games, "Partie", "Partien")}` : ""].filter(Boolean).join(" · ") || (o.commanders || []).join(" + "))}</span></span>
          <span class="sel-check">${icon("check", "xs")}</span></button>`).join("")}</div>`,
    bind(el) {
      scry.hydrate(el); paint(el);
      $("#pick-done", el).addEventListener("click", pop);
      for (const b of $$("[data-pick]", el)) b.addEventListener("click", () => {
        const id = b.dataset.pick;
        const i = g.opps.findIndex((o) => o.id === id);
        if (i >= 0) g.opps.splice(i, 1);
        else if (g.opps.length < 5) g.opps.push({ id, commander: oppBy(id)?.commanders?.[0] || "" });
        b.setAttribute("aria-pressed", i < 0);
        keep();
      });
      const input = $("#pick-q", el);
      const box = $("#pick-new", el);
      const list = $("#pick-list", el);
      let seq = 0;
      const search = debounce(async (q) => {
        const mine = ++seq;
        box.innerHTML = `<p class="hint-small">Suche Commander …</p>`;
        try {
          const hits = await scry.searchCommanders(q);
          if (mine !== seq) return;
          const known = new Set(opps.flatMap((o) => o.commanders.map((c) => c.toLowerCase())));
          const fresh = hits.filter((c) => !known.has(c.name.toLowerCase()));
          box.innerHTML = fresh.length ? `<div class="field-label">Neuer Gegner</div><div class="group result-list">${fresh.map((c) => `<button class="row" type="button" data-new="${esc(c.name)}" data-colors="${esc(c.colors)}">
            <span class="thumb round">${art(c.name, "art", "thumb round")}</span><span class="main"><span class="title">${esc(c.name)}</span><span class="subtitle">${esc(c.type)}</span></span>${icon("plus", "sm chev")}</button>`).join("")}</div>`
            : `<p class="hint-small">Kein weiterer Commander gefunden.</p>`;
        } catch {
          if (mine !== seq) return;
          box.innerHTML = `<div class="group"><button class="row" type="button" data-new="${esc(q)}" data-colors=""><span class="res draw">${icon("plus", "sm")}</span>
            <span class="main"><span class="title">„${esc(q)}“ übernehmen</span><span class="subtitle">Ohne Netz – wird später nachgeschlagen</span></span></button></div>`;
        }
        for (const b of $$("[data-new]", box)) b.addEventListener("click", () => {
          if (g.opps.length < 5) g.opps.push({ id: null, commander: b.dataset.new, colors: b.dataset.colors });
          pickQuery = ""; keep(); pop();
        });
        scry.hydrate(box);
      }, 300);
      input.addEventListener("input", () => {
        pickQuery = input.value;
        const q = pickQuery.trim().toLowerCase();
        for (const row of $$("[data-pick]", list)) {
          const o = oppBy(row.dataset.pick);
          row.hidden = !!q && ![oppName(o), o.player, ...o.commanders].join(" ").toLowerCase().includes(q);
        }
        $("#pick-head", el).hidden = !$$("[data-pick]:not([hidden])", list).length;
        if (q.length >= 2) search(q); else { seq++; box.innerHTML = ""; }
      });
      if (pickQuery.trim().length >= 2) input.dispatchEvent(new Event("input"));
    },
  };
}

// ======================================================================================
// Gegnerdeck festhalten
// ======================================================================================
// traits: the ones your table shows most first, then a sensible default order
const TAG_ORDER = ["combo", "fast", "stax", "wipes", "counters", "removal", "tokens", "graveyard", "voltron", "spells", "fliers", "lifegain", "artifacts", "theft", "politics", "lands"];
function sortedTags() {
  const count = {};
  for (const o of state.snap.opponents) for (const t of o.tags || []) count[t] = (count[t] || 0) + 1;
  const rank = (k) => (TAG_ORDER.indexOf(k) + 1 || 99);
  return [...state.snap.options.tags].sort((a, b) => (count[b[0]] || 0) - (count[a[0]] || 0) || rank(a[0]) - rank(b[0]));
}

export function opponentSheet() {
  const f = { commander: null, partner: null, player: "", tags: [], note: "", allTags: false, newPlayer: false };
  let query = "";
  const page = () => {
    const tags = sortedTags();
    const players = state.snap.players;
    return {
      title: "Neues Gegnerdeck",
      body: f.commander ? `
        ${commanderRows(f)}
        <div class="field-label">Spieler <span class="hint">optional</span></div>
        ${playerField(f, players)}
        <div class="field-label">Was fällt auf? <span class="hint">optional</span></div>
        <div class="chips" id="tags">${tags.slice(0, f.allTags ? tags.length : 8).map(([k, l]) => `<button class="chip" type="button" data-tag="${k}" aria-pressed="${f.tags.includes(k)}">${esc(l)}</button>`).join("")}
          ${f.allTags ? "" : `<button class="chip add" type="button" id="all-tags">mehr …</button>`}</div>
        <div class="field-label">Notiz <span class="hint">optional</span></div>
        <textarea class="textarea" id="opp-note" placeholder="z. B. „gewinnt über Thassa's Oracle“">${esc(f.note)}</textarea>`
      : `
        <label class="search"><span class="sr">Commander suchen</span>${icon("search")}
          <input class="input" id="cmd-q" type="search" placeholder="Commander – deutsch oder englisch" value="${esc(query)}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"></label>
        <div id="cmd-hits"><p class="hint-small">Ein paar Buchstaben reichen, z. B. „atra“ oder „Krenko“.</p></div>`,
      foot: f.commander ? `<button class="btn primary big" type="button" id="opp-save">Speichern</button>` : "",
      bind(el) {
        scry.hydrate(el); paint(el);
        if (!f.commander) {
          const input = $("#cmd-q", el);
          const hitsEl = $("#cmd-hits", el);
          let seq = 0;
          const search = debounce(async (q) => {
            const mine = ++seq;
            try {
              const hits = await scry.searchCommanders(q);
              if (mine !== seq) return;
              hitsEl.innerHTML = hits.length ? `<div class="group result-list">${hits.map((c) => `<button class="row" type="button" data-cmd="${esc(c.name)}">
                <span class="thumb round">${art(c.name, "art", "thumb round")}</span><span class="main"><span class="title">${esc(c.name)}</span>
                <span class="subtitle">${pips(c.colors)} ${esc(c.type)}</span></span></button>`).join("")}</div>` : `<p class="hint-small">Kein Commander gefunden.</p>`;
            } catch {
              if (mine !== seq) return;
              hitsEl.innerHTML = `<div class="group"><button class="row" type="button" data-cmd="${esc(q)}" data-offline="1"><span class="res draw">${icon("plus", "sm")}</span>
                <span class="main"><span class="title">„${esc(q)}“ übernehmen</span><span class="subtitle">Ohne Netz – wird später nachgeschlagen</span></span></button></div>`;
            }
            scry.hydrate(hitsEl);
            for (const b of $$("[data-cmd]", hitsEl)) b.addEventListener("click", () => {
              const c = scry.cached(b.dataset.cmd);
              f.commander = c ? { name: c.name, colors: c.colors, type: c.type } : { name: b.dataset.cmd, colors: "", type: "" };
              document.activeElement?.blur();
              redraw();
            });
          }, 280);
          input.addEventListener("input", () => { query = input.value; if (query.trim().length >= 2) search(query.trim()); });
          setTimeout(() => input.focus(), 60);  // the one field to type in: keyboard right away
          return;
        }
        bindCommanderRows(el, f, { onMain: () => { f.commander = null; f.partner = null; redraw(); }, backLabel: "Gegnerdeck" });
        bindPlayerField(el, f);
        for (const b of $$("[data-tag]", el)) b.addEventListener("click", () => toggleTag(f.tags, b));
        $("#all-tags", el)?.addEventListener("click", () => { f.allTags = true; redraw(); });
        $("#opp-note", el).addEventListener("input", (e) => { f.note = e.target.value; });
        $("#opp-save", el).addEventListener("click", () => {
          const opponent = { id: uid().slice(0, 8), commanders: [f.commander.name, ...(f.partner ? [f.partner.name] : [])], colors: joinColors(f.commander.colors, f.partner?.colors),
            player: f.player.trim(), tags: f.tags, image: scry.cached(f.commander.name)?.image || null };
          const entry = op("opponent.add", { opponent, note: f.note, note_id: uid().slice(0, 8) });
          vibrate(18);
          closeSheet();
          const name = shortName(f.commander.name);
          toast(`${f.player.trim() ? `${genitive(f.player.trim())} ` : ""}${name} gespeichert`, { ok: true, action: { label: "Rückgängig", run: () => undo(entry) } });
        });
      },
    };
  };
  openSheet(page, { full: true });
}

// ---- shared parts of the opponent sheets: commander + partner rows, the player chips, commander search ----
const joinColors = (...parts) => [..."WUBRG"].filter((c) => parts.some((p) => String(p || "").includes(c))).join("");
const cmdOf = (name) => { const c = scry.cached(name); return { name, colors: c?.colors || "", type: c?.type || "" }; };

function commanderRows(f) {
  const row = (c, id, label) => `<div class="row"><span class="thumb" data-bg="${esc(c.colors)}">${art(c.name, "art", "thumb")}</span>
    <span class="main"><span class="title wrap">${esc(c.name)}</span><span class="subtitle">${pips(c.colors)} ${esc(c.type || "")}</span></span>
    <button class="btn plain" type="button" id="${id}">${label}</button></div>`;
  return `<div class="group" id="cmd-rows">${row(f.commander, "cmd-change", "Ändern")}
    ${f.partner ? row(f.partner, "partner-remove", "Entfernen")
      : `<button class="row" type="button" id="partner-add"><span class="res draw">${icon("plus", "sm")}</span>
        <span class="main"><span class="title">Partner hinzufügen</span><span class="subtitle">Zweiter Commander oder Hintergrund</span></span>${icon("chev-r", "sm chev")}</button>`}</div>`;
}
function bindCommanderRows(el, f, { onMain, backLabel }) {
  $("#cmd-change", el).addEventListener("click", onMain);
  $("#partner-remove", el)?.addEventListener("click", () => { f.partner = null; redraw(); });
  $("#partner-add", el)?.addEventListener("click", () => pushPage(commanderPage({ title: "Partner", backLabel, partner: true, onPick: (c) => { f.partner = c; } })));
}

function playerField(f, players) {
  const typed = f.newPlayer || !players.length || (f.player && !players.includes(f.player));
  return `<div class="chips" id="players">${players.map((p) => `<button class="chip" type="button" data-player="${esc(p)}" aria-pressed="${f.player === p}">${esc(p)}</button>`).join("")}
      ${typed ? "" : `<button class="chip add" type="button" id="new-player">${icon("plus")}Name</button>`}</div>
    ${typed ? `<input class="input" id="player-in" value="${esc(players.includes(f.player) ? "" : f.player)}" placeholder="Name des Spielers" autocomplete="off" enterkeyhint="done">` : ""}`;
}
function bindPlayerField(el, f) {
  for (const b of $$("[data-player]", el)) b.addEventListener("click", () => { f.player = f.player === b.dataset.player ? "" : b.dataset.player; f.newPlayer = false; redraw(); });
  $("#new-player", el)?.addEventListener("click", () => { f.newPlayer = true; f.player = ""; redraw(); setTimeout(() => $("#player-in")?.focus(), 30); });
  $("#player-in", el)?.addEventListener("input", (e) => { f.player = e.target.value; });
}

const commanderSearch = (partner) => `<label class="search"><span class="sr">${partner ? "Partner suchen" : "Commander suchen"}</span>${icon("search")}
    <input class="input" id="cmd-q" type="search" placeholder="${partner ? "Partner oder Hintergrund" : "Commander – deutsch oder englisch"}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"></label>
  <div id="cmd-hits"><p class="hint-small">Ein paar Buchstaben reichen, z. B. „${partner ? "tymna" : "atra"}“.</p></div>`;

/** A sheet page that searches a commander (``partner``: also Backgrounds); ``onPick(c)`` then goes back. */
function commanderPage({ title, backLabel, partner = false, onPick }) {
  return ({ pop }) => ({
    title,
    left: `<button class="back-btn" type="button" data-sheet-back>${icon("chev-l")}<span>${esc(backLabel)}</span></button>`,
    body: commanderSearch(partner),
    bind(el) { bindCommanderSearch(el, { partner, onPick: (c) => { onPick(c); pop(); } }); },
  });
}

function bindCommanderSearch(el, { partner = false, onPick }) {
  let query = "";
  const input = $("#cmd-q", el);
  const hitsEl = $("#cmd-hits", el);
  let seq = 0;
  const pick = (c) => { document.activeElement?.blur(); onPick(c); };
  const search = debounce(async (q) => {
    const mine = ++seq;
    try {
      const hits = await scry.searchCommanders(q, { partner });
      if (mine !== seq) return;
      hitsEl.innerHTML = hits.length ? `<div class="group result-list">${hits.map((c) => `<button class="row" type="button" data-cmd="${esc(c.name)}">
        <span class="thumb round">${art(c.name, "art", "thumb round")}</span><span class="main"><span class="title">${esc(c.name)}</span>
        <span class="subtitle">${pips(c.colors)} ${esc(c.type)}</span></span></button>`).join("")}</div>` : `<p class="hint-small">Nichts gefunden.</p>`;
    } catch {
      if (mine !== seq) return;
      hitsEl.innerHTML = `<div class="group"><button class="row" type="button" data-cmd="${esc(q)}"><span class="res draw">${icon("plus", "sm")}</span>
        <span class="main"><span class="title">„${esc(q)}“ übernehmen</span><span class="subtitle">Ohne Netz – wird später nachgeschlagen</span></span></button></div>`;
    }
    scry.hydrate(hitsEl);
    for (const b of $$("[data-cmd]", hitsEl)) b.addEventListener("click", () => pick(cmdOf(b.dataset.cmd)));
  }, 280);
  input.addEventListener("input", () => { query = input.value; if (query.trim().length >= 2) search(query.trim()); });
  setTimeout(() => input.focus(), 60);
}

// ======================================================================================
// Neues Deck: commander (+ partner), name, bracket – then the builder opens (js/build.js)
// ======================================================================================
export function newDeckSheet() {
  const f = { commander: null, partner: null, name: "", bracket: 3 };
  const page = () => {
    const auto = f.commander ? [f.commander.name, ...(f.partner ? [f.partner.name] : [])].map(shortName).join(" & ") : "";
    return {
      title: "Neues Deck",
      body: f.commander ? `
        <div class="field-label">Commander</div>
        ${commanderRows(f)}
        <div class="field-label">Name <span class="hint">optional</span></div>
        <input class="input" id="deck-name" value="${esc(f.name)}" placeholder="${esc(auto)}" maxlength="80" autocomplete="off" enterkeyhint="done">
        <div class="field-label">Ziel-Bracket</div>
        <div class="segmented" role="radiogroup" aria-label="Ziel-Bracket" id="deck-bracket">${[1, 2, 3, 4, 5].map((v) =>
          `<button type="button" role="radio" data-b="${v}" aria-pressed="${f.bracket === v}" aria-checked="${f.bracket === v}">${v}</button>`).join("")}</div>
        <p class="hint-small">Danach suchst du die Karten aus. Legalität, Bracket und Preis prüft dein PC beim nächsten Abgleich.</p>`
        : `<p class="hint-small lead-hint">Wer führt dein neues Deck an?</p>${commanderSearch(false)}`,
      foot: f.commander ? `<button class="btn primary big" type="button" id="deck-go">${icon("plus", "sm")}Deck anlegen</button>` : "",
      bind(el) {
        scry.hydrate(el); paint(el);
        if (!f.commander) { bindCommanderSearch(el, { onPick: (c) => { f.commander = c; redraw(); } }); return; }
        bindCommanderRows(el, f, { backLabel: "Neues Deck", onMain: () => { f.commander = null; f.partner = null; redraw(); } });
        $("#deck-name", el).addEventListener("input", (e) => { f.name = e.target.value; });
        for (const b of $$("[data-b]", el)) b.addEventListener("click", () => { f.bracket = Number(b.dataset.b); redraw(); });
        $("#deck-go", el).addEventListener("click", () => {
          const commanders = [f.commander.name, ...(f.partner ? [f.partner.name] : [])];
          closeSheet();
          import("./build.js").then((m) => m.createDeck({ name: f.name.trim() || auto, commanders, colors: joinColors(f.commander.colors, f.partner?.colors), bracket: f.bracket }));
        });
      },
    };
  };
  openSheet(page, { full: true });
}

// ======================================================================================
// Gegnerdeck bearbeiten: name, commander, partner, player, bracket – games and notes stay linked (by id)
// ======================================================================================
export function editOpponentSheet(id) {
  const o = oppBy(id);
  if (!o) return;
  const [first, second] = o.commanders || [];
  const own = (name, i) => ({ ...cmdOf(name), colors: scry.cached(name)?.colors || (o.commanders.length === 1 || i === 0 ? o.colors : "") });
  const f = { label: o.label || "", commander: own(first, 0), partner: second ? own(second, 1) : null, player: o.player || "", bracket: o.bracket ?? null, newPlayer: false };
  const page = () => {
    const auto = oppName({ commanders: [f.commander.name, ...(f.partner ? [f.partner.name] : [])] });
    return {
      title: "Gegnerdeck bearbeiten",
      body: `
        <div class="field-label">Name <span class="hint">optional</span></div>
        <input class="input" id="opp-label" value="${esc(f.label)}" placeholder="${esc(auto)}" maxlength="80" autocomplete="off" enterkeyhint="done">
        <div class="field-label">Commander</div>
        ${commanderRows(f)}
        <div class="field-label">Spieler <span class="hint">optional</span></div>
        ${playerField(f, state.snap.players)}
        <div class="field-label">Etwa Bracket</div>
        <div class="segmented" role="radiogroup" aria-label="Etwa Bracket" id="opp-bracket">${[[null, "?"], [1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5"]].map(([v, l]) =>
          `<button type="button" role="radio" data-b="${v ?? ""}" aria-pressed="${f.bracket === v}" aria-checked="${f.bracket === v}"${v === null ? ' aria-label="unbekannt"' : ""}>${l}</button>`).join("")}</div>
        <p class="hint-small">Partien, Bilanz und Notizen bleiben an diesem Gegnerdeck.</p>`,
      foot: `<button class="btn primary big" type="button" id="opp-done">Speichern</button>`,
      bind(el) {
        scry.hydrate(el); paint(el);
        $("#opp-label", el).addEventListener("input", (e) => { f.label = e.target.value; });
        bindCommanderRows(el, f, { backLabel: "Bearbeiten", onMain: () => pushPage(commanderPage({ title: "Commander", backLabel: "Bearbeiten", onPick: (c) => { f.commander = c; } })) });
        bindPlayerField(el, f);
        for (const b of $$("[data-b]", el)) b.addEventListener("click", () => { f.bracket = b.dataset.b ? Number(b.dataset.b) : null; redraw(); });
        $("#opp-done", el).addEventListener("click", () => commit());
      },
    };
  };
  const commit = () => {
    const now = { label: f.label.trim(), player: f.player.trim(), bracket: f.bracket, commanders: [f.commander.name, ...(f.partner ? [f.partner.name] : [])] };
    const before = { label: o.label || "", player: o.player || "", bracket: o.bracket ?? null, commanders: o.commanders || [] };
    const changed = Object.keys(now).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(before[k]));
    closeSheet();
    if (!changed.length) return;
    const payload = { id: o.id }, prev = {};
    for (const k of changed) { payload[k] = now[k]; prev[k] = before[k]; }
    if (changed.includes("commanders")) {
      payload.colors = joinColors(f.commander.colors, f.partner?.colors);
      payload.image = scry.cached(f.commander.name)?.image || null;
      prev.colors = o.colors || "";
      prev.image = scry.cached(before.commanders[0])?.image || null;
    }
    const entry = op("opponent.update", { ...payload, prev });
    vibrate(12);
    toast(`${oppName({ ...o, ...now })} gespeichert`, { ok: true, action: { label: "Rückgängig", run: () => undo(entry) } });
  };
  openSheet(page, { full: true });
}

function toggleTag(list, btn) {
  const k = btn.dataset.tag;
  const i = list.indexOf(k);
  if (i >= 0) list.splice(i, 1); else list.push(k);
  btn.setAttribute("aria-pressed", i < 0);
}

// ======================================================================================
// Deck wechseln, Karte, Partie, Einstellungen
// ======================================================================================
export function switchDeckSheet() {
  const cur = currentDeck();
  openSheet(() => ({
    title: "Heute spielst du",
    left: "",
    right: `<button class="btn plain" type="button" data-sheet-close><b>Fertig</b></button>`,
    body: `<div class="group result-list">${state.snap.decks.map((d) => `<button class="row" type="button" data-pick="${esc(d.slug)}" aria-pressed="${d.slug === cur?.slug}">
        <span class="thumb" data-bg="${esc(d.colors)}">${art(d.commanders[0], "art", "thumb")}</span>
        <span class="main"><span class="title">${esc(d.name)}</span><span class="subtitle">${pips(d.colors)} ${esc(d.level)}</span></span>
        <span class="sel-check">${icon("check", "xs")}</span></button>`).join("")}</div>`,
    bind(el) {
      scry.hydrate(el); paint(el);
      for (const b of $$("[data-pick]", el)) b.addEventListener("click", () => { setPref("deck", b.dataset.pick); closeSheet(); });
    },
  }), { onClose: () => window.dispatchEvent(new Event("hashchange")) });
}

/** ``action`` = {label, run}: a button at the bottom (the builder's „Ins Deck“). */
export function cardSheet(name, action = null) {
  rememberCard(name);
  let lang = "de";
  let de;  // undefined = loading, null = no German printing
  let turned = false;  // a double-faced card shows its back
  const page = () => {
    const c = scry.cached(name);
    const showDe = lang === "de" && de;
    return {
      title: showDe ? de.name : name, left: "", right: `<button class="btn plain" type="button" data-sheet-close><b>Fertig</b></button>`,
      body: `<div class="card-image${c?.back ? ` two${turned ? " turned" : ""}` : ""}" id="card-img">${c?.image ? `<img class="front" src="${esc(c.image)}" alt="${esc(name)}">` : ""}${c?.back ? `<img class="back" src="${esc(c.back)}" alt="${esc(name)}, Rückseite">` : ""}</div>
        ${c?.back ? `<div class="flip-row"><button class="btn tint small" type="button" id="card-flip" aria-pressed="${turned}">${icon("swap", "xs")}Umdrehen</button></div>` : ""}
        ${de ? `<div class="segmented lang" role="tablist"><button type="button" data-lang="de" aria-pressed="${lang === "de"}">Deutsch</button><button type="button" data-lang="en" aria-pressed="${lang === "en"}">Original</button></div>` : ""}
        <div class="card-text">
          <div class="card-title-line"><b>${esc(showDe ? de.name : c?.name || name)}</b> <span class="mana">${mana(c?.cost || "")}</span></div>
          <div class="tl">${esc(showDe ? de.type : c?.type || "")}${c?.pt ? ` · ${esc(c.pt)}` : ""}</div>
          <p>${showDe ? rulesText(de.text) : c?.text ? rulesText(c.text) : c ? "" : "Lade Kartendaten …"}</p>
          ${showDe ? `<p class="note">Gedruckter deutscher Text – der aktuelle Regeltext steht unter „Original“.</p>` : ""}
          ${de === undefined && c ? `<p class="note">Suche deutschen Text …</p>` : ""}
        </div>`,
      foot: action?.label || action?.alt ? `<div class="foot-row">${action.alt ? `<button class="btn big" type="button" id="card-alt">${icon(action.alt.icon || "plus", "sm")}${esc(action.alt.label)}</button>` : ""}
        ${action.label ? `<button class="btn primary big" type="button" id="card-action">${icon("plus", "sm")}${esc(action.label)}</button>` : ""}</div>` : "",
      bind(el) {
        for (const b of $$("[data-lang]", el)) b.addEventListener("click", () => { lang = b.dataset.lang; redraw(); });
        const flip = () => { turned = !turned; $("#card-img", el).classList.toggle("turned", turned); $("#card-flip", el).setAttribute("aria-pressed", turned); };
        $("#card-flip", el)?.addEventListener("click", flip);
        if (c?.back) $("#card-img", el).addEventListener("click", flip);
        $("#card-action", el)?.addEventListener("click", action?.run);
        $("#card-alt", el)?.addEventListener("click", action?.alt?.run);
      },
    };
  };
  openSheet(page);
  scry.info(name).then(() => { if ($("#sheet").open) redraw(); });
  scry.german(name).then((x) => { de = x; if ($("#sheet").open) redraw(); });
}

export function gameDetailSheet(deckSlug, id) {
  const game = state.snap.games.find((x) => x.id === id && x.deck === deckSlug);
  if (!game) return;
  const d = deckBy(deckSlug);
  const how = Object.fromEntries(state.snap.options.how);
  const issues = Object.fromEntries(state.snap.options.issues);
  const vs = (game.opponent_ids || []).map((oid, i) => ({ o: oppBy(oid), name: game.opponents?.[i] }));
  const line = (label, value) => (value ? `<div class="row"><span class="main"><span class="subtitle">${esc(label)}</span><span class="title wrap">${esc(value)}</span></span></div>` : "");
  const started = game.started === "me" ? "Ich" : typeof game.started === "number" ? shortName(game.opponents?.[game.started]) : "";
  openSheet(() => ({
    title: RESULT_TEXT[game.result], left: "", right: `<button class="btn plain" type="button" data-sheet-close><b>Fertig</b></button>`,
    body: `<div class="group">${line("Deck", d?.name)}${line("Gespielt", dateLong(game.played))}${line("Zug", game.turn)}${line("Entschieden durch", how[game.how])}
        ${line("Angefangen hat", started)}${line("Woran lag's", (game.issues || []).map((k) => issues[k]).filter(Boolean).join(", "))}${line("Beste Karte", game.mvp)}${line("Notiz", game.note)}</div>
      ${game.round ? `<div class="field-label">Runde</div>${roundSummary(game.round)}<div class="btn-col"><button class="btn tint" type="button" id="round-log">${icon("clock", "sm")}Verlauf ansehen</button></div>` : ""}
      ${vs.length ? `<div class="field-label">Gegner</div><div class="group">${vs.map(({ o, name }) => `<a class="row" href="${o ? `#/gegner/${esc(o.id)}` : "#/gegner"}" data-sheet-close>
        <span class="thumb round">${art(o?.commanders?.[0] || name, "art", "thumb round")}</span><span class="main"><span class="title">${esc(o ? oppName(o) : shortName(name))}</span>
        <span class="subtitle">${esc(o?.player || name || "")}</span></span>${icon("chev-r", "sm chev")}</a>`).join("")}</div>` : ""}
      <div class="btn-col"><button class="btn danger big" type="button" id="del-game">${icon("trash", "sm")}Partie löschen</button></div>`,
    bind(el) {
      scry.hydrate(el);
      for (const a of $$("a[data-sheet-close]", el)) a.addEventListener("click", closeSheet);
      $("#round-log", el)?.addEventListener("click", () => pushPage(roundLogPage(game.round, RESULT_TEXT[game.result])));
      $("#del-game", el).addEventListener("click", () => {
        const restore = { game: { id: game.id, deck: deckSlug, result: game.result, turn: game.turn ?? null, issues: game.issues || [], how: game.how ?? null,
          started: game.started ?? null, mvp: game.mvp ?? null, note: game.note || "", played: game.played, ...(game.round ? { round: game.round } : {}) },
          opponents: (game.opponents || []).map((name, i) => ({ id: game.opponent_ids?.[i] || null, commander: name })) };
        const entry = op("game.delete", { deck: deckSlug, id, restore });
        closeSheet();
        toast("Partie gelöscht", { action: { label: "Rückgängig", run: () => undo(entry) } });
      });
    },
  }));
}

const OP_LABEL = {
  "game.add": (p) => `Partie (${RESULT_TEXT[p.game?.result] || "?"}) mit ${deckBy(p.game?.deck)?.name || p.game?.deck || "?"}`,
  "game.delete": () => "Partie löschen", "opponent.add": (p) => `Gegnerdeck ${shortName(p.opponent?.commanders?.[0])}`,
  "opponent.update": () => "Merkmale eines Gegners", "opponent.note": () => "Notiz zu einem Gegner",
  "opponent.note_delete": () => "Notiz löschen", "opponent.delete": () => "Gegnerdeck löschen",
  "deck.flags": (p) => `Markierung von ${deckBy(p.deck)?.name || p.deck || "?"}`,
};

export function settingsSheet() {
  openSheet(({ push }) => {
    const theme = state.prefs.theme || "system";
    const font = state.prefs.font === "inter" ? "inter" : "cascadia";
    const pend = pendingCount();
    const failed = failedOps();
    const d = state.device;
    const status = !state.online ? ["wait", "Offline", pend ? `${plural(pend, "Eintrag wartet", "Einträge warten")} – wird gesendet, sobald Netz da ist.` : "Du siehst den zuletzt geladenen Stand."]
      : pend ? ["wait", `${plural(pend, "Eintrag wird", "Einträge werden")} gesendet …`, ""]
      : ["", "Alles abgeglichen", state.lastSync ? `aktualisiert ${ago(new Date(state.lastSync).toISOString())}` : ""];
    const live = `
      <div class="group settings">
        <div class="row"><span class="status-dot ${status[0]}"></span><span class="main"><span class="title wrap">${esc(status[1])}</span>
          <span class="subtitle wrap">${esc(status[2])}</span></span>
          <button class="btn" type="button" id="sync-now">Aktualisieren</button></div>
        <div class="row"><span class="main"><span class="subtitle">Server</span><span class="title">${esc(location.host)}</span></span></div>
        <div class="row"><span class="main"><span class="subtitle">Dieses Handy</span><span class="title">${esc(d?.name || "Handy")}</span></span>
          <span class="trail">${d?.paired_at ? `seit ${esc(new Date(d.paired_at).toLocaleDateString("de-DE"))}` : ""}</span></div>
        ${state.pcs.map((pc) => `<div class="row"><span class="status-dot ${pc.online ? "" : "off"}"></span><span class="main"><span class="title">PC „${esc(pc.name)}“</span>
          <span class="subtitle">${pc.online ? "online" : `zuletzt ${esc(ago(new Date(pc.last_seen * 1000).toISOString()))}`}</span></span></div>`).join("")}
      </div>
      <div class="field-label">Weiteres Gerät</div>
      <div class="group settings"><button class="row" type="button" id="link-open"><span class="row-icon">${icon("qr", "sm")}</span><span class="main"><span class="title">Gerät verbinden</span>
        <span class="subtitle wrap">QR-Code, Code und Link für ein Handy oder iPad</span></span>${icon("chev-r", "sm chev")}</button></div>
      <div class="field-label">Kartensuche</div>
      <div class="group settings"><button class="row" type="button" id="ai-open"><span class="row-icon">${icon("sparkle", "sm")}</span><span class="main"><span class="title">Suche mit KI</span>
        <span class="subtitle wrap" id="ai-state">${esc(aiStateText())}</span></span>${icon("chev-r", "sm chev")}</button></div>
      ${failed.length ? `<div class="field-label">Nicht übernommen</div><div class="group settings">${failed.map((o) => `<div class="row"><span class="main">
          <span class="title">${esc(OP_LABEL[o.type]?.(o.payload) || o.type)}</span><span class="subtitle wrap">${esc(o.error || "")}</span></span>
          <button class="btn" type="button" data-drop="${esc(o.id)}">Verwerfen</button></div>`).join("")}</div>` : ""}
      <div class="btn-col"><button class="btn danger" type="button" id="sign-off">Abmelden …</button></div>`;
    const demo = `
      <div class="group settings"><div class="row"><span class="status-dot wait"></span><span class="main"><span class="title">Vorschau mit Beispieldaten</span>
          <span class="subtitle wrap">Nicht mit deinem PC verbunden – Einträge bleiben nur auf diesem Handy.</span></span></div>
        <div class="row"><span class="main"><span class="title">Beispieleinträge löschen</span></span><button class="btn" type="button" id="demo-reset">Zurücksetzen</button></div></div>
      <div class="btn-col"><button class="btn primary" type="button" id="demo-end">Mit meinem PC verbinden</button></div>`;
    return {
      title: "Einstellungen", left: "", right: `<button class="btn plain" type="button" data-sheet-close><b>Fertig</b></button>`,
      body: `<div class="field-label">Erscheinungsbild</div>
        <div class="segmented" id="theme">${[["system", "System"], ["light", "Hell"], ["dark", "Dunkel"]].map(([k, l]) => `<button type="button" data-theme="${k}" aria-pressed="${theme === k}">${l}</button>`).join("")}</div>
        <div class="field-label">Schrift</div>
        <div class="segmented" id="font">${[["cascadia", "Cascadia Code"], ["inter", "Inter"]].map(([k, l]) => `<button type="button" data-font="${k}" aria-pressed="${font === k}">${l}</button>`).join("")}</div>
        <div class="field-label">Verbindung</div>
        ${isDemo() ? demo : live}
        <p class="hint-small center">Conclave · für den Spieltisch</p>`,
      bind(el) {
        for (const b of $$("[data-theme]", el)) b.addEventListener("click", () => { setPref("theme", b.dataset.theme); applyTheme(); redraw(); });
        for (const b of $$("[data-font]", el)) b.addEventListener("click", () => { setPref("font", b.dataset.font); applyTheme(); redraw(); });
        $("#demo-reset", el)?.addEventListener("click", () => { resetDemo(); save(KEY_DRAFT, null); toast("Beispieleinträge gelöscht"); redraw(); });
        $("#demo-end", el)?.addEventListener("click", () => { closeSheet(); endDemo(); });
        $("#sync-now", el)?.addEventListener("click", () => { wake(); toast("Wird aktualisiert …"); setTimeout(redraw, 1200); });
        for (const b of $$("[data-drop]", el)) b.addEventListener("click", () => { dropOp(b.dataset.drop); redraw(); });
        $("#sign-off", el)?.addEventListener("click", () => push(signOffPage));
        $("#ai-open", el)?.addEventListener("click", () => push(aiPage));
        $("#link-open", el)?.addEventListener("click", () => push(linkPage));
        if (!isDemo()) loadAi().then(() => { const s = $("#ai-state", el); if (s) s.textContent = aiStateText(); });
      },
    };
  }, { onClose: () => window.dispatchEvent(new Event("hashchange")) });
}

// ---- the AI card search: the Claude API key and model live on the sync server, never on the phone ----
let aiCfg = null;  // what the server says: {configured, model, from_env, key_hint}
export async function loadAi() {
  try { aiCfg = await serverCall("/api/app/ai"); } catch { /* offline: keep the last answer */ }
  return aiCfg;
}
const aiStateText = () => (isDemo() ? "Nur mit deinem Server verbunden" : !aiCfg ? "…" : aiCfg.configured ? `Eingerichtet · ${(aiCfg.models || []).find((m) => m.id === aiCfg.model)?.label || aiCfg.model}` : "Noch nicht eingerichtet");

/** The setup page, inside the settings or as its own sheet (from the Karten tab). */
export function aiSheet({ onSaved } = {}) {
  openSheet((ctx) => aiPage({ ...ctx, onSaved }));
}

function aiPage({ pop, close, redraw: again, onSaved }) {
  const c = aiCfg;
  const back = pop && !onSaved ? `<button class="back-btn" type="button" data-sheet-back>${icon("chev-l")}<span>Zurück</span></button>` : "";
  if (!c) {
    return { title: "Suche mit KI", left: back, body: `<div class="empty">${icon("sparkle")}<p>Wird geladen …</p></div>`,
      bind() { loadAi().then((got) => { if (got) again(); }); } };
  }
  return {
    title: "Suche mit KI", left: back, right: onSaved ? `<button class="btn plain" type="button" data-sheet-close>Abbrechen</button>` : "",
    body: `<p class="lead-small">Beschreib im Karten-Tab, was eine Karte tun soll – die KI macht daraus eine Scryfall-Suche.
        Dafür fragt der Server Claude.</p>
      <div class="field-label">Claude-API-Schlüssel</div>
      ${c.from_env ? `<div class="group settings"><div class="row"><span class="main"><span class="title">Vom Server vorgegeben</span>
          <span class="subtitle wrap">steht in der Server-Einstellung MTG_AI_KEY</span></span></div></div>`
        : `<input class="input" id="ai-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
          placeholder="${c.configured ? `gespeichert (${esc(c.key_hint)}) – neu eingeben zum Ändern` : "sk-ant-…"}">`}
      <p class="hint-small">In der Claude Console (platform.claude.com) unter „API Keys“ → „Create Key“. Er bleibt auf deinem Sync-Server und wird nie wieder ans Handy geschickt.</p>
      <div class="field-label">Modell</div>
      <div class="group settings" id="ai-models" role="radiogroup" aria-label="Modell">${(c.models || []).map((m) => `<button class="row" type="button" role="radio" data-model="${esc(m.id)}" aria-pressed="${m.id === c.model}" aria-checked="${m.id === c.model}">
          <span class="main"><span class="title">${esc(m.label)}</span><span class="subtitle wrap">${esc(m.note)} · ${esc(m.cost)}</span></span>
          <span class="sel-check">${icon("check", "xs")}</span></button>`).join("")}</div>
      <p class="hint-small">Die Kosten sind geschätzt. Bezahlt wird nur, was eine Suche wirklich verbraucht.</p>
      ${c.configured && !c.from_env ? `<div class="btn-col"><button class="btn danger" type="button" id="ai-remove">Schlüssel entfernen</button></div>` : ""}`,
    foot: `<button class="btn primary big" type="button" id="ai-save">Speichern</button>`,
    bind(el) {
      const send = async (body, done) => {
        const btn = $("#ai-save", el);
        btn.disabled = true;
        try {
          aiCfg = await serverCall("/api/app/ai", { method: "PUT", body });
          toast(done, { ok: true });
          if (onSaved) { close(); onSaved(aiCfg); } else if (pop) pop(); else close();
        } catch (e) {
          toast(e.message);
          btn.disabled = false;
        }
      };
      $("#ai-save", el).addEventListener("click", () => {
        const body = { key: $("#ai-key", el)?.value.trim() || null };  // only what changed: a model set on the server stays
        const model = $("#ai-models [aria-pressed=true]", el)?.dataset.model;
        if (model && model !== c.model) body.model = model;
        send(body, "Gespeichert");
      });
      for (const b of $$("[data-model]", el)) b.addEventListener("click", () => {
        for (const o of $$("[data-model]", el)) { const on = o === b; o.setAttribute("aria-pressed", on); o.setAttribute("aria-checked", on); }
      });
      $("#ai-remove", el)?.addEventListener("click", () => send({ key: "" }, "Schlüssel entfernt"));
    },
  };
}

// ---- connect another device: a fresh one-time code from the server, shown as QR code, code and link ----
let pairing = null;  // {code, link, expires, qr} or {error}
const pairValid = () => pairing?.code && pairing.expires * 1000 > Date.now() + 60_000;

function linkPage({ redraw: again }) {
  const back = `<button class="back-btn" type="button" data-sheet-back>${icon("chev-l")}<span>Zurück</span></button>`;
  const fresh = () => { pairing = null; again(); };
  if (!pairValid() && !pairing?.error) {
    return { title: "Gerät verbinden", left: back, body: `<div class="empty">${icon("qr")}<p>Code wird erstellt …</p></div>`,
      bind() {
        serverCall("/api/pair/start?qr=1", { method: "POST" })
          .then((got) => { pairing = got; }, (e) => { pairing = { error: e.message }; })
          .then(again);
      } };
  }
  if (pairing.error) {
    const msg = pairing.error;
    return { title: "Gerät verbinden", left: back, body: `<div class="empty">${icon("alert")}<h3>Kein Code</h3><p>${esc(msg)}</p></div>`,
      foot: `<button class="btn primary big" type="button" id="again">Noch einmal</button>`,
      bind(el) { $("#again", el).addEventListener("click", fresh); } };
  }
  const p = pairing;
  const until = new Date(p.expires * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return {
    title: "Gerät verbinden", left: back,
    body: `<p class="lead-small">Auf dem anderen Handy oder iPad die Kamera auf den Code halten – oder den Link schicken.</p>
      ${p.qr ? `<div class="pair-qr" role="img" aria-label="QR-Code mit dem Kopplungslink">${p.qr}</div>` : ""}
      <div class="field-label">Code</div>
      <div class="code-box"><span class="code">${esc(p.code)}</span><button class="btn tint" type="button" id="copy-code">${icon("copy", "sm")}Kopieren</button></div>
      <div class="field-label">Link</div>
      <div class="group settings"><div class="row"><span class="main"><span class="title wrap link-text">${esc(p.link)}</span></span></div></div>
      <p class="hint-small">Gültig bis ${esc(until)} Uhr und nur für ein Gerät. In der App dort: „QR-Code scannen“ oder „Code eingeben“.</p>
      <div class="btn-col"><button class="btn" type="button" id="new-code">Neuer Code</button></div>`,
    foot: `<button class="btn primary big" type="button" id="share-link">${icon("share", "sm")}Link teilen</button>`,
    bind(el) {
      const copy = async (text, what) => {
        try { await navigator.clipboard.writeText(text); toast(`${what} kopiert`, { ok: true }); } catch { toast("Kopieren ging nicht – bitte von Hand abschreiben."); }
      };
      $("#copy-code", el).addEventListener("click", () => copy(p.code, "Code"));
      $("#share-link", el).addEventListener("click", async () => {
        if (!navigator.share) return copy(p.link, "Link");
        try { await navigator.share({ title: "Mit Conclave verbinden", text: `Kopplungscode ${p.code}`, url: p.link }); } catch { /* closed */ }
      });
      $("#new-code", el).addEventListener("click", fresh);
    },
  };
}

function signOffPage({ pop }) {
  const pend = pendingCount();
  return {
    title: "Abmelden",
    left: `<button class="back-btn" type="button" data-sheet-back>${icon("chev-l")}<span>Zurück</span></button>`,
    body: `<div class="empty">${icon("shield")}<h3>Dieses Handy abmelden?</h3>
      <p>Es verliert den Zugang zu deinen Decks und Gegnern. Deine Daten am PC bleiben, wie sie sind.
      ${pend ? `<br><b>${plural(pend, "Eintrag ist", "Einträge sind")} noch nicht gesendet und ${pend === 1 ? "geht" : "gehen"} verloren.</b>` : ""}</p></div>`,
    foot: `<button class="btn danger-fill big" type="button" id="really">Abmelden</button>`,
    bind(el) {
      $("#really", el).addEventListener("click", async () => {
        $("#really", el).disabled = true;
        await disconnect();
        save(KEY_DRAFT, null);
        closeSheet();
        toast("Abgemeldet", { sub: "Mit einem neuen Code verbindest du das Handy wieder." });
      });
    },
  };
}

export function applyTheme() {
  document.documentElement.dataset.font = state.prefs.font === "inter" ? "inter" : "cascadia";  // like the desktop's „Schrift“
  const t = state.prefs.theme;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = dark ? "#141414" : "#f4f4f4";
}
