// The four tabs and their detail screens. Each screen returns {html, fab, bar, bind}; main.js draws it.

import { currentDeck, deckBy, failedOps, gamesOf, isDemo, isPending, op, oppBy, oppName, oppSub, pendingCount, serverCall, setPref, shortName, state } from "./data.js";
import { draftCount, tabletSized } from "./build.js";
import { roundCard, running, startSheet } from "./round.js";
import { cardSheet, editOpponentSheet, gameDetailSheet, gameSheet, newDeckSheet, opponentSheet, settingsSheet, switchDeckSheet } from "./forms.js";
import * as scry from "./scry.js";
import { present, toast } from "./ui.js";
import { $, $$, RESULT_TEXT, ago, artFallback, debounce, esc, icon, mana, pips, plural, recordText, reducedMotion, uid } from "./util.js";

// ---------- shared pieces ----------
export const art = (name, kind = "art", cls = "") => `<img data-card="${esc(name)}" data-kind="${kind}" alt="" class="${cls}" loading="lazy">`;
const thumb = (name, colors, cls = "thumb") => `<span class="${cls}" data-bg="${esc(colors || "")}">${art(name, "art", cls)}</span>`;

export function gameRow(g, { showDeck = true } = {}) {
  const d = deckBy(g.deck);
  const vs = (g.opponent_ids || []).map((id, i) => (oppBy(id) ? oppName(oppBy(id)) : shortName(g.opponents?.[i]))).filter(Boolean);
  const names = vs.length ? vs : (g.opponents || []).map(shortName);
  const against = names.length ? `gegen ${names.join(", ")}` : "";
  const title = showDeck ? d?.name || g.deck : against || "Partie";
  const sub = (showDeck ? [against, g.turn ? `Zug ${g.turn}` : ""] : [g.turn ? `Zug ${g.turn}` : "", ago(g.played)]).filter(Boolean).join(" · ");
  const pic = showDeck ? d?.commanders?.[0] : (g.opponent_ids || []).map((id) => oppBy(id)?.commanders?.[0]).find(Boolean) || g.opponents?.[0];
  const pending = isPending(g.id);
  return `<button class="row game-row" type="button" data-game="${esc(g.id)}" data-deck="${esc(g.deck)}">
    <span class="thumb round" data-bg="${esc(showDeck ? d?.colors : "")}">${pic ? art(pic, "art", "thumb round") : ""}</span>
    <span class="main"><span class="title">${esc(title)}</span><span class="subtitle">${esc(sub || "ohne Angaben")}</span></span>
    <span class="trail col"><span class="pill ${g.result}">${RESULT_TEXT[g.result] || "?"}</span>
      <span>${pending ? `<span class="pending" title="wird gesendet">${icon("clock", "xs")}</span> ` : ""}${showDeck ? esc(ago(g.played)) : ""}</span></span>
  </button>`;
}

function bindGames(el) {
  for (const b of $$("[data-game]", el)) b.addEventListener("click", () => gameDetailSheet(b.dataset.deck, b.dataset.game));
}

const empty = (ic, title, text, extra = "") => `<div class="empty">${icon(ic)}<h3>${esc(title)}</h3><p>${esc(text)}</p>${extra}</div>`;

// ---------- Tisch ----------
export function tisch() {
  const s = state.snap;
  const d = currentDeck();
  const recent = s.games.slice(0, 8);
  const html = `
    <div class="large-title"><h1>Am Tisch</h1>
      <button class="icon-btn filled" type="button" id="open-settings" aria-label="Einstellungen">${icon("sliders")}</button></div>
    ${d ? `<article class="hero">
        <button class="hero-art" type="button" id="switch-deck" data-bg="${esc(d.colors)}" aria-label="Deck wechseln – jetzt ${esc(d.name)}">
          ${art(d.commanders[0])}
          <span class="hero-over"><span class="kicker">Heute spielst du</span><span class="name">${esc(d.name)}</span>
            <span class="swap icon-btn glass" aria-hidden="true">${icon("swap", "sm")}</span></span>
        </button>
        <div class="hero-body">
          <span class="meta"><span class="lvl">${pips(d.colors)} ${esc(d.level)}</span>
            <span class="stat">${d.record.games ? `${plural(d.record.wins, "Sieg", "Siege")} · ${plural(d.record.losses, "Niederlage", "Niederlagen")}` : "noch keine Partie"}</span></span>
          <button class="btn tint" type="button" id="show-r0">${icon("shield", "sm")}Rule 0 zeigen</button>
        </div>
      </article>`
      : empty("decks", "Noch keine Decks", "Deine Decks kommen vom PC, sobald er abgeglichen hat.")}
    ${roundCard()}
    ${statusLine()}
    ${installHint()}
    <div class="section-head"><h2>Letzte Partien</h2></div>
    ${recent.length ? `<div class="group">${recent.map((g) => gameRow(g)).join("")}</div>`
      : `<div class="group">${empty("trophy", "Noch keine Partie eingetragen", "Nach der Partie unten auf „Partie eintragen“ – dauert ein paar Sekunden.")}</div>`}
    <div class="section-head"><h2>Schnell</h2></div>
    <div class="group">
      <button class="row" type="button" id="quick-opp"><span class="res draw" aria-hidden="true">${icon("users", "sm")}</span>
        <span class="main"><span class="title">Gegnerdeck festhalten</span><span class="subtitle">Jemand hat ein neues Deck dabei</span></span>${icon("chev-r", "sm chev")}</button>
      <a class="row" href="#/karten"><span class="res win" aria-hidden="true">${icon("search", "sm")}</span>
        <span class="main"><span class="title">Karte nachschlagen</span><span class="subtitle">Text auf Deutsch, auch für Karten deiner Decks</span></span>${icon("chev-r", "sm chev")}</a>
    </div>`;
  return {
    html, fab: running() ? { label: "Zur Runde", icon: "heart", run: () => { location.hash = "#/runde"; } } : d ? { label: "Partie eintragen", run: () => gameSheet() } : null,
    bar: { title: "Am Tisch", watch: ".large-title h1" },
    bind(el) {
      $("#open-settings", el).addEventListener("click", settingsSheet);
      $("#switch-deck", el)?.addEventListener("click", switchDeckSheet);
      $("#show-r0", el)?.addEventListener("click", () => showRule0(d));
      $("#quick-opp", el).addEventListener("click", () => opponentSheet());
      $("#round-start", el)?.addEventListener("click", startSheet);
      $("#status-line", el)?.addEventListener("click", settingsSheet);
      $("#install-hint .x", el)?.addEventListener("click", () => { setPref("installHintDone", true); window.dispatchEvent(new Event("redraw")); });
      $("#install-now", el)?.addEventListener("click", async () => {
        const p = window.installPrompt;
        if (!p) return;
        p.prompt();
        await p.userChoice.catch(() => null);
        window.installPrompt = null;
        setPref("installHintDone", true);
        window.dispatchEvent(new Event("redraw"));
      });
      bindGames(el);
    },
  };
}

// what the user should know about the connection – one quiet line, only when there is something to say
function statusLine() {
  if (isDemo()) return `<button class="status-line" id="status-line" type="button">${icon("cards", "xs")} Vorschau mit Beispieldaten – <u>mit deinem PC verbinden</u></button>`;
  const failed = failedOps().length;
  const pend = pendingCount();
  if (failed) return `<button class="status-line bad" id="status-line" type="button">${icon("alert", "xs")} ${plural(failed, "Eintrag wurde", "Einträge wurden")} nicht übernommen – ansehen</button>`;
  if (!state.online) return `<button class="status-line" id="status-line" type="button">${icon("wifi-off", "xs")} Offline${pend ? ` – ${plural(pend, "Eintrag wartet", "Einträge warten")}, wird später gesendet` : " – du siehst den zuletzt geladenen Stand"}</button>`;
  if (pend) return `<p class="status-line">${icon("clock", "xs")} ${plural(pend, "Eintrag wird", "Einträge werden")} gesendet …</p>`;
  return "";
}

function installHint() {
  if (state.prefs.installHintDone || isDemo() || matchMedia("(display-mode: standalone)").matches || navigator.standalone) return "";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (!ios && !window.installPrompt) return "";
  return `<div class="install-hint" id="install-hint"><img src="/app/icons/icon-192.png" alt="" width="40" height="40">
    <div class="main"><b>Als App auf den Home-Bildschirm</b><span>${ios ? "Teilen → „Zum Home-Bildschirm“. Dann startet „Am Tisch“ wie eine App und deine Einträge bleiben sicher." : "Startet wie eine App und funktioniert auch ohne Netz."}</span>
      ${ios ? "" : `<button class="btn tint" type="button" id="install-now">Installieren</button>`}</div>
    <button class="icon-btn x" type="button" aria-label="Hinweis schließen">${icon("x", "sm")}</button></div>`;
}

// ---------- Rule 0 full screen ----------
export function showRule0(d) {
  const rows = d.rule0.rows.filter((r) => !["Commander", "Stufe"].includes(r.label));
  const html = `<div class="art" data-bg="${esc(d.colors)}">${art(d.commanders[0])}</div>
    <h1>${esc(d.name)}</h1>
    <div class="muted sub">${esc(d.commanders.join(" + "))}</div>
    <span class="level">${esc(d.level)}</span>
    <div class="group r0">${rows.map((r) => `<div class="row${r.flag ? " flagged" : ""}"><span class="main">
      <span class="label">${r.flag ? `${icon("flag", "xs")} ` : ""}${esc(r.label)}</span><span class="value">${esc(r.value)}</span></span></div>`).join("")}</div>
    <p class="ask">Passt das für eure Runde?</p>`;
  present(html, {
    actions: `<button class="btn" type="button" data-share>${icon("share", "sm")}Teilen</button>`,
    bind(el) {
      scry.hydrate(el); paint(el);
      el.querySelector("[data-share]").addEventListener("click", async () => {
        const text = d.rule0.text;
        try {
          if (navigator.share) await navigator.share({ title: `${d.name} – Rule 0`, text });
          else { await navigator.clipboard.writeText(text); toast("Text kopiert", { ok: true }); }
        } catch { /* cancelled */ }
      });
    },
  });
}

// ---------- Decks ----------
export function decks() {
  const list = state.snap.decks;
  const html = `<div class="large-title"><h1>Decks</h1></div>
    ${list.length ? `<div class="group">${list.map((d) => `<a class="row" href="#/decks/${esc(d.slug)}">
        ${thumb(d.commanders[0], d.colors)}
        <span class="main"><span class="title">${esc(d.name)}</span>
          <span class="subtitle">${pips(d.colors)} ${esc(d.level)} · ${esc(recordText(d.record))}</span></span>${icon("chev-r", "sm chev")}</a>`).join("")}</div>`
      : empty("decks", "Noch keine Decks", tabletSized() ? "Leg hier ein neues an – oder baue und importiere Decks am PC, nach dem Abgleich erscheinen sie hier." : "Baue Decks am PC oder auf dem iPad – nach dem Abgleich erscheinen sie hier.")}`;
  return { html, fab: tabletSized() ? { label: "Neues Deck", run: newDeckSheet } : null, bar: { title: "Decks", watch: ".large-title h1" } };
}

const SEGMENTS = [["rule0", "Rule 0"], ["karten", "Karten"], ["partien", "Partien"]];
export const CATS = ["Ramp", "Draw", "Removal", "Board Wipe", "Counterspell", "Tutor", "Protection", "Synergy", "Win Condition", "Utility", "Land"];
export const CAT_LABELS = { Ramp: "Ramp", Draw: "Kartenzug", Removal: "Removal", "Board Wipe": "Board Wipes", Counterspell: "Counterspells",
  Tutor: "Tutoren", Protection: "Schutz", Synergy: "Synergie", "Win Condition": "Siegbedingung", Utility: "Sonstiges", Land: "Länder", "": "Sonstiges" };

export function deck(slug, seg = "rule0") {
  const d = deckBy(slug);
  if (!d) return { html: empty("decks", "Deck nicht gefunden", "Vielleicht wurde es am PC gelöscht."), bar: { title: "Deck", back: { href: "#/decks", label: "Decks" }, always: true } };
  seg = SEGMENTS.some(([k]) => k === seg) ? seg : "rule0";
  const r = d.record;
  const drafts = draftCount(d);
  const html = `
    <div class="detail-hero" data-bg="${esc(d.colors)}">${art(d.commanders[0])}
      <a class="float-back icon-btn glass" href="#/decks" aria-label="Zurück zu Decks">${icon("chev-l")}</a></div>
    <div class="detail-head"><h1>${esc(d.name)}</h1>
      <div class="meta">${pips(d.colors)} <span>${esc(d.level)}</span>${d.proxy ? ` · <span>Proxy-Deck</span>` : ""}${d.checking ? ` · <span>wird am PC geprüft</span>` : d.legal === false ? ` · <span class="flag">nicht legal</span>` : ""}</div>
      ${d.description ? `<p class="sub muted">${esc(d.description)}</p>` : ""}
      <div class="recordbar"><div class="w"><b>${r.wins}</b><span>Siege</span></div><div class="l"><b>${r.losses}</b><span>Niederlagen</span></div>
        <div><b>${r.games ? Math.round((100 * r.wins) / r.games) : 0} %</b><span>${plural(r.games, "Partie", "Partien")}</span></div></div>
      ${!tabletSized() ? "" : drafts ? `<a class="draft-note" href="#/bauen/${esc(d.slug)}">${icon("edit", "sm")}<span class="main"><b>${plural(drafts, "ungespeicherte Änderung", "ungespeicherte Änderungen")}</b>
          <small>Weiterbauen und speichern</small></span>${icon("chev-r", "sm chev")}</a>`
        : `<a class="btn tint build-open" href="#/bauen/${esc(d.slug)}">${icon("edit", "sm")}Deck bauen</a>`}
    </div>
    <div class="seg-sticky"><div class="segmented" role="tablist">${SEGMENTS.map(([k, label]) => `<button type="button" role="tab" data-seg="${k}" aria-pressed="${k === seg}" aria-selected="${k === seg}">${label}</button>`).join("")}</div></div>
    <div id="seg-body">${segment(d, seg)}</div>`;
  return {
    html, bar: { title: d.name, back: { href: "#/decks", label: "Decks" }, watch: ".detail-head h1", action: tabletSized() ? { label: "Bauen", run: () => { location.hash = `#/bauen/${d.slug}`; } } : null },
    bind(el) {
      for (const b of $$("[data-seg]", el)) b.addEventListener("click", () => {
        history.replaceState(history.state, "", `#/decks/${slug}/${b.dataset.seg}`);
        for (const x of $$("[data-seg]", el)) { x.setAttribute("aria-pressed", x === b); x.setAttribute("aria-selected", x === b); }
        $("#seg-body", el).innerHTML = segment(d, b.dataset.seg);
        bindSegment(el, d);
        const top = $(".seg-sticky", el).getBoundingClientRect().top + scrollY - 52 - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top")) || 0);
        if (scrollY > top) scrollTo({ top });
      });
      bindSegment(el, d);
    },
  };
}

function segment(d, seg) {
  if (seg === "rule0") {
    return `<div class="group r0">${d.rule0.rows.filter((r) => r.label !== "Commander").map((r) => `<div class="row${r.flag ? " flagged" : ""}"><span class="main">
      <span class="label">${r.flag ? `${icon("flag", "xs")} ` : ""}${esc(r.label)}</span><span class="value">${esc(r.value)}</span></span></div>`).join("")}</div>
      <div class="btn-col"><button class="btn primary big" type="button" data-r0>${icon("shield", "sm")}Zum Zeigen öffnen</button></div>`;
  }
  if (seg === "karten") {
    const groups = {};
    for (const c of d.cards) (groups[c.category] ||= []).push(c);
    const order = [...CATS, ...Object.keys(groups).filter((k) => !CATS.includes(k))].filter((k) => groups[k]);
    const total = d.cards.reduce((n, c) => n + c.qty, 0) + d.commanders.length;
    const row = (name, qty, sub = "") => `<button class="row" type="button" data-card-open="${esc(name)}">
      <span class="thumb card-thumb">${art(name, "small", "thumb card-thumb")}</span>
      <span class="main"><span class="title">${esc(name)}</span>${sub ? `<span class="subtitle">${esc(sub)}</span>` : ""}</span>${qty > 1 ? `<span class="qty">${qty}×</span>` : ""}</button>`;
    return `<p class="hint-small">${total} Karten · Bilder und Texte von Scryfall, danach auch offline.</p>
      <div class="cat-head"><span>Commander</span></div><div class="group cards-group">${d.commanders.map((c) => row(c, 1)).join("")}</div>
      ${order.map((k) => `<div class="cat-head"><span>${esc(CAT_LABELS[k] || k)}</span><span>${groups[k].reduce((n, c) => n + c.qty, 0)}</span></div>
        <div class="group cards-group">${groups[k].map((c) => row(c.name, c.qty)).join("")}</div>`).join("")}
      ${d.maybe?.length ? `<div class="cat-head maybe-head"><span>${icon("maybe", "xs")}Vielleicht</span><span>${d.maybe.length} · zählt nicht</span></div>
        <div class="group cards-group maybe-group">${d.maybe.map((m) => row(m.name, 1, CAT_LABELS[m.category] || m.category)).join("")}</div>` : ""}`;
  }
  const games = gamesOf(d.slug);
  return games.length ? `<div class="group">${games.map((g) => gameRow(g, { showDeck: false })).join("")}</div>`
    : empty("trophy", "Noch keine Partie mit diesem Deck", "Nach der Partie auf „Tisch“ eintragen.");
}

function bindSegment(el, d) {
  $("[data-r0]", el)?.addEventListener("click", () => showRule0(d));
  for (const b of $$("[data-card-open]", el)) b.addEventListener("click", () => cardSheet(b.dataset.cardOpen));
  bindGames(el);
  scry.hydrate(el); paint(el);
}

// ---------- Gegner ----------
let oppQuery = "";
export function gegner() {
  const all = state.snap.opponents;
  const html = `<div class="large-title"><h1>Gegner</h1></div>
    ${all.length ? `<label class="search"><span class="sr">Gegner suchen</span>${icon("search")}<input class="input" id="opp-q" type="search" placeholder="Name, Spieler oder Commander" value="${esc(oppQuery)}" enterkeyhint="search" autocomplete="off"></label>
      <div class="group" id="opp-list"></div>` : ""}
    ${all.length ? "" : empty("users", "Noch keine Gegnerdecks", "Bringt jemand ein neues Deck mit? Unten auf „Gegnerdeck“ – Commander, Spieler, fertig.")}`;
  return {
    html, fab: { label: "Gegnerdeck", run: () => opponentSheet() },
    bar: { title: "Gegner", watch: ".large-title h1" },
    bind(el) {
      const listEl = $("#opp-list", el);
      if (!listEl) return;
      const draw = () => {
        const q = oppQuery.trim().toLowerCase();
        const hits = all.filter((o) => !q || [oppName(o), o.player, ...(o.commanders || [])].join(" ").toLowerCase().includes(q));
        listEl.innerHTML = hits.map((o) => `<a class="row" href="#/gegner/${esc(o.id)}">${thumb(o.commanders[0], o.colors, "thumb round")}
          <span class="main"><span class="title">${esc(oppName(o))}</span>
          <span class="subtitle">${esc([o.player, o.record.games ? `${o.record.wins}:${o.record.losses} gegen dich` : "noch keine Partie"].filter(Boolean).join(" · "))}</span></span>
          ${icon("chev-r", "sm chev")}</a>`).join("") || `<div class="empty"><p>Kein Gegner passt zu „${esc(oppQuery)}“.</p></div>`;
        listEl.style.setProperty("--row-inset", "70px");
        scry.hydrate(listEl); paint(listEl);
      };
      $("#opp-q", el).addEventListener("input", (e) => { oppQuery = e.target.value; draw(); });
      draw();
    },
  };
}

let editTags = false;
export function opponent(id) {
  const o = oppBy(id);
  if (!o) return { html: empty("users", "Gegner nicht gefunden", "Vielleicht wurde er am PC gelöscht."), bar: { title: "Gegner", back: { href: "#/gegner", label: "Gegner" }, always: true } };
  const r = o.record;
  const tags = state.snap.options.tags;
  const html = `
    <div class="detail-hero" data-bg="${esc(o.colors)}">${art(o.commanders[0])}
      <a class="float-back icon-btn glass" href="#/gegner" aria-label="Zurück zu Gegner">${icon("chev-l")}</a>
      <button class="float-edit" type="button" id="opp-edit">Bearbeiten</button></div>
    <div class="detail-head"><h1>${esc(oppName(o))}</h1>
      <div class="meta">${pips(o.colors)} <span>${esc([oppSub(o), o.bracket ? `Bracket ${o.bracket}` : ""].filter(Boolean).join(" · "))}</span></div>
      <div class="recordbar"><div class="w"><b>${r.wins}</b><span>deine Siege</span></div><div class="l"><b>${r.losses}</b><span>Niederlagen</span></div>
        <div><b>${r.games}</b><span>${r.games === 1 ? "Partie" : "Partien"}</span></div></div>
      ${r.games && r.games < 5 ? `<p class="hint-small">Erst ${plural(r.games, "Partie", "Partien")} – die Bilanz sagt noch wenig.</p>` : ""}
    </div>
    <div class="field-label">Merkmale ${editTags ? `<span class="hint">antippen zum Ändern</span>` : ""}</div>
    <div class="chips" id="opp-tags">${(editTags ? tags : tags.filter(([k]) => o.tags.includes(k))).map(([k, label]) => `<button class="chip" type="button" data-tag="${k}" aria-pressed="${o.tags.includes(k)}">${esc(label)}</button>`).join("")}
      <button class="chip add" type="button" id="edit-tags">${editTags ? "Fertig" : o.tags.length ? `${icon("edit")}Ändern` : `${icon("plus")}Merkmal`}</button></div>
    <div class="field-label">Notizen</div>
    <div id="notes">${(o.notes || []).map((n) => `<div class="note-item">${esc(n.text)}<span class="when">${esc(ago(n.at))}</span></div>`).join("")}</div>
    <button class="chip add" type="button" id="note-open">${icon("plus")}Notiz hinzufügen</button>
    <form id="note-form" class="note-add" hidden><textarea class="textarea" name="text" rows="2" placeholder="Was ist dir aufgefallen?" enterkeyhint="done"></textarea>
      <div class="btn-row-end"><button class="btn plain" type="button" id="note-cancel">Abbrechen</button><button class="btn tint" type="submit">Speichern</button></div></form>
    ${r.per_deck?.length ? `<div class="section-head"><h2>Gegen deine Decks</h2></div><div class="group">${r.per_deck.map((p) => `<a class="row" href="#/decks/${esc(p.slug)}">
      ${thumb(deckBy(p.slug)?.commanders[0] || p.name, deckBy(p.slug)?.colors)}<span class="main"><span class="title">${esc(p.name)}</span>
      <span class="subtitle">${p.wins}:${p.losses} · ${plural(p.games, "Partie", "Partien")}</span></span>${icon("chev-r", "sm chev")}</a>`).join("")}</div>` : ""}`;
  return {
    html, bar: { title: oppName(o), back: { href: "#/gegner", label: "Gegner" }, watch: ".detail-head h1", action: { label: "Bearbeiten", run: () => editOpponentSheet(o.id) } },
    bind(el) {
      $("#opp-edit", el).addEventListener("click", () => editOpponentSheet(o.id));
      $("#edit-tags", el).addEventListener("click", () => { editTags = !editTags; window.dispatchEvent(new Event("redraw")); });
      for (const b of $$("[data-tag]", el)) b.addEventListener("click", () => {
        if (!editTags) { editTags = true; window.dispatchEvent(new Event("redraw")); return; }
        const before = $$("[data-tag][aria-pressed=true]", el).map((x) => x.dataset.tag);
        b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true");
        const now = $$("[data-tag][aria-pressed=true]", el).map((x) => x.dataset.tag);
        op("opponent.update", { id: o.id, tags: now, prev: { tags: before } });
      });
      const noteForm = $("#note-form", el);
      $("#note-open", el).addEventListener("click", (e) => { e.currentTarget.hidden = true; noteForm.hidden = false; noteForm.text.focus(); });
      $("#note-cancel", el).addEventListener("click", () => { noteForm.hidden = true; $("#note-open", el).hidden = false; });
      noteForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = e.target.text.value.trim();
        if (!text) return;
        const entry = op("opponent.note", { id: o.id, note_id: uid().slice(0, 8), text });
        toast("Notiz gespeichert", { ok: true, action: { label: "Rückgängig", run: () => import("./data.js").then((m) => m.undo(entry)) } });
      });
    },
  };
}

// ---------- Karten ----------
let cardQuery = "";
// "Beschreiben": the description, colour identity and types; the last answer stays while the app runs
const desc = { text: "", colors: [], types: [], result: null, busy: false, error: null };
const DESC_COLORS = [["W", "Weiß"], ["U", "Blau"], ["B", "Schwarz"], ["R", "Rot"], ["G", "Grün"], ["C", "Farblos"]];
const DESC_TYPES = [["creature", "Kreatur"], ["instant", "Spontanzauber"], ["sorcery", "Hexerei"], ["artifact", "Artefakt"],
  ["enchantment", "Verzauberung"], ["planeswalker", "Planeswalker"], ["land", "Land"]];
const SHOW_STEP = 30;

export function karten() {
  const recent = state.prefs.recentCards || [];
  const mode = state.prefs.cardMode === "describe" ? "describe" : "name";
  const html = `<div class="large-title"><h1>Karten</h1></div>
    <div class="segmented card-mode" role="tablist" aria-label="Suchart">
      <button type="button" role="tab" data-mode="name" aria-pressed="${mode === "name"}" aria-selected="${mode === "name"}">${icon("search", "xs")}Name</button>
      <button type="button" role="tab" data-mode="describe" aria-pressed="${mode === "describe"}" aria-selected="${mode === "describe"}">${icon("sparkle", "xs")}Beschreiben</button></div>
    <div id="mode-name" ${mode === "name" ? "" : "hidden"}>
      <label class="search"><span class="sr">Karte suchen</span>${icon("search")}<input class="input" id="card-q" type="search" placeholder="Kartenname, deutsch oder englisch" value="${esc(cardQuery)}" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div id="card-results"></div></div>
    <form id="mode-describe" class="describe" ${mode === "describe" ? "" : "hidden"}>
      <label class="sr" for="desc-text">Was soll die Karte tun?</label>
      <textarea class="textarea" id="desc-text" maxlength="400" enterkeyhint="search" placeholder="Was soll die Karte tun? z. B. „zieht eine Karte, wenn eine meiner Kreaturen stirbt“">${esc(desc.text)}</textarea>
      <div class="field-label">Farbidentität <span class="hint">optional</span></div>
      <div class="chips" id="desc-colors">${DESC_COLORS.map(([c, l]) => `<button class="chip color" type="button" data-color="${c}" aria-pressed="${desc.colors.includes(c)}"><span class="pip ${c}"></span>${l}</button>`).join("")}</div>
      <div class="field-label">Kartentyp <span class="hint">optional</span></div>
      <div class="chips" id="desc-types">${DESC_TYPES.map(([t, l]) => `<button class="chip" type="button" data-type="${t}" aria-pressed="${desc.types.includes(t)}">${l}</button>`).join("")}</div>
      <button class="btn primary big describe-go" type="submit" id="desc-go">${icon("sparkle", "sm")}Karten finden</button>
      <div id="desc-results" aria-live="polite"></div>
    </form>`;
  return {
    html, bar: { title: "Karten", watch: ".large-title h1" },
    bind(el) {
      for (const b of $$("[data-mode]", el)) b.addEventListener("click", () => {
        setPref("cardMode", b.dataset.mode);
        for (const x of $$("[data-mode]", el)) { const on = x === b; x.setAttribute("aria-pressed", on); x.setAttribute("aria-selected", on); }
        $("#mode-name", el).hidden = b.dataset.mode !== "name";
        $("#mode-describe", el).hidden = b.dataset.mode !== "describe";
      });
      bindByName(el, recent);
      bindDescribe(el);
    },
  };
}

const cardRows = (items) => `<div class="group">${items.map((c) => `<button class="row" type="button" data-card-open="${esc(c.name)}">
    <span class="thumb card-thumb">${art(c.name, "small", "thumb card-thumb")}</span><span class="main"><span class="title">${esc(c.de || c.name)}</span>
    <span class="subtitle">${esc(c.de ? c.name : c.type || c.sub || "")}</span></span>${c.cost ? `<span class="trail cost">${mana(c.cost)}</span>` : ""}</button>`).join("")}</div>`;
const bindCardRows = (out) => { for (const b of $$("[data-card-open]:not([data-bound])", out)) { b.dataset.bound = "1"; b.addEventListener("click", () => cardSheet(b.dataset.cardOpen)); } scry.hydrate(out); };

function bindByName(el, recent) {
  const out = $("#card-results", el);
  const own = [...new Set(state.snap.decks.flatMap((d) => [...d.commanders, ...d.cards.map((c) => c.name)]))];
  const idle = () => {
    out.innerHTML = recent.length ? `<div class="section-head"><h2>Zuletzt nachgeschlagen</h2></div>${cardRows(recent.map((n) => ({ name: n, sub: scry.cached(n)?.type || "" })))}`
      : `<p class="hint-small">Tipp: Deutsche und englische Namen gehen, ein Teil des Namens reicht. Karten deiner Decks findest du auch ohne Netz.</p>`;
    bindCardRows(out);
  };
  let seq = 0;
  const run = debounce(async (q) => {
    const mine = ++seq;
    const local = own.filter((n) => n.toLowerCase().includes(q.toLowerCase())).slice(0, 6).map((n) => ({ name: n, sub: "aus deinen Decks" }));
    out.innerHTML = local.length ? `<div class="section-head"><h2>Aus deinen Decks</h2></div>${cardRows(local)}` : "";
    bindCardRows(out);
    try {
      const hits = (await scry.searchCards(q)).filter((c) => !local.some((l) => l.name === c.name));
      if (mine !== seq) return;
      out.innerHTML += hits.length ? `<div class="section-head"><h2>Alle Karten</h2></div>${cardRows(hits)}` : (local.length ? "" : `<div class="empty"><p>Keine Karte gefunden.</p></div>`);
    } catch {
      if (mine === seq) out.innerHTML += `<p class="hint-small">Ohne Netz – nur Karten aus deinen Decks.</p>`;
    }
    out.querySelectorAll("[data-bound]").forEach((b) => b.removeAttribute("data-bound"));
    bindCardRows(out);
  }, 260);
  $("#card-q", el).addEventListener("input", (e) => { cardQuery = e.target.value; if (cardQuery.trim().length < 2) { seq++; idle(); } else run(cardQuery.trim()); });
  if (cardQuery.trim().length >= 2) run(cardQuery.trim()); else idle();
}

function bindDescribe(el) {
  const form = $("#mode-describe", el);
  const text = $("#desc-text", el);
  text.addEventListener("input", () => { desc.text = text.value; });
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  for (const b of $$("[data-color]", el)) b.addEventListener("click", () => {
    const c = b.dataset.color;
    // "Farblos" next to colours adds colourless cards (Sol Ring); alone it means only colourless ones
    desc.colors = desc.colors.includes(c) ? desc.colors.filter((x) => x !== c) : [...desc.colors, c];
    for (const x of $$("[data-color]", el)) x.setAttribute("aria-pressed", desc.colors.includes(x.dataset.color));
  });
  for (const b of $$("[data-type]", el)) b.addEventListener("click", () => {
    const t = b.dataset.type;
    desc.types = desc.types.includes(t) ? desc.types.filter((x) => x !== t) : [...desc.types, t];
    b.setAttribute("aria-pressed", desc.types.includes(t));
  });

  const render = () => {  // looks the box up each time: a redraw of the screen may have replaced it meanwhile
    const out = document.getElementById("desc-results");
    if (!out) return;
    const r = desc.result;
    if (desc.busy) {
      out.innerHTML = `<div class="ai-busy" role="status"><span class="ai-dots" aria-hidden="true"><span></span><span></span><span></span></span>
        <span>${esc(desc.busy)}</span></div>`;
      return;
    }
    if (desc.error) {
      const setup = desc.error.status === 409;
      out.innerHTML = `<div class="empty">${icon(setup ? "sparkle" : "alert")}<h3>${setup ? "Noch nicht eingerichtet" : "Das hat nicht geklappt"}</h3>
        <p>${esc(setup ? "Für die Suche mit KI braucht der Server einmal deinen Claude-API-Schlüssel." : desc.error.message)}</p>
        ${setup ? `<div class="btn-col"><button class="btn primary" type="button" id="ai-setup">Jetzt einrichten</button></div>` : ""}</div>`;
      $("#ai-setup", out)?.addEventListener("click", () => import("./forms.js").then((m) => m.aiSheet({ onSaved: () => { desc.error = null; render(); } })));
      return;
    }
    if (!r) {
      out.innerHTML = `<p class="hint-small">Beschreib die Wirkung mit eigenen Worten, deutsch oder englisch. Die KI übersetzt sie in eine Scryfall-Suche; gefunden werden nur Karten, die in Commander erlaubt sind.</p>`;
      return;
    }
    const shown = r.cards.slice(0, r.show);
    out.innerHTML = `<div class="query-box">
        <div class="query-head"><span>${icon("sparkle", "xs")} ${esc(r.explain || "Scryfall-Suche")}</span>
          <button class="btn plain small" type="button" id="q-edit">${r.editing ? "Fertig" : "Anpassen"}</button></div>
        ${r.editing ? `<input class="input mono" id="q-input" value="${esc(r.used)}" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false">`
          : `<code class="query">${esc(r.used)}</code>`}
        ${r.wider ? `<p class="hint-small">Genau so gab es nichts – das ist die breitere Suche.</p>` : ""}
      </div>
      ${r.total ? `<div class="section-head"><h2>${plural(r.total, "Karte", "Karten")}</h2><span class="hint-small">beliebteste zuerst</span></div>${cardRows(shown)}
        ${r.cards.length > r.show || r.next ? `<div class="btn-col"><button class="btn" type="button" id="q-more">Mehr zeigen</button></div>` : ""}`
        : `<div class="empty">${icon("search")}<h3>Keine Karte gefunden</h3><p>Beschreib es etwas allgemeiner, nimm Farben oder Typ weg – oder pass die Suche oben an.</p></div>`}`;
    bindCardRows(out);
    $("#q-edit", out).addEventListener("click", () => {
      if (r.editing) { const q = $("#q-input", out).value.trim(); r.editing = false; if (q && q !== r.used) return runQuery(q, { wider: false, explain: "Eigene Suche" }); }
      else r.editing = true;
      render();
      if (r.editing) $("#q-input", out).focus();
    });
    $("#q-input", out)?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#q-edit", out).click(); } });
    $("#q-more", out)?.addEventListener("click", async () => {
      if (r.cards.length <= r.show && r.next) {
        try { const page = await scry.searchQuery(r.used, r.next); r.cards.push(...page.cards); r.next = page.next; } catch (e) { toast(e.message); }
      }
      r.show += SHOW_STEP;
      render();
    });
  };

  async function runQuery(query, { wider = false, explain = "", broader = "" } = {}) {
    desc.busy = "Scryfall wird gefragt …"; desc.error = null; render();
    try {
      let page = await scry.searchQuery(query);
      if (!page.total && broader) { page = await scry.searchQuery(broader); query = broader; wider = true; }
      desc.result = { used: query, explain, wider, cards: page.cards, total: page.total, next: page.next, show: SHOW_STEP, editing: false };
    } catch (e) {
      desc.error = e;
    }
    desc.busy = false;
    render();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (desc.busy) return;
    desc.text = text.value;
    if (desc.text.trim().length < 3) { text.focus(); toast("Beschreib kurz, was die Karte tun soll."); return; }
    text.blur();
    desc.busy = "Die KI übersetzt deine Beschreibung …"; desc.error = null; render();
    const reveal = () => document.getElementById("desc-results")?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    reveal();
    let got;
    try {
      got = await serverCall("/api/app/cards/describe", { method: "POST", body: { text: desc.text.trim(), colors: desc.colors, types: desc.types }, timeout: 60000 });
      await runQuery(got.query, { explain: got.explain, broader: got.broader });
    } catch (err) {
      desc.busy = false; desc.error = err; render();
    }
    reveal();
  });
  render();
}

// colour backgrounds while artwork loads (CSSOM, so no inline styles are needed in the markup)
export function paint(root) {
  for (const el of root.querySelectorAll("[data-bg]")) if (!el.style.background) el.style.background = artFallback(el.dataset.bg);
}

export function rememberCard(name) {
  const list = [name, ...(state.prefs.recentCards || []).filter((n) => n !== name)].slice(0, 12);
  setPref("recentCards", list);
}
