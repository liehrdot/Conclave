"use strict";
// The desktop GUI, part 3 of 21: „Neues Deck“: build from a commander, import a link, a list or a precon, the power profile.
// index.html loads the parts in order; they share one global scope.

// ============================================================================================
// new deck / commander finder
// ============================================================================================
const newForm = $("#new-form");

async function initBrackets() {
  brackets = await api("/api/brackets");
  $("#retune-brackets").innerHTML = brackets.map((b) => `
    <label title="${esc(b.summary)}"><input type="radio" name="rbracket" value="${b.number}">
    <span><b>${b.number}</b><small>${esc(b.name)}</small></span></label>`).join("");
}

newForm.addEventListener("submit", (e) => {  // Enter in the link or search field
  e.preventDefault();
  const im = $("#import-box").dataset.imode;
  if (im === "link") void loadImport({ url: $("#import-url").value });
  else if (im === "precon") void searchPrecons();
});

function wireAutocomplete(input, list, onPick) {
  input.addEventListener("input", debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return;
    try {
      const names = await api(`/api/autocomplete?q=${enc(q)}`);
      list.innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
    } catch { /* ignore */ }
  }, 200));
  input.addEventListener("change", () => onPick && onPick(input.value));
}

// ---------- import an existing deck: link, pasted list or starter deck ----------
let importData = null;
function setImportMode(mode) {
  $("#import-box").dataset.imode = mode;
  $(`#import-box [name=imode][value="${mode}"]`).checked = true;
  $("#import-msg").textContent = "";
  if (mode === "precon" && !preconItems) void searchPrecons();
}
$("#import-box").addEventListener("change", (e) => { if (e.target.name === "imode") setImportMode(e.target.value); });
$("#import-url-btn").addEventListener("click", () => loadImport({ url: $("#import-url").value }));
wireAutocomplete($("#manual-cmd"), $("#ac-manual"));
wireAutocomplete($("#manual-partner"), $("#ac-manual-p"));
$("#manual-btn").addEventListener("click", async () => {
  const commander = $("#manual-cmd").value.trim();
  if (commander.length < 2) { toast("Gib zuerst den Commander ein.", "error"); $("#manual-cmd").focus(); return; }
  const b = $("#manual-btn");
  b.disabled = true;
  b.textContent = "Lege an …";
  try {
    const r = await api("/api/decks/new", { method: "POST", body: { commander, partner: $("#manual-partner").value.trim() || null,
      name: $("#manual-name").value.trim(), bracket: Number($("#manual-bracket").value), currency: $("#new-currency").value } });
    await refreshDeckList();
    for (const id of ["#manual-cmd", "#manual-partner", "#manual-name"]) $(id).value = "";
    go(`#/deck/${enc(r.slug)}/karten`);
    for (let k = 0; k < 50 && currentDeck?.slug !== r.slug; k++) await new Promise((res) => setTimeout(res, 100));  // deck view loads
    if (currentDeck?.slug === r.slug && !edit) setEditing(true);
    toast("Deck angelegt – füge jetzt Karten hinzu.", "info", 6000);
  } catch (err) { fail(err); }
  finally { b.disabled = false; b.textContent = "Leeres Deck anlegen"; }
});
$("#import-text-btn").addEventListener("click", () => loadImport({ text: $("#import-text").value, name: importFileName || undefined }));
$("#import-clip-btn").addEventListener("click", importFromClipboard);
$("#import-file-btn").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";  // the same file again fires change again
  if (file) void importFromFile(file);
});
$("#import-text").addEventListener("input", () => { importFileName = ""; });  // an edited list is no longer that file

// A decklist saved as a .txt file (Moxfield „Download“, MTG Arena, Archidekt, by hand): picked with the button or
// dropped anywhere on „Neues Deck“ (handled with the other drops below). The file name becomes the deck name.
const IMPORT_FILE_MAX = 1024 * 1024;
let importFileName = "";
async function importFromFile(file) {
  if (!/\.txt$/i.test(file.name) && file.type && file.type !== "text/plain") {
    return toast(`„${file.name}“ ist keine Textdatei. Wähle eine .txt-Datei mit der Deckliste.`, "error");
  }
  if (file.size > IMPORT_FILE_MAX) return toast(`„${file.name}“ ist zu groß für eine Deckliste.`, "error");
  let text;
  try { text = decodeDeckFile(await file.arrayBuffer()).trim(); }
  catch { return toast(`„${file.name}“ ließ sich nicht lesen.`, "error"); }
  if (!text) return toast(`„${file.name}“ ist leer.`, "error");
  setImportMode("text");
  $("#import-text").value = text;
  importFileName = file.name.replace(/\.[^.]*$/, "").replace(/[_]+/g, " ").trim().slice(0, 120);
  void loadImport({ text, name: importFileName || undefined });
}
// UTF-8 (with or without BOM) is the usual case; Windows editors still save „Kultivieren“-lists as Windows-1252
function decodeDeckFile(buffer) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { return new TextDecoder("windows-1252").decode(buffer); }
}

// Reads a copied decklist (e.g. Moxfield „Export“ → „Copy for MTGA“) and checks it right away.
async function importFromClipboard() {
  let text = "";
  try { text = (await navigator.clipboard.readText()).trim(); }
  catch {
    toast("Die Zwischenablage ließ sich nicht lesen – füge die Liste mit Strg+V ein.", "error");
    $("#import-text").focus();
    return;
  }
  if (!text) { toast("Die Zwischenablage ist leer. Kopiere zuerst die Liste, z. B. in Moxfield mit „Copy for MTGA“.", "error"); return; }
  $("#import-text").value = text;
  importFileName = "";
  void loadImport({ text });
}

async function loadImport(body) {
  if (body.url !== undefined && !body.url.trim()) { toast("Füge zuerst einen Link ein.", "error"); $("#import-url").focus(); return; }
  const mox = body.url?.match(/moxfield\.com\/decks\/([A-Za-z0-9_-]+)/i);
  if (mox && await moxfieldWindow()) return openMoxfield(mox[1]);
  const msg = $("#import-msg");
  msg.className = "small muted";
  msg.textContent = body.url ? "Lade das Deck …" : "Prüfe die Liste …";
  $("#import-preview").hidden = true;
  try {
    importData = await api("/api/import/preview", { method: "POST", body });
    msg.textContent = "";
    renderImportPreview(importData);
  } catch (err) {
    if (mox) return moxfieldFallback(mox[1]);
    msg.className = "small bad";
    msg.textContent = err.message;
  }
}

// Moxfield blocks programs (Cloudflare, HTTP 403), so a link usually fails: switch to „Liste einfügen“
// and show the two clicks that get the list out of Moxfield.
function moxfieldFallback(id) {
  setImportMode("text");
  const msg = $("#import-msg");
  msg.className = "small";
  msg.innerHTML = `Moxfield lässt keine Programme an seine Decks, darum geht es hier über die Liste:
    öffne das Deck, wähle „Export“ → „Copy for MTGA“ und klicke dann „Aus Zwischenablage einfügen“.
    <a href="https://moxfield.com/decks/${esc(id)}" target="_blank" rel="noopener">Deck in Moxfield öffnen</a>`;
  $("#import-text").focus();
}

// The desktop app opens moxfield.com links in its own window (desktop/src-tauri/src/moxfield.rs): you log in
// there, „In Conclave importieren“ on the deck page sends the deck the page loaded back to conclaveMoxfield().
async function moxfieldWindow() {
  try { desktopShell = (await api("/api/desktop")).shell; } catch { /* keep the last answer */ }
  return !!desktopShell?.features?.includes("moxfield");
}

function openMoxfield(id) {
  const msg = $("#import-msg");
  msg.className = "small muted";
  msg.textContent = "Moxfield öffnet sich in einem eigenen Fenster. Melde dich dort an, falls nötig, und klicke auf der Deckseite „In Conclave importieren“.";
  location.href = `https://moxfield.com/decks/${encodeURIComponent(id)}`;  // the shell catches this and opens its window
}

window.conclaveMoxfield = (d) => {
  if (d?.kind === "collection") { takeMoxfieldPart(d); return; }  // collection.js
  const cards = Array.isArray(d?.cards) ? d.cards.filter((c) => Array.isArray(c) && typeof c[0] === "string") : [];
  const commanders = Array.isArray(d?.commanders) ? d.commanders.filter((c) => typeof c === "string") : [];
  if (!cards.length) { toast("Moxfield hat kein Deck geliefert.", "error"); return; }
  const lines = [...(commanders.length ? ["Commander", ...commanders.map((n) => `1 ${n}`), "", "Deck"] : []),
    ...cards.map(([n, q]) => `${Math.max(1, Number(q) || 1)} ${n}`)];
  if (parseHash().view !== "new") go("#/new");
  setImportMode("text");
  $("#import-text").value = lines.join("\n");
  void loadImport({ text: lines.join("\n"), name: typeof d.name === "string" ? d.name.slice(0, 120) : undefined });
};

// commander picker of the import preview: a filterable list of the legendary cards, those whose
// colours cover the whole deck first (a native <select> of 30+ names was unreadable)
let impPick = [];  // [commander, partner]
function cmdRowHtml(c) {
  const [cmd, partner] = impPick;
  const role = c.name === cmd ? "Commander" : c.name === partner ? "Partner" : "";
  const main = cmd && cmd !== c.name ? impCandidate(cmd) : null;
  const canPartner = main?.pairs && c.pairs && !role;
  const art = c.image ? c.image.replace("/normal/", "/art_crop/") : "";
  return `<div class="cmd-opt${role ? " picked" : ""}" data-name="${esc(c.name)}">
    <button type="button" class="cmd-main" role="option" aria-selected="${role === "Commander"}">
      ${art ? `<img src="${esc(art)}" alt="" loading="lazy">` : `<span class="cmd-noart"></span>`}
      <span class="cmd-text"><b>${esc(c.name)}</b><span class="muted small">${esc(c.type_line || "")}</span></span>
      <span class="cmd-ci">${(c.color_identity || []).map((x) => manaHtml(`{${x}}`)).join("") || manaHtml("{C}")}</span>
      ${role ? `<span class="cmd-role">${role}</span>` : ""}
    </button>
    ${canPartner ? `<button type="button" class="btn small cmd-partner" title="Als zweiten Commander (Partner, Background …) dazunehmen">+ Partner</button>` : ""}
  </div>`;
}
function impCandidate(name) { return importData?.commander_candidates.find((c) => c.name === name); }
function renderCmdList() {
  const list = $("#imp-cmd-list");
  if (!list || !importData) return;
  const q = ($("#imp-cmd-q")?.value || "").trim().toLowerCase();
  const all = importData.commander_candidates.filter((c) => !q || `${c.name} ${c.type_line || ""}`.toLowerCase().includes(q));
  const fit = all.filter((c) => c.fits), rest = all.filter((c) => !c.fits);
  const group = (title, items) => items.length ? `<p class="cmd-group">${title}</p>${items.map(cmdRowHtml).join("")}` : "";
  list.innerHTML = all.length ? (fit.length && rest.length
    ? group("Passen zu den Farben des Decks", fit) + group("Weitere legendäre Karten", rest)
    : all.map(cmdRowHtml).join(""))
    : `<p class="muted small cmd-empty">Keine Karte passt zu „${esc(q)}“.</p>`;
  const [cmd, partner] = impPick;
  $("#imp-cmd-chosen").innerHTML = cmd
    ? `Commander: <b>${esc(cmd)}</b>${partner ? ` + <b>${esc(partner)}</b>` : ""}`
    : `<span class="warn">Noch kein Commander gewählt</span>`;
  const src = impCandidate(cmd)?.image;
  $("#imp-cmd-img").hidden = !src;
  if (src) $("#imp-cmd-img").src = src;
}
function pickCommander(name, asPartner) {
  const [cmd, partner] = impPick;
  if (asPartner) impPick = [cmd, name];
  else if (name === cmd) impPick = partner ? [partner] : [];
  else if (name === partner) impPick = [cmd];
  else impPick = [name, ...(partner && impCandidate(name)?.pairs ? [partner] : [])];
  const nameField = $("#imp-name");
  if (nameField && !nameField.dataset.typed && impPick[0]) nameField.value = impPick[0];
  renderCmdList();
}

function renderImportPreview(d) {
  const box = $("#import-preview");
  const known = d.commanders.length > 0;
  impPick = known ? [] : [...d.suggested];
  const img = (known ? d.commander_images?.[d.commanders[0]] : null)
    || d.commander_candidates.find((c) => c.name === d.suggested[0])?.image;
  const count = d.card_count === 100 ? "100 Karten" : `<span class="warn">${d.card_count} Karten (Commander-Decks haben 100)</span>`;
  const n = d.commander_candidates.length;
  let cmd;
  if (known) cmd = `<p>Commander: <b>${d.commanders.map(esc).join(" + ")}</b></p>`;
  else if (n) {
    cmd = `<div class="field cmd-pick"><span>Commander</span>
      <p class="small cmd-chosen" id="imp-cmd-chosen" aria-live="polite"></p>
      ${n > 6 ? `<input type="search" id="imp-cmd-q" placeholder="${n} legendäre Karten durchsuchen …" autocomplete="off" aria-label="Commander suchen">` : ""}
      <div class="cmd-list" id="imp-cmd-list" role="listbox" aria-label="Commander wählen"></div></div>`;
  } else {
    cmd = `<label class="field"><span>Commander <span class="muted">(die Seite markiert ihn nicht)</span></span>
      <input id="imp-cmd-text" list="ac-imp-cmd" placeholder="Name des Commanders"><datalist id="ac-imp-cmd"></datalist></label>`;
  }
  box.innerHTML = `<img id="imp-cmd-img" src="${esc(img || "")}" alt=""${img ? "" : " hidden"}>
    <div class="grow">
      <label class="field"><span>Name</span><input id="imp-name" value="${esc(d.name || (d.commanders[0] || d.suggested[0] || "Importiertes Deck"))}" maxlength="120"></label>
      <p class="muted small">${esc(d.site)}${d.source ? ` · <a href="${esc(d.source)}" target="_blank" rel="noopener">Quelle</a>` : ""} · ${count}
        ${d.unresolved?.length ? `<br><span class="warn">Nicht erkannt: ${d.unresolved.slice(0, 8).map(esc).join(", ")}${d.unresolved.length > 8 ? " …" : ""}</span>` : ""}</p>
      ${cmd}
      <label class="field"><span>Bracket</span><select id="imp-bracket"><option value="">automatisch schätzen</option>
        ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n} – ${esc(brackets.find((b) => b.number === n)?.name || "")}</option>`).join("")}</select></label>
      <div><button type="button" class="btn primary" id="imp-save">Importieren &amp; prüfen</button></div>
    </div>`;
  box.hidden = false;
  if (d.name || known) $("#imp-name").dataset.typed = "1";  // a real deck name stays, a commander name follows the pick
  $("#imp-name").addEventListener("input", (e) => { e.target.dataset.typed = "1"; });
  if ($("#imp-cmd-text")) wireAutocomplete($("#imp-cmd-text"), $("#ac-imp-cmd"));
  if ($("#imp-cmd-list")) {
    renderCmdList();
    $("#imp-cmd-q")?.addEventListener("input", renderCmdList);
    $("#imp-cmd-q")?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); $("#imp-cmd-list .cmd-main")?.focus(); }
      if (e.key === "Enter") { e.preventDefault(); const first = $("#imp-cmd-list .cmd-opt"); if (first) pickCommander(first.dataset.name); }
    });
    $("#imp-cmd-list").addEventListener("click", (e) => {
      const row = e.target.closest(".cmd-opt");
      if (!row) return;
      const asPartner = !!e.target.closest(".cmd-partner");
      if (!asPartner && !e.target.closest(".cmd-main")) return;
      pickCommander(row.dataset.name, asPartner);
      $(`#imp-cmd-list .cmd-opt[data-name="${CSS.escape(row.dataset.name)}"] .cmd-main`)?.focus();
    });
    $("#imp-cmd-list").addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const rows = $$("#imp-cmd-list .cmd-main");
      const i = rows.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      if (e.key === "ArrowUp" && i === 0) $("#imp-cmd-q")?.focus();
      else rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].focus();
    });
  }
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("#import-preview").addEventListener("click", async (e) => {
  const b = e.target.closest("#imp-save");
  if (!b || !importData) return;
  const d = importData;
  const commanders = d.commanders.length ? d.commanders
    : $("#imp-cmd-text") ? [$("#imp-cmd-text").value.trim()].filter(Boolean)
    : impPick.filter(Boolean);
  if (!commanders.length) { toast("Wähle den Commander des Decks.", "error"); return; }
  const bracket = $("#imp-bracket").value;
  const body = { name: $("#imp-name").value.trim() || "Importiertes Deck", commanders, cards: d.cards, categories: d.categories,
    bracket: bracket ? Number(bracket) : null, currency: $("#new-currency").value, site: d.site, source: d.source || "" };
  b.disabled = true;
  b.textContent = "Importiere und prüfe …";
  try {
    const r = await api("/api/import", { method: "POST", body });
    await refreshDeckList();
    go(`#/deck/${enc(r.slug)}/karten`);
    toast(`Deck importiert (Bracket ${r.bracket}${bracket ? "" : ", geschätzt"}).${r.legal ? "" : " Die Prüfung hat Probleme gefunden – siehe rechts."}`, r.legal ? "info" : "error", 7000);
    importData = null;
    $("#import-preview").hidden = true;
    $("#import-url").value = "";
    $("#import-text").value = "";
  } catch (err) { b.disabled = false; b.textContent = "Importieren & prüfen"; fail(err); }
});

// ---------- starter deck (precon) import ----------
let preconItems = null;
async function searchPrecons() {
  const q = $("#precon-q").value.trim();
  $("#precon-msg").textContent = "Suche …";
  try {
    const items = await api(`/api/precons?q=${enc(q)}`);
    if ($("#precon-q").value.trim() !== q) return;
    preconItems = items;
    $("#precon-msg").textContent = items.length ? (q ? `${items.length} Treffer` : "Die neuesten Commander-Decks – oder oben suchen.") : "Kein Starterdeck gefunden.";
    $("#precon-list").innerHTML = items.map((p, i) => `<li><button type="button" data-i="${i}">
      <span>${esc(p.name)}</span><span class="muted small">${esc(p.code)} · ${esc(p.released.slice(0, 4))}</span></button></li>`).join("");
  } catch (err) { $("#precon-msg").textContent = err.message; $("#precon-list").innerHTML = ""; }
}
$("#precon-q").addEventListener("input", debounce(searchPrecons, 300));
$("#precon-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-i]");
  if (!b) return;
  const item = preconItems[Number(b.dataset.i)];
  const box = $("#precon-pick");
  box.hidden = false;
  box.innerHTML = `<p class="muted small">Lade ${esc(item.name)} …</p>`;
  try {
    const p = await api(`/api/precons/${enc(item.file)}`);
    const img = p.commander_images?.[p.commanders[0]];
    box.innerHTML = `${img ? `<img src="${esc(img)}" alt="${esc(p.commanders[0])}">` : ""}
      <div><h3>${esc(p.name)}</h3>
        <p class="muted small">${esc(p.code)} · ${esc(p.released)} · ${p.card_count} Karten</p>
        <p>Commander: <b>${p.commanders.map(esc).join(" + ")}</b></p>
        <button type="button" class="btn primary" id="precon-import" data-file="${esc(p.file)}">Importieren &amp; prüfen</button></div>`;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) { box.innerHTML = `<p class="bad small">${esc(err.message)}</p>`; }
});
$("#precon-pick").addEventListener("click", async (e) => {
  const b = e.target.closest("#precon-import");
  if (!b) return;
  b.disabled = true;
  b.textContent = "Importiere und prüfe …";
  try {
    const r = await api("/api/precons/import", { method: "POST", body: { file: b.dataset.file, currency: $("#new-currency").value } });
    await refreshDeckList();
    go(`#/deck/${enc(r.slug)}/karten`);
    toast("Starterdeck importiert.", "info", 6000);
  } catch (err) { b.disabled = false; b.textContent = "Importieren & prüfen"; fail(err); }
});

// ---------- power profile (sub-tier, house rules, style) ----------
const TIER_LABELS = { low: "unteres", mid: "mittleres", high: "oberes" };
const TIER_ORDER = ["low", "mid", "high"];
const TIER_CENTER = { low: 0.17, mid: 0.5, high: 0.83 };

$$(".profile-fields").forEach((el) => el.appendChild($("#profile-template").content.cloneNode(true)));

function readProfile(root) {
  const q = (n) => root.querySelector(`[name="${n}"]`);
  const num = (n) => (q(n).value === "" ? null : Number(q(n).value));
  const p = {
    tier: root.querySelector('[name="tier"]:checked')?.value || null,
    max_game_changers: num("max_game_changers"),
    max_tutors: num("max_tutors"),
    allow_two_card_combos: q("no_combos").checked ? false : null,
    allow_extra_turns: q("no_extra_turns").checked ? false : null,
    allow_mass_land_denial: q("no_mld").checked ? false : null,
    style: q("style").value.trim(),
  };
  return Object.values(p).some((v) => v !== null && v !== "") ? p : null;
}

function setProfile(root, p = {}) {
  p = p || {};
  const q = (n) => root.querySelector(`[name="${n}"]`);
  root.querySelector(`[name="tier"][value="${p.tier || ""}"]`).checked = true;
  q("max_game_changers").value = p.max_game_changers ?? "";
  q("max_tutors").value = p.max_tutors ?? "";
  q("no_combos").checked = p.allow_two_card_combos === false;
  q("no_extra_turns").checked = p.allow_extra_turns === false;
  q("no_mld").checked = p.allow_mass_land_denial === false;
  q("style").value = p.style || "";
}

function levelText(bracket, tier) {
  return tier ? `${TIER_LABELS[tier]} Bracket ${bracket}` : `Bracket ${bracket}`;
}
