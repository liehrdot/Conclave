"use strict";
// The desktop GUI, part 10 of 21: the deck check (table rule, target power) and Rule 0.
// index.html loads the parts in order; they share one global scope.

function retuneTarget() {
  const form = $("#retune-form");
  return {
    bracket: Number(form.querySelector('[name="rbracket"]:checked')?.value || currentDeck?.bracket || 3),
    tier: form.querySelector('[name="tier"]:checked')?.value || null,
  };
}

function stepTarget(direction) {
  let { bracket, tier } = retuneTarget();
  let idx = bracket * 3 + TIER_ORDER.indexOf(tier || "mid") + direction;
  idx = Math.min(Math.max(idx, 3), 17);
  bracket = Math.floor(idx / 3);
  tier = TIER_ORDER[idx % 3];
  $("#retune-form").querySelector(`[name="rbracket"][value="${bracket}"]`).checked = true;
  $("#retune-form").querySelector(`[name="tier"][value="${tier}"]`).checked = true;
  renderPower(currentDeck);
}
$("#step-up").addEventListener("click", () => stepTarget(+1));
$("#step-down").addEventListener("click", () => stepTarget(-1));
$("#retune-form").addEventListener("change", () => renderPower(currentDeck));

function profileSnapshot(p) {
  p = p || {};
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    tier: p.tier || null,
    max_game_changers: num(p.max_game_changers),
    max_tutors: num(p.max_tutors),
    allow_two_card_combos: p.allow_two_card_combos === false ? false : null,
    allow_extra_turns: p.allow_extra_turns === false ? false : null,
    allow_mass_land_denial: p.allow_mass_land_denial === false ? false : null,
    style: (p.style || "").trim(),
  };
}

function targetDirty(d) {
  if (!d || !$("#retune-form").querySelector('[name="rbracket"]')) return false;
  const bracket = Number($("#retune-form").querySelector('[name="rbracket"]:checked')?.value || d.bracket || 3);
  if (bracket !== (d.bracket || 3)) return true;
  const form = profileSnapshot(readProfile($("#retune-form .profile-fields")) || {});
  return JSON.stringify(form) !== JSON.stringify(profileSnapshot(d.power_profile));
}

function syncSaveButtons() {
  const dirty = targetDirty(currentDeck);
  const edits = !!(edit && editChanges());
  const retune = $("#retune-btn");
  retune.hidden = !dirty;
  retune.classList.toggle("primary", dirty && !edits);
  $("#edit-save").classList.toggle("primary", edits);
}

function renderPower(d) {
  if (!d) return;
  const power = d.validation?.bracket?.power;
  const { bracket, tier } = retuneTarget();
  const goal = bracket + TIER_CENTER[tier || "mid"];
  const pos = (v) => `${((Math.min(Math.max(v, 1), 5.99) - 1) / 5) * 100}%`;
  $("#power-scale").innerHTML = `<div class="track"></div>
    ${[2, 3, 4, 5].map((b) => `<span class="sep" style="left:${pos(b)}"></span>`).join("")}
    ${[1, 2, 3, 4, 5].map((b) => `<span class="tick" style="left:${pos(b + 0.5)}" title="Bracket ${b}">${b}</span>`).join("")}
    ${power ? `<div class="mark now" style="left:${pos(power.value)}" title="Aktuell ${power.value}"></div>` : ""}
    <div class="mark goal" style="left:${pos(goal)}" title="Ziel"></div>`;
  const changed = targetDirty(d);
  $("#power-text").innerHTML = (power
    ? `<span class="legend-bar"></span> Aktuell: <b>${esc(fmtPower(power.value))}</b> · ${esc(power.text)}
       <details class="more"><summary>Wie kommt der Wert zustande?</summary>${esc(power.components.map((c) => `${c.reason} ${c.points > 0 ? "+" : ""}${c.points}`).join(", "))}${power.floor_from_rules ? ` – durch die Regeln mindestens Bracket ${power.floor_from_rules}` : ""}</details>`
    : "Noch keine Power-Einschätzung – „⋯ → Neu prüfen“.<br>")
    + `<span class="legend-dot"></span> Ziel: <b>${esc(levelText(bracket, tier))}</b>${changed ? " – mit „Ziel speichern“ übernehmen" : ""}`;
  syncSaveButtons();
}

// Tempo from the total mana value (speed.py): slow on the left, fast on the right, like the power scale.
function renderSpeed(d) {
  const sp = d?.speed;
  $("#deck-speed").hidden = !sp;
  if (!sp) return;
  const [lo, hi] = sp.scale;
  const pos = (v) => `${((hi - Math.min(Math.max(v, lo), hi)) / (hi - lo)) * 100}%`;
  const bounds = sp.tiers.map((t) => t.max).filter((m) => m != null);
  const eff = sp.effective ?? sp.total;
  const cheaper = eff !== sp.total;
  $("#speed-label").textContent = `${sp.label} · ${eff}`;
  const scale = $("#speed-scale");
  scale.setAttribute("aria-label", `Gesamt-Manawert ${sp.total}${cheaper ? `, effektiv ${eff}` : ""}: ${sp.label}`);
  scale.innerHTML = `<div class="track"></div>
    ${bounds.map((b) => `<span class="sep" style="left:${pos(b)}"></span><span class="tick" style="left:${pos(b)}">${b}</span>`).join("")}
    <span class="tick name lo">langsam</span><span class="tick name hi">schnell</span>
    ${cheaper ? `<div class="mark raw" style="left:${pos(sp.total)}" title="Gedruckt ${sp.total}"></div>` : ""}
    <div class="mark now" style="left:${pos(eff)}" title="Effektiv ${eff}"></div>`;
  const avg = sp.average ? ` (Ø ${fmtNum(sp.average)} je Nicht-Land-Karte)` : "";
  const li = (items) => `<ul class="speed-list">${items.map((t) => `<li>${t}</li>`).join("")}</ul>`;
  const discounts = (sp.discounts || []).map((x) => `<b>${esc(x.name)}</b>: ${fmtNum(x.before)} → ${fmtNum(x.after)} – ${esc(x.why)}`);
  const reducers = (sp.reducers || []).map((r) => `<b>${esc(r.name)}</b> macht ${esc(r.what)} um ${r.amount} billiger: −${fmtNum(r.saved)} an ${r.cards} ${r.cards === 1 ? "Karte" : "Karten"}`);
  $("#speed-text").innerHTML = `${cheaper ? `<span class="muted">Gedruckt ${sp.total}, effektiv ${eff}.</span> ` : ""}${esc(sp.text)}
    <details class="more"><summary>Wie kommt der Wert zustande?</summary>
      Alle Manawerte des Decks zusammengezählt${esc(avg)}: Commander mit, Länder zählen 0, X zählt 0, doppelseitige Karten zählen ihre Vorderseite.
      Je kleiner die Summe, desto früher liegt das Deck auf dem Tisch. Grenzen: ${sp.tiers.map((t) => `${esc(t.label)} ${t.max == null ? `über ${bounds[bounds.length - 1]}` : `bis ${t.max}`}`).join(" · ")}.
      ${discounts.length ? `<br><b>Werden selbst günstiger</b>${li(discounts)}` : ""}
      ${reducers.length ? `<b>Machen andere Karten günstiger</b> (nie unter die farbigen Symbole)${li(reducers)}` : ""}
      ${sp.combo ? `<b>Combo:</b> ${esc(sp.combo.cards.join(" + "))} für zusammen ${fmtNum(sp.combo.mana_value)} Mana${sp.combo_lifted ? " – darum mindestens „Schnell“" : ""}.<br>` : ""}
      ${sp.complete ? "" : `<br><b>Das Deck hat erst ${sp.cards} von 100 Karten</b> – jede weitere Karte macht die Summe größer.`}
      ${sp.exact ? "" : "<br>Ohne Commander geschätzt – „⋯ → Neu prüfen“ rechnet genau."}
    </details>`;
}

$("#retune-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentDeck) return;
  const { bracket } = retuneTarget();
  const profile = readProfile($("#retune-form .profile-fields"));
  const notes = currentDeck.power_profile?.notes;
  const { slug } = currentDeck;
  const btn = $("#retune-btn");
  btn.disabled = true;
  try {
    await api(`/api/decks/${enc(slug)}/target`, { method: "PUT", body: { bracket, profile: profile || notes ? { ...profile, notes: notes || "" } : null } });
    currentDeck = null;
    await refreshDeckList();
    await route();
    toast(`Ziel gespeichert: ${levelText(bracket, profile?.tier)}.`);
  } catch (err) { fail(err); }
  finally { btn.disabled = false; }
});

// ============================================================================================
// Rule 0: one dialog from the deck check, printable as a single sheet
// ============================================================================================
let rule0For = null;
let rule0 = null;
const rule0Rows = (rows) => rows.map((r) => `<dt>${esc(r.label)}</dt><dd${r.flag ? ' class="flag"' : ""}>${esc(r.value)}</dd>`).join("");

async function loadRule0() {
  const slug = currentDeck.slug;
  rule0For = slug;
  try {
    const r = await api(`/api/decks/${enc(slug)}/rule0`);
    if (currentDeck?.slug !== slug) return;
    rule0 = r;
    $("#rule0-full-title").textContent = r.title;
    $("#rule0-full-rows").innerHTML = rule0Rows(r.rows);
    renderSheetTitle(currentDeck);
  } catch (err) {
    rule0For = null;
    rule0 = null;
    $("#rule0-full-rows").innerHTML = `<p class="empty-inline">${esc(err.message)}</p>`;
  }
}
async function openRule0() {
  if (!currentDeck) return;
  const dlg = $("#rule0-full");
  if (!dlg.open) dlg.showModal();
  if (rule0For !== currentDeck.slug || !rule0) {
    $("#rule0-full-title").textContent = "Rule 0";
    $("#rule0-full-rows").innerHTML = `<p class="empty-inline">Lade …</p>`;
    await loadRule0();
  }
}
$("#rule0-open").addEventListener("click", () => openRule0());
$("#rule0-copy").addEventListener("click", async () => {
  if (!rule0) return;
  try { await navigator.clipboard.writeText(rule0.text); toast("Rule-0-Text kopiert."); }
  catch { toast("Kopieren nicht möglich – markiere den Text von Hand.", "error"); }
});
function printRule0() {
  if (!rule0) return;
  document.body.classList.add("print-rule0");
  window.print();
}
window.addEventListener("afterprint", () => document.body.classList.remove("print-rule0"));
$("#rule0-print").addEventListener("click", printRule0);
$("#rule0-full-close").addEventListener("click", () => $("#rule0-full").close());

function renderSheetTitle(d) { $("#sheet-title").textContent = `${d.name} · ${d.commanders.join(" + ")}`; }
