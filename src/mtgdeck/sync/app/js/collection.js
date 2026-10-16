// The Sammlung tab: the collection from the PC (one entry per printing), searchable and filterable, with a sheet per
// card to change quantities, original/proxy and foil. New cards come in through the scanner (scan.js).

import { op, setPref, state, undo } from "./data.js";
import { LANG_NAMES, addByName, fmtEur, scanner, searchSheet } from "./scan.js";
import * as scry from "./scry.js";
import { closeSheet, openSheet, redraw, toast } from "./ui.js";
import { $, $$, debounce, esc, icon } from "./util.js";

const FILTERS = [["all", "Alle"], ["real", "Original"], ["proxy", "Proxy"], ["foil", "Foil"]];
const STEP = 120;
let query = "";
let shown = STEP;

const items = () => state.snap?.collection || [];
const matches = (e, f) => f === "all" || (f === "real" && !e.proxy) || (f === "proxy" && e.proxy) || (f === "foil" && e.foil);
const img = (e, size = "small") => scry.entryImage(e, size);
const sum = (list, pick = () => true) => list.filter(pick).reduce((n, e) => n + e.qty, 0);

function groups(filter) {
  const q = query.trim().toLowerCase();
  const out = new Map();
  for (const e of items()) {
    if (!matches(e, filter) || (q && !e.name.toLowerCase().includes(q) && !(e.set || "").startsWith(q))) continue;
    if (!out.has(e.name)) out.set(e.name, []);
    out.get(e.name).push(e);
  }
  return [...out.entries()];
}

const badges = (e) => [e.proxy ? "Proxy" : "", e.foil ? "Foil" : "", e.lang && e.lang !== "en" ? e.lang.toUpperCase() : ""].filter(Boolean);
const printLine = (e) => [e.set ? `${e.set.toUpperCase()}${e.collector_number ? ` #${e.collector_number}` : ""}` : "", ...badges(e)].filter(Boolean).join(" · ");

export function sammlung() {
  const filter = FILTERS.some(([k]) => k === state.prefs.collFilter) ? state.prefs.collFilter : "all";
  const all = items();
  const list = groups(filter);
  const total = sum(all), proxies = sum(all, (e) => e.proxy), foils = sum(all, (e) => e.foil);
  const value = all.filter((e) => !e.proxy).reduce((v, e) => v + (Number(e.price_eur) || 0) * e.qty, 0);
  const html = `<div class="large-title"><h1>Sammlung</h1></div>
    ${all.length ? `<div class="coll-sum">
        <div><b>${total.toLocaleString("de-DE")}</b><span>${total === 1 ? "Karte" : "Karten"}</span></div>
        <div><b>${(total - proxies).toLocaleString("de-DE")}</b><span>Original</span></div>
        <div><b>${proxies.toLocaleString("de-DE")}</b><span>Proxy</span></div>
        <div><b>${value >= 1000 ? `${Math.round(value).toLocaleString("de-DE")} €` : esc(fmtEur(value))}</b><span>Wert</span></div>
      </div>
      <label class="search"><span class="sr">In der Sammlung suchen</span>${icon("search")}<input class="input" id="coll-q" type="search" placeholder="In der Sammlung suchen" value="${esc(query)}" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div class="chips coll-filter" role="radiogroup" aria-label="Zeigen">${FILTERS.map(([k, l]) => `<button class="chip" type="button" role="radio" data-filter="${k}" aria-pressed="${filter === k}" aria-checked="${filter === k}">${l}${k === "foil" && foils ? ` <span class="n">${foils}</span>` : ""}</button>`).join("")}</div>
      <div id="coll-list">${listHtml(list)}</div>`
    : `<div class="empty">${icon("box")}<h3>Noch keine Karten in der Sammlung</h3>
        <p>Scanne eine Karte mit der Kamera – oder pflege die Sammlung am PC, sie kommt beim nächsten Abgleich hierher.</p>
        <div class="btn-col"><button class="btn tint" type="button" id="coll-type">${icon("search", "sm")}Name eingeben</button></div></div>`}`;
  return {
    html, fab: { label: "Karte scannen", icon: "camera", run: scanner },
    bar: { title: "Sammlung", watch: ".large-title h1" },
    bind(el) {
      $("#coll-type", el)?.addEventListener("click", () => searchSheet());
      for (const b of $$("[data-filter]", el)) b.addEventListener("click", () => {
        setPref("collFilter", b.dataset.filter);
        shown = STEP;
        for (const x of $$("[data-filter]", el)) { x.setAttribute("aria-pressed", x === b); x.setAttribute("aria-checked", x === b); }
        fill(el, b.dataset.filter);
      });
      const input = $("#coll-q", el);
      input?.addEventListener("input", debounce(() => { query = input.value; shown = STEP; fill(el, state.prefs.collFilter || "all"); }, 150));
      bindList(el);
    },
  };
}

function listHtml(list) {
  if (!list.length) return `<div class="empty"><p>${query.trim() ? "Keine Karte passt zur Suche." : "Hier ist gerade nichts."}</p></div>`;
  return `<div class="group">${list.slice(0, shown).map(([name, entries]) => {
    const n = sum(entries);
    const one = entries.length === 1 ? entries[0] : null;
    const sub = one ? printLine(one) : `${entries.length} Einträge · ${[sum(entries, (e) => e.proxy) ? `${sum(entries, (e) => e.proxy)} Proxy` : "", sum(entries, (e) => e.foil) ? `${sum(entries, (e) => e.foil)} Foil` : ""].filter(Boolean).join(" · ") || "verschiedene Ausgaben"}`;
    const pic = img(entries.find((e) => img(e)) || {});
    return `<button class="row coll-row" type="button" data-coll="${esc(name)}">
      <span class="thumb card-thumb">${pic ? `<img src="${esc(pic)}" alt="" loading="lazy" crossorigin="anonymous">` : ""}</span>
      <span class="main"><span class="title">${esc(name)}</span><span class="subtitle">${esc(sub)}</span></span>
      <span class="trail qty">${n}×</span></button>`;
  }).join("")}</div>
  ${list.length > shown ? `<div class="btn-col"><button class="btn" type="button" id="coll-more">Mehr zeigen (${list.length - shown} weitere)</button></div>` : ""}`;
}

function fill(el, filter) {
  const box = $("#coll-list", el);
  if (!box) return;
  box.innerHTML = listHtml(groups(filter));
  bindList(el);
}

function bindList(el) {
  for (const b of $$("[data-coll]", el)) b.addEventListener("click", () => entrySheet(b.dataset.coll));
  $("#coll-more", el)?.addEventListener("click", () => { shown += STEP; fill(el, state.prefs.collFilter || "all"); });
}

// ---------- one card: its entries ----------
function entrySheet(name) {
  const pending = new Map();  // entry id → {qty, prev} waiting to be sent (taps on a stepper add up)
  const send = debounce(() => {
    for (const [id, { qty, prev }] of pending) {
      if (qty !== prev) op("collection.update", { id, qty, prev: { qty: prev } });
    }
    pending.clear();
  }, 700);
  const entries = () => items().filter((e) => e.name === name);
  const qtyOf = (e) => pending.get(e.id)?.qty ?? e.qty;
  const page = () => {
    const list = entries();
    const big = img(list.find((e) => img(e)) || {}, "normal");
    return {
      title: name, left: "", right: `<button class="btn plain" type="button" data-sheet-close><b>Fertig</b></button>`,
      body: `${big ? `<div class="card-image small-card"><img src="${esc(big)}" alt="${esc(name)}"></div>` : ""}
        ${list.length ? `<div class="field-label">In deiner Sammlung</div>
        <div class="group">${list.map((e) => `<div class="row entry-row" data-entry="${esc(e.id)}">
            <span class="main"><span class="title">${esc(e.set_name || (e.set ? e.set.toUpperCase() : "Ohne Ausgabe"))}</span>
              <span class="subtitle">${esc([e.set ? `${e.set.toUpperCase()}${e.collector_number ? ` #${e.collector_number}` : ""}` : "", LANG_NAMES[e.lang] || e.lang, e.price_eur && !e.proxy ? fmtEur(e.price_eur) : ""].filter(Boolean).join(" · "))}</span>
              <span class="entry-flags">
                <button class="chip small" type="button" data-flag="proxy" aria-pressed="${e.proxy}">${e.proxy ? "Proxy" : "Original"}</button>
                <button class="chip small" type="button" data-flag="foil" aria-pressed="${e.foil}">Foil</button>
              </span></span>
            <div class="stepper"><button type="button" data-step="-1" aria-label="Eine weniger">${qtyOf(e) > 1 ? "−" : icon("trash", "xs")}</button><output>${qtyOf(e)}</output><button type="button" data-step="1" aria-label="Eine mehr">+</button></div>
          </div>`).join("")}</div>`
        : `<div class="empty"><p>Nicht mehr in deiner Sammlung.</p></div>`}`,
      foot: `<button class="btn big" type="button" id="entry-add">${icon("plus", "sm")}Noch eine hinzufügen</button>`,
      bind(el) {
        for (const row of $$("[data-entry]", el)) {
          const e = list.find((x) => x.id === row.dataset.entry);
          for (const b of $$("[data-step]", row)) b.addEventListener("click", () => {
            const next = qtyOf(e) + Number(b.dataset.step);
            if (next <= 0) {  // the last copy: the entry goes, with "Rückgängig"
              pending.delete(e.id);
              const { id, ...rest } = e;
              const sent = op("collection.update", { id, qty: 0, restore: { ...rest, id, image: rest.image || undefined } });
              toast(`${name} entfernt`, { sub: printLine(e), action: { label: "Rückgängig", run: () => undo(sent) } });
              if (!entries().length) closeSheet(); else redraw();
              return;
            }
            pending.set(e.id, { qty: Math.min(9999, next), prev: pending.get(e.id)?.prev ?? e.qty });
            redraw();
            send();
          });
          for (const b of $$("[data-flag]", row)) b.addEventListener("click", () => {
            const k = b.dataset.flag;
            op("collection.update", { id: e.id, [k]: !e[k], prev: { [k]: e[k] } });
            redraw();
          });
        }
        $("#entry-add", el).addEventListener("click", () => addByName(name));
      },
    };
  };
  openSheet(page);
}
