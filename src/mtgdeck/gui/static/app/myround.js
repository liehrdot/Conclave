"use strict";
// The desktop GUI, part 16 of 21: „Meine Runde“: blacklist, opponent decks and table rules.
// index.html loads the parts in order; they share one global scope.

// ============================================================================================
// blacklist
// ============================================================================================
async function refreshBlacklist() {
  const bl = await api("/api/blacklist").catch(() => ({ cards: [], rules: [], catalog: [] }));
  const active = new Set(bl.rules.map((r) => r.rule));
  $("#bl-count").textContent = bl.cards.length + bl.rules.length || "";
  $("#bl-empty").hidden = bl.cards.length > 0;
  $("#bl-list").innerHTML = bl.cards.map((n) => `<li>${esc(n)}<button type="button" title="Entfernen" aria-label="${esc(n)} entfernen" data-name="${esc(n)}">×</button></li>`).join("");
  $("#bl-rules-empty").hidden = bl.rules.length > 0;
  $("#bl-rules").innerHTML = bl.rules.map((r) => `<li>
      <div class="bl-rule-main">
        <strong>${esc(r.label)}</strong>
        <span class="pill ${r.checked ? "ok" : "accent"}">${r.checked ? "wird geprüft" : "Notiz"}</span>
        <p class="muted small">${esc(r.description)}</p>
        ${r.cards ? `<details class="more"><summary>${r.cards.length} Karten</summary><p class="small">${r.cards.map(esc).join(" · ")}</p></details>` : ""}
      </div>
      <button type="button" class="btn ghost small" data-name="${esc(r.rule)}" aria-label="${esc(r.label)} entfernen">Entfernen</button>
    </li>`).join("");
  const hasPrice = bl.rules.some((r) => r.key === "price");
  $("#bl-quick").innerHTML = bl.catalog.filter((c) => !active.has(c.rule))
    .map((c) => `<button type="button" class="chip" data-rule="${esc(c.rule)}" title="${esc(c.description)}">${esc(c.label)}</button>`).join("")
    + (hasPrice ? "" : `<button type="button" class="chip" data-price="1" title="Karten über einem Preis sperren">Teurer als … €</button>`);
}
async function addToBlacklist(add) {
  const r = await api("/api/blacklist", { method: "POST", body: { add } });
  const parts = [];
  if (r.added.length) parts.push(`Karten: ${r.added.join(", ")}`);
  if (r.added_rules.length) parts.push(`Regeln: ${r.added_rules.map((x) => x.label).join(", ")}`);
  $("#bl-msg").textContent = parts.length ? `Hinzugefügt – ${parts.join(" · ")}` : "";
  for (const term of r.not_found) {
    const ok = await ask({ title: `„${term}“ nicht gefunden`, ok: "Als Begriff speichern",
      text: "Das ist weder eine Karte noch ein bekannter Begriff. Als Notiz für dich speichern? Automatisch geprüft wird sie nicht." });
    if (ok) await api("/api/blacklist", { method: "POST", body: { add: [`@${term}`] } }).catch(fail);
  }
  await refreshBlacklist();
}
$("#bl-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("#bl-input").value.trim();
  if (!raw) return;
  const add = raw.split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
  try {
    $("#bl-input").value = "";
    await addToBlacklist(add);
  } catch (err) { $("#bl-msg").textContent = err.message; }
});
$("#bl-quick").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  let rule = btn.dataset.rule;
  if (btn.dataset.price) {
    const v = await ask({ title: "Karten über welchem Preis sperren?", text: "Betrag in Euro (günstigster Druck). Proxy-Decks prüfen ihn genauso.", value: "20", ok: "Sperren" });
    const n = Number.parseFloat(String(v || "").replace(",", "."));
    if (!(n > 0)) return;
    rule = `@price>${n}`;
  }
  await addToBlacklist([rule]).catch(fail);
});
for (const list of ["#bl-list", "#bl-rules"]) {
  $(list).addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-name]");
    if (!btn) return;
    await api("/api/blacklist", { method: "POST", body: { remove: [btn.dataset.name] } }).catch(fail);
    $("#bl-msg").textContent = "";
    void refreshBlacklist();
  });
}

// ============================================================================================
// opponent decks ("Gegnerdecks"): commander + what stood out, linked from the game log
// ============================================================================================
let oppIndex = [];
let oppTags = {};
let currentOpp = null;

async function refreshOpponents() {
  const data = await api("/api/opponents").catch(() => ({ opponents: [], tags: {} }));
  oppIndex = data.opponents;
  oppTags = data.tags;
  $("#opp-count").textContent = oppIndex.length || "";
}

function oppMeta(o) {
  const r = o.record;
  return [o.player && `spielt ${o.player}`, o.bracket && `etwa Bracket ${o.bracket}`,
    r.games ? `deine Bilanz ${r.wins}–${r.losses}${r.draws ? "–" + r.draws : ""} in ${r.games} Partie${r.games === 1 ? "" : "n"}` : "noch keine Partie",
    ...o.tag_labels].filter(Boolean).join(" · ");
}


// game form: quick picks of known opponents
function renderKnownOpps() {
  const box = $("#game-known-opps");
  const top = oppIndex.slice(0, 12);
  box.hidden = !top.length;
  box.innerHTML = top.length ? '<em class="opp-known-label">Zuletzt:</em>' + top.map((o) =>
    `<button type="button" class="chip" data-oid="${esc(o.id)}" title="${esc(oppMeta(o))}">${esc(o.title)}</button>`).join("") : "";
}
$("#game-known-opps").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-oid]");
  if (!b) return;
  const o = oppIndex.find((x) => x.id === b.dataset.oid);
  if (o) addGameOpp(o.commanders[0], o.id);
});

async function showOpponents(id) {
  $("#opp-list-view").hidden = !!id;
  $("#opp-view").hidden = !id;
  await refreshOpponents();
  if (!id) {
    currentOpp = null;
    $("#opp-new-box").open = !oppIndex.length;
    $("#opp-empty").hidden = !!oppIndex.length;
    $("#opp-list").innerHTML = oppIndex.map((o) => `<a class="panel order-row opp-row" href="#/opponents/${enc(o.id)}">
        ${o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy">` : ""}
        <div><h3>${esc(o.title)}</h3><p class="muted small">${esc(oppMeta(o))}</p>
          ${o.notes.length ? `<p class="small opp-last">„${esc(o.notes[o.notes.length - 1].text)}“</p>` : ""}</div>
        <span class="muted small">${o.record.last ? esc(fmtDate(o.record.last)) : ""}</span></a>`).join("");
    return;
  }
  const prev = currentOpp?.id;
  try { currentOpp = await api(`/api/opponents/${enc(id)}`); } catch (err) { fail(err); go("#/opponents"); return; }
  renderOpponent();
  if (prev !== id) $("#opp-form").hidden = true;
}

function renderOpponent() {
  const o = currentOpp;
  $("#opp-name").textContent = o.title;
  $("#opp-meta").textContent = oppMeta(o);
  $("#opp-thumb").hidden = !o.image;
  if (o.image) $("#opp-thumb").src = o.image;
  $("#opp-edhrec").href = o.edhrec_url;
  const f = $("#opp-form").elements;
  f.commander.value = o.commanders[0] || "";
  f.partner.value = o.commanders[1] || "";
  f.label.value = o.label || "";
  f.player.value = o.player || "";
  f.bracket.value = o.bracket || "";
  $("#opp-table").innerHTML = '<option value="">–</option>' + tableSets.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  $("#opp-table").value = o.table_rule && tableById(o.table_rule) ? o.table_rule : "";
  $("#opp-tags").innerHTML = Object.entries(oppTags).map(([k, label]) =>
    `<label><input type="checkbox" name="tags" value="${esc(k)}"${o.tags.includes(k) ? " checked" : ""}><span>${esc(label)}</span></label>`).join("");
  $("#opp-notes-empty").hidden = !!o.notes.length;
  const deckName = (slug) => deckIndex.find((d) => d.slug === slug)?.name || slug;
  $("#opp-notes").innerHTML = o.notes.slice().reverse().map((n) => `<li>
      <div><p>${esc(n.text)}</p><span class="muted small">${esc(fmtDate(n.at))}${n.deck_slug ? ` · Partie mit <a href="#/deck/${enc(n.deck_slug)}/partien">${esc(deckName(n.deck_slug))}</a>` : ""}</span></div>
      <button type="button" class="icon-btn" data-note="${esc(n.id)}" aria-label="Notiz löschen" title="Notiz löschen">${icon("x")}</button></li>`).join("");
  const r = o.record;
  $("#opp-record").innerHTML = !r.games ? '<p class="empty-inline">Noch keine Partie gegen dieses Deck festgehalten.</p>'
    : `<div class="kpis"><div><b>${r.games}</b><span>Partien</span></div><div><b>${r.wins}–${r.losses}${r.draws ? "–" + r.draws : ""}</b><span>Siege–Niederlagen</span></div></div>
       ${r.per_deck.length > 1 ? `<p class="game-stats-more">${r.per_deck.map((p) => `${esc(p.name)} ${p.wins}–${p.losses}`).join(" · ")}</p>` : ""}`;
  const labels = { win: "Sieg", loss: "Niederlage", draw: "Unentschieden" };
  $("#opp-games-panel").hidden = !r.history.length;
  $("#opp-games").innerHTML = r.history.map((g) => `<li>
      <div class="when"><span class="res ${esc(g.result)}">${esc(labels[g.result] || g.result)}</span><br><span class="meta">${esc(fmtDate(g.played))}</span></div>
      <div>mit <a href="#/deck/${enc(g.deck_slug)}/partien">${esc(g.deck)}</a>${g.turn ? ` · Zug ${esc(g.turn)}` : ""}${g.note ? `<br><span class="meta">${esc(g.note)}</span>` : ""}</div><span></span></li>`).join("");
}

async function patchOpp(body, msg = "") {
  currentOpp = await api(`/api/opponents/${enc(currentOpp.id)}`, { method: "PATCH", body });
  renderOpponent();
  void refreshOpponents();
  if (msg) toast(msg);
}
$("#opp-new").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    const o = await api("/api/opponents", { method: "POST", body: { commanders: [f.commander.value], label: f.label.value, note: f.note.value } });
    e.target.reset();
    toast(`„${o.title}“ gemerkt.`);
    go(`#/opponents/${enc(o.id)}`);
  } catch (err) { fail(err); }
});
$("#opp-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const fd = new FormData(e.target);
  try {
    await patchOpp({ commanders: [f.commander.value, f.partner.value].filter((x) => x.trim()), label: f.label.value, player: f.player.value,
      bracket: f.bracket.value ? Number(f.bracket.value) : null, table_rule: f.table_rule.value || null, tags: fd.getAll("tags") }, "Gespeichert.");
  } catch (err) { fail(err); }
});
$("#opp-edit").addEventListener("click", () => {
  const form = $("#opp-form");
  form.hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  form.elements.label.focus({ preventScroll: true });
});
$("#opp-note-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const note = e.target.elements.note.value.trim();
  if (!note) return;
  try { await patchOpp({ note }); e.target.reset(); } catch (err) { fail(err); }
});
$("#opp-notes").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-note]");
  if (b) await patchOpp({ remove_note: b.dataset.note }).catch(fail);
});
$("#opp-delete").addEventListener("click", async () => {
  $("#opp-menu").open = false;
  const o = currentOpp;
  if (!(await ask({ title: `„${o.title}“ löschen?`, danger: true, ok: "Löschen",
    text: "Notizen und Steckbrief gehen verloren. Deine Partien bleiben erhalten, nur ohne Verknüpfung." }))) return;
  try {
    await api(`/api/opponents/${enc(o.id)}`, { method: "DELETE" });
    toast(`„${o.title}“ gelöscht.`);
    go("#/opponents");
  } catch (err) { fail(err); }
});
// ============================================================================================
// table rules ("Tischregeln"): rule sets per playgroup, chosen per deck
// ============================================================================================
let tableSets = [];
let tableCatalog = [];
let currentTable = null;

async function refreshTableRules() {
  const data = await api("/api/tablerules").catch(() => ({ sets: [], catalog: [] }));
  tableSets = data.sets;
  tableCatalog = data.catalog;
  $("#tr-count").textContent = tableSets.length || "";
  if (currentDeck) renderDeckTable(currentDeck);
}

function tableById(id) { return tableSets.find((t) => t.id === id) || null; }

function renderDeckTable(d) {
  const sel = $("#deck-table");
  const id = d.table_rule || "";
  sel.innerHTML = '<option value="">Keine Tischregel</option>'
    + tableSets.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  sel.value = tableById(id) ? id : "";
  const box = $("#deck-table-status");
  const t = d.validation?.table_rule;
  if (!id || !t?.name) {
    box.innerHTML = tableSets.length ? "" : `<p class="muted small">Noch keine Tischregeln – <a href="#/tables">jetzt eine anlegen</a>.</p>`;
    return;
  }
  const bad = t.violations || [];
  const summary = (t.summary || []).join(" · ");
  const warnings = (t.warnings || []).map((w) => `<p class="muted small">${esc(w)}</p>`).join("");
  const link = `<a class="link small" href="#/tables/${enc(id)}">Tischregel bearbeiten</a>`;
  if (!bad.length) {
    box.innerHTML = `${summary ? `<p class="muted small">${esc(summary)}</p>` : ""}${warnings}<p class="small">${link}</p>`;
    return;
  }
  box.innerHTML = `<p class="bad-text">${icon("alert")}
      ${bad.length} ${bad.length === 1 ? "Verstoß" : "Verstöße"} gegen „${esc(t.name)}“</p>
    <ul class="tr-violations">${bad.map((v) => `<li>${esc(v.split(": ").slice(1).join(": ") || v)}</li>`).join("")}</ul>
    ${warnings}
    ${summary ? `<p class="muted small">${esc(summary)}</p>` : ""}
    <div class="btn-row">
      <button type="button" class="btn" id="deck-table-fix">${icon("edit")}Karten bearbeiten</button>
      ${link}
    </div>`;
}
$("#deck-table").addEventListener("change", async (e) => {
  const d = currentDeck;
  const id = e.target.value || null;
  try {
    await api(`/api/decks/${enc(d.slug)}/table-rule`, { method: "PUT", body: { table_rule: id } });
    await openDeck(d.slug);
    void refreshDeckList();
    const t = currentDeck.validation?.table_rule;
    toast(!id ? "Tischregel entfernt." : t?.compliant ? `Passt zu „${t.name}“.` : `Tischregel gesetzt – ${t?.violations?.length || 0} Verstöße.`);
  } catch (err) { fail(err); renderDeckTable(d); }
});
$("#deck-table-status").addEventListener("click", (e) => {
  if (!e.target.closest("#deck-table-fix")) return;
  selectTab("karten");
  if (!edit) setEditing(true);
});

async function showTables(id) {
  $("#tr-list-view").hidden = !!id;
  $("#tr-view").hidden = !id;
  await refreshTableRules();
  if (!id) {
    currentTable = null;
    $("#tr-empty").hidden = !!tableSets.length;
    $("#tr-list").innerHTML = tableSets.map((t) => `<a class="panel order-row" href="#/tables/${enc(t.id)}">
        <div><h3>${esc(t.name)}</h3><p class="muted small">${esc(t.summary.join(" · ") || "noch leer")}</p></div>
        <span class="muted small">${t.decks ? `${t.decks} Deck${t.decks === 1 ? "" : "s"}` : ""}</span></a>`).join("");
    return;
  }
  currentTable = tableById(id);
  if (!currentTable) { toast("Diese Tischregel gibt es nicht mehr.", "error"); go("#/tables"); return; }
  $("#tr-decks").innerHTML = "";
  renderTable();
}

function renderTable() {
  const t = currentTable;
  $("#tr-name").textContent = t.name;
  $("#tr-meta").textContent = t.decks ? `Gilt für ${t.decks} Deck${t.decks === 1 ? "" : "s"}.` : "Noch von keinem Deck gewählt.";
  const f = $("#tr-form").elements;
  f.name.value = t.name;
  f.description.value = t.description || "";
  f.max_bracket.value = t.max_bracket || "";
  f.max_game_changers.value = t.max_game_changers ?? "";
  f.max_tutors.value = t.max_tutors ?? "";
  f.deck_budget.value = t.deck_budget ?? "";
  f.no_proxies.checked = !!t.no_proxies;
  const active = new Set(t.rules);
  $("#tr-rules").innerHTML = t.rule_info.map((r) => `<li>
      <div class="bl-rule-main">
        <strong>${esc(r.label)}</strong>
        <span class="pill ${r.checked ? "ok" : "accent"}">${r.checked ? "wird geprüft" : "Absprache"}</span>
        <p class="muted small">${esc(r.description)}</p>
      </div>
      <button type="button" class="btn ghost small" data-remove="${esc(r.rule)}" aria-label="${esc(r.label)} entfernen">Entfernen</button>
    </li>`).join("");
  $("#tr-cards").innerHTML = t.cards.map((n) => `<li>${esc(n)}<button type="button" title="Entfernen" aria-label="${esc(n)} entfernen" data-remove="${esc(n)}">×</button></li>`).join("");
  $("#tr-rules-empty").hidden = !!(t.rules.length || t.cards.length);
  $("#tr-quick").innerHTML = tableCatalog.filter((c) => !active.has(c.rule))
    .map((c) => `<button type="button" class="chip" data-rule="${esc(c.rule)}" title="${esc(c.description)}">${esc(c.label)}</button>`).join("")
    + (t.rules.some((r) => r.startsWith("@price>")) ? "" : `<button type="button" class="chip" data-price="1" title="Karten über einem Preis verbieten">Karten teurer als … €</button>`);
}

async function patchTable(body, msg = "") {
  const r = await api(`/api/tablerules/${enc(currentTable.id)}`, { method: "PATCH", body });
  await refreshTableRules();
  currentTable = tableById(currentTable.id);
  renderTable();
  if (r.revalidated?.length) toast(`${r.revalidated.length} Deck${r.revalidated.length === 1 ? "" : "s"} neu geprüft.`);
  else if (msg) toast(msg);
  return r;
}

$("#tr-new").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const t = await api("/api/tablerules", { method: "POST", body: { name: e.target.elements.name.value } });
    e.target.reset();
    go(`#/tables/${enc(t.id)}`);
  } catch (err) { fail(err); }
});
$("#tr-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const num = (v) => (v === "" ? null : Number(v));
  try {
    await patchTable({
      name: f.name.value, description: f.description.value, max_bracket: num(f.max_bracket.value),
      max_game_changers: num(f.max_game_changers.value), max_tutors: num(f.max_tutors.value),
      deck_budget: num(f.deck_budget.value), no_proxies: f.no_proxies.checked,
    }, "Gespeichert.");
  } catch (err) { fail(err); }
});
async function addToTable(add) {
  const r = await patchTable({ add });
  const parts = [];
  if (r.added?.length) parts.push(`Karten: ${r.added.join(", ")}`);
  if (r.added_rules?.length) parts.push(`Regeln: ${r.added_rules.map((x) => x.label).join(", ")}`);
  $("#tr-msg").textContent = parts.length ? `Hinzugefügt – ${parts.join(" · ")}` : "";
  for (const term of r.not_found || []) {
    const ok = await ask({ title: `„${term}“ nicht gefunden`, ok: "Als Absprache speichern",
      text: "Das ist weder eine Karte noch ein bekannter Begriff. Als freie Absprache speichern? Automatisch geprüft wird sie nicht." });
    if (ok) await patchTable({ add: [`@${term}`] }).catch(fail);
  }
}
$("#tr-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const add = $("#tr-input").value.split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
  if (!add.length) return;
  $("#tr-input").value = "";
  await addToTable(add).catch(fail);
});
$("#tr-quick").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  let rule = btn.dataset.rule;
  if (btn.dataset.price) {
    const v = await ask({ title: "Karten über welchem Preis verbieten?", text: "Betrag in Euro (günstigster Druck).", value: "10", ok: "Verbieten" });
    const n = Number.parseFloat(String(v || "").replace(",", "."));
    if (!(n > 0)) return;
    rule = `@price>${n}`;
  }
  await addToTable([rule]).catch(fail);
});
for (const list of ["#tr-rules", "#tr-cards"]) {
  $(list).addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-remove]");
    if (!btn) return;
    $("#tr-msg").textContent = "";
    await patchTable({ remove: [btn.dataset.remove] }).catch(fail);
  });
}
$("#tr-delete").addEventListener("click", async () => {
  $("#tr-menu").open = false;
  const t = currentTable;
  const ok = await ask({ title: `Tischregel „${t.name}“ löschen?`, danger: true, ok: "Löschen",
    text: t.decks ? `${t.decks} Deck${t.decks === 1 ? "" : "s"} verlieren damit ihre Tischregel (als neue Version gespeichert).` : "" });
  if (!ok) return;
  try {
    await api(`/api/tablerules/${enc(t.id)}`, { method: "DELETE" });
    toast(`„${t.name}“ gelöscht.`);
    if (currentDeck?.table_rule === t.id) await openDeck(currentDeck.slug);
    go("#/tables");
  } catch (err) { fail(err); }
});
$("#tr-check").addEventListener("click", async () => {
  const btn = $("#tr-check");
  btn.disabled = true;
  $("#tr-decks").innerHTML = '<li class="muted small">Prüfe …</li>';
  try {
    const rows = await api(`/api/tablerules/${enc(currentTable.id)}/decks`);
    $("#tr-decks").innerHTML = rows.length ? rows.map((r) => `<li>
        <span class="pill ${r.ok ? "ok" : "bad"}">${icon(r.ok ? "check" : "alert")}${r.ok ? "passt" : `${r.errors.length} ${r.errors.length === 1 ? "Verstoß" : "Verstöße"}`}</span>
        <div><a href="#/deck/${enc(r.slug)}/karten">${esc(r.name)}</a>${r.uses ? ' <span class="muted small">· nutzt diese Tischregel</span>' : ""}
          <span class="muted small">· ${esc(r.commanders.join(" + "))} · Bracket ${esc(r.bracket ?? "?")}</span>
          ${r.errors.length ? `<ul class="tr-violations">${r.errors.map((v) => `<li>${esc(v.split(": ").slice(1).join(": ") || v)}</li>`).join("")}</ul>` : ""}
          ${r.warnings.map((w) => `<p class="muted small">${esc(w.split(": ").slice(1).join(": ") || w)}</p>`).join("")}
        </div></li>`).join("") : '<li class="muted small">Noch keine Decks gespeichert.</li>';
  } catch (err) { fail(err); $("#tr-decks").innerHTML = ""; }
  btn.disabled = false;
});
