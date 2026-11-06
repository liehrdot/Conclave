"use strict";
// The desktop GUI, part 5 of 21: the deck view: head, tabs and loading a deck.
// index.html loads the parts in order; they share one global scope.

// ============================================================================================
// deck view
// ============================================================================================
let printLoadedFor = null;

async function openDeck(slug) {
  let d;
  try { d = await api(`/api/decks/${enc(slug)}`); }
  catch (err) { toast(`Deck „${slug}“ nicht gefunden.`, "error"); go("#/new"); return false; }
  if (edit && edit.slug !== d.slug) {
    if (editChanges()) toast("Ungespeicherte Kartenänderungen wurden verworfen.", "error");
    edit = null;
    $("#edit-toggle").setAttribute("aria-pressed", "false");
    $("#edit-toggle span").textContent = "Bearbeiten";
    $("#add-card-form").hidden = true;
  }
  currentDeck = d;
  store.set("lastdeck", d.slug);
  if (ownership && ownership.slug !== d.slug) ownership = null;
  printLoadedFor = null;
  rule0For = null;
  renderDeckHead(d);
  renderDeckTable(d);
  renderValidation(d.validation);
  renderHealth(d);
  renderStats(d.validation?.stats, d.validation);
  renderCards(d);
  $("#retune-form").querySelector(`[name="rbracket"][value="${d.bracket || 3}"]`).checked = true;
  setProfile($("#retune-form .profile-fields"), d.power_profile);
  renderPower(d);
  renderSpeed(d);
  void renderHistory(d);
  renderSheetTitle(d);
  void loadGames(d);
  void loadOwnership(d);
  void loadTokens(d);
  resetHand();
  renderOdds(d);
  $("#deck-menu").open = false;
  return true;
}

function deckFacts(d) {
  const v = d.validation || {};
  const cur = (d.currency || "eur").toUpperCase();
  const bits = [];
  const val = deckValue(d);
  if (d.proxy) bits.push("Proxy");
  else if (val) bits.push(`Wert ${fmtPrice(val.total, cur)}${d.budget ? ` / ${fmtPrice(d.budget, cur)}` : ""}`);
  else if (v.price_total != null) bits.push(`${fmtPrice(v.price_total, cur)}${d.budget ? ` / ${fmtPrice(d.budget, cur)}` : ""}`);
  if (d.speed) bits.push(`Tempo: ${d.speed.label}`);
  if (d.version) bits.push(`v${d.version}`);
  if (d.power_profile?.style) bits.push(d.power_profile.style);
  return bits.filter(Boolean).join(" · ");
}

// One sentence for the head, the check and the sticky line. Table-rule card names stay at the select.
function deckVerdict(d) {
  const v = d?.validation;
  if (!v) return { text: "Noch nicht geprüft", cls: "" };
  const br = v.bracket || {};
  const goal = br.target_text || levelText(d.bracket ?? "?", d.power_profile?.tier);
  let text, cls = "";
  if (v.legal === false) { text = "Nicht legal"; cls = "bad"; }
  else if (br.compliant === false) { text = "Legal, Ziel verfehlt"; cls = "warn"; }
  else text = `Legal, passt zu ${goal}`;
  const table = v.table_rule;
  if (table && table.compliant === false && table.name) {
    text += ` · Tischregel „${table.name}“ verletzt`;
    cls = "bad";
  }
  return { text, cls };
}

// Legal and on bracket: a green check and the bracket number. Otherwise the verdict sentence stays.
function deckFits(d) {
  const v = d?.validation;
  if (!v || v.legal !== true || d.bracket == null) return false;
  if ((v.bracket || {}).compliant === false) return false;
  const table = v.table_rule;
  return !(table && table.compliant === false);
}

function deckMark(bracket) {
  const label = `Legal, Bracket ${bracket}`;
  return `<span class="deck-mark" title="${esc(label)}">${icon("check")}<span class="num">${esc(bracket)}</span><span class="sr-only">${esc(label)}</span></span>`;
}

function renderDeckHead(d) {
  const fits = deckFits(d);
  $("#deck-name").innerHTML = `${esc(d.name)}${fits ? deckMark(d.bracket) : ""}`;
  const thumb = shownCopy(d.commanders[0])?.image || d.card_data?.[d.commanders[0]]?.image;
  $("#deck-thumb").hidden = !thumb;
  if (thumb) $("#deck-thumb").src = thumb;
  $("#deck-commanders").textContent = d.commanders.join(" + ");
  $("#deck-facts").textContent = deckFacts(d);
  $("#deck-facts").title = deckValueTip(d);
  const verdict = deckVerdict(d);
  const line = $("#deck-verdict");
  line.hidden = fits;
  line.textContent = fits ? "" : verdict.text;
  line.className = `verdict${verdict.cls ? ` ${verdict.cls}` : ""}`;
  const desc = (d.description || "").startsWith("Vorgefertigtes Commander-Deck") ? "" : (d.description || "");
  $("#deck-desc").textContent = desc;
  $("#deck-desc").hidden = !desc;
  const against = d.built_against_info || [];
  $("#deck-against").hidden = !against.length;
  $("#deck-against").innerHTML = against.length ? `${icon("swords")} Gebaut gegen ${against.map((o) => `<a href="#/opponents/${enc(o.id)}">${esc(o.title)}</a>`).join(", ")}` : "";
  $("#export-txt").href = `/api/decks/${enc(d.slug)}/export/text`;
  renderDeckFlags(d);
  renderDeckStatus(d);
}

function renderDeckStatus(d) {
  const verdict = deckVerdict(d);
  $("#deck-status-text").textContent = `${verdict.text} · Zum Deck-Check`;
  $("#deck-status").classList.toggle("bad", verdict.cls === "bad");
  $("#deck-status").classList.toggle("warn", verdict.cls === "warn");
}
$("#deck-status").addEventListener("click", () => $("#check-panel").scrollIntoView({ behavior: "smooth", block: "start" }));

// tabs (WAI-ARIA APG pattern: arrow keys move between tabs)
function selectTab(tab, updateHash = true, focus = false) {
  const legacy = tab === "anpassen" ? "target" : tab === "anleitung" ? "rule0" : null;
  if (!TABS.includes(tab)) tab = "karten";
  for (const t of $$("#deck-tabs [role=tab]")) {
    const on = t.dataset.tab === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  }
  for (const p of $$("#view-deck [role=tabpanel]")) p.hidden = p.id !== `panel-${tab}`;
  if ((updateHash || legacy) && currentDeck) history.replaceState(null, "", `#/deck/${enc(currentDeck.slug)}/${tab}`);
  if (tab === "drucken") mountPrintStudio("#panel-drucken");
  if (tab === "drucken" && currentDeck && printLoadedFor !== currentDeck.slug) {
    printLoadedFor = currentDeck.slug;
    void loadPlan();
  }
  if (legacy === "target") requestAnimationFrame(() => $("#deck-target").scrollIntoView({ behavior: "smooth", block: "start" }));
  if (legacy === "rule0") void openRule0();
}
$("#deck-tabs").addEventListener("click", (e) => {
  const t = e.target.closest("[role=tab]");
  if (t) selectTab(t.dataset.tab);
});
$("#deck-tabs").addEventListener("keydown", (e) => {
  const i = TABS.indexOf(document.activeElement?.dataset?.tab);
  if (i < 0) return;
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectTab(TABS[(next + TABS.length) % TABS.length], true, true);
});

// overflow menu: closes on outside click, item click and Esc
document.addEventListener("click", (e) => {
  for (const m of $$("details.menu[open]")) if (!m.contains(e.target)) m.open = false;
});
$("#deck-menu").addEventListener("click", (e) => { if (e.target.closest(".menu-list button, .menu-list a")) $("#deck-menu").open = false; });
$("#deck-menu").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("#deck-menu").open = false; $("#deck-menu summary").focus(); }
});

function renderValidation(v) {
  const box = $("#validation");
  if (!v) { box.innerHTML = '<p class="muted">Noch nicht geprüft – „⋯ → Neu prüfen“.</p>'; return; }
  const br = v.bracket || {};
  const table = v.table_rule || {};
  const skip = new Set([...(table.violations || []), ...(table.warnings || [])]);
  const issues = [...(v.errors || []).map((t) => ["bad", t]), ...(br.violations || []).map((t) => ["warn", t]), ...(v.warnings || []).map((t) => ["warn", t])]
    .filter(([, t]) => !skip.has(t));
  const li = ([cls, t]) => `<li class="${cls}">${esc(t)}</li>`;
  const shown = issues.slice(0, 4), rest = issues.slice(4);
  const list = (items) => (items.length ? `<ul class="issues">${items.map(li).join("")}</ul>` : "");
  const kv = (label, items) => `<dt>${label}</dt><dd>${esc(items.length ? items.join(", ") : "–")}</dd>`;
  const verdict = deckVerdict(currentDeck);
  box.innerHTML = `
    <p class="verdict${verdict.cls ? ` ${verdict.cls}` : ""}">${esc(verdict.text)}</p>
    ${br.estimated ? `<p class="muted small">Commander Spellbook schätzt Bracket ${esc(br.estimated)}.</p>` : ""}
    ${list(shown)}
    ${rest.length ? `<details class="more"><summary>${rest.length} weitere Hinweise</summary>${list(rest)}</details>` : ""}
    <details class="more"><summary>Bracket-Details</summary>
      <dl class="kv">
        ${kv("Game Changer", br.game_changers || [])}
        ${kv("2-Karten-Combos", (br.two_card_combos || []).map((c) => c.cards.join(" + ")))}
        ${kv("Extra-Züge", br.extra_turns || [])}
        ${kv("Massen-Landzerstörung", br.mass_land_denial || [])}
        ${kv("Tutoren", br.tutors || [])}
      </dl>
    </details>`;
}

const ROLE_LABELS = { ramp: "Ramp", card_draw: "Kartenzug", removal: "Removal", board_wipe: "Board Wipes",
  tutor: "Tutoren", extra_turn: "Extra-Züge", counterspell: "Counter", protection: "Schutz" };

function renderStats(s, v = {}) {
  const box = $("#stats");
  if (!s) { box.innerHTML = '<p class="muted">Keine Statistik.</p>'; return; }
  const curve = s.mana_curve || {};
  const max = Math.max(1, ...Object.values(curve));
  const keys = ["0", "1", "2", "3", "4", "5", "6", "7+"];
  const priceKey = Object.keys(s).find((k) => k.startsWith("total_price_"));
  const cur = priceKey ? priceKey.replace("total_price_", "").toUpperCase() : "";
  box.innerHTML = `
    <div class="curve" role="img" aria-label="Manakurve: ${keys.map((k) => `${k}: ${curve[k] || 0}`).join(", ")}">
      ${keys.map((k) => `<div><span>${curve[k] || 0}</span><div class="bar" style="height:${((curve[k] || 0) / max) * 78}%"></div><span>${k}</span></div>`).join("")}</div>
    <dl class="kv">
      <dt>Karten</dt><dd>${s.card_count}</dd>
      <dt>Ø Manawert</dt><dd>${s.avg_cmc_nonland}</dd>
      ${s.total_mana_value != null ? `<dt>Gesamt-Manawert</dt><dd>${fmtNum(s.total_mana_value)}</dd>` : ""}
      <dt>Typen</dt><dd>${esc(Object.entries(s.types || {}).map(([k, n]) => `${k} ${n}`).join(" · "))}</dd>
      <dt>Rollen</dt><dd>${esc(Object.entries(s.role_counts || {}).map(([k, n]) => `${ROLE_LABELS[k] || k} ${n}`).join(" · "))}</dd>
      <dt>Preis</dt><dd>${priceKey ? `${esc(v.price_total ?? s[priceKey])} ${cur}` : "–"}${v.proxy ? " · Proxy" : v.budget ? ` <span class="muted">/ Budget ${esc(v.budget)}</span>` : ""}</dd>
    </dl>`;
}
