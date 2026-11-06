"use strict";
// The desktop GUI, part 17 of 21: settings: backups and trash, sync, proxy printing and the card DB.
// index.html loads the parts in order; they share one global scope.

// ============================================================================================
// settings: backups (export / import / automatic) and the deck trash
// ============================================================================================
const fmtSize = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

async function refreshBackups() {
  let data;
  try { data = await api("/api/backups"); } catch (err) { fail(err); return; }
  const autos = data.backups.filter((b) => b.kind === "auto");
  $("#backup-auto").textContent = `Automatisch: einmal am Tag beim Start der App, die letzten ${data.keep_auto} bleiben erhalten`
    + (autos.length ? ` (zuletzt ${fmtDate(autos[0].created)}).` : " (noch keine).") + ` Ordner: ${data.dir}`;
  $("#backup-list").innerHTML = data.backups.map((b) => `<li>
      <div class="grow"><strong>${esc(fmtDate(b.created) || b.name)}</strong> <span class="muted small">· ${esc(b.kind_label)}
        · ${b.decks ?? "?"} Decks · ${esc(fmtSize(b.size))}</span></div>
      <div class="actions">
        <a class="btn small" href="/api/backups/${enc(b.name)}" download>Herunterladen</a>
        <button type="button" class="btn small" data-restore="${esc(b.name)}">Wiederherstellen …</button>
      </div></li>`).join("") || '<li class="muted small">Noch keine Sicherung.</li>';
}

$("#backup-create").addEventListener("click", async () => {
  try {
    const b = await api("/api/backups", { method: "POST" });
    await refreshBackups();
    toast(`Gesichert: ${b.decks} Decks, ${b.files} Dateien.`);
  } catch (err) { fail(err); }
});
$("#backup-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const res = await fetch("/api/backups/upload", { method: "POST", body: file, headers: { "Content-Type": "application/zip" } });
    const b = await res.json();
    if (!res.ok) throw new Error(b.detail || res.statusText);
    await refreshBackups();
    await restoreBackup(b.name, b);
  } catch (err) { fail(err); }
});
$("#backup-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-restore]");
  if (btn) void restoreBackup(btn.dataset.restore);
});
async function restoreBackup(name, info = null) {
  const ok = await ask({ title: "Sicherung wiederherstellen?", ok: "Wiederherstellen", danger: true,
    text: `${info?.created ? `Stand vom ${fmtDate(info.created)}${info.decks != null ? `, ${info.decks} Decks` : ""}. ` : ""}`
      + "Deine aktuellen Daten werden durch die Sicherung ersetzt. Vorher wird der jetzige Stand automatisch gesichert – du kannst also zurück." });
  if (!ok) return;
  try {
    const r = await api(`/api/backups/${enc(name)}/restore`, { method: "POST" });
    currentDeck = null;
    await Promise.all([refreshDeckList(), refreshTableRules(), refreshOpponents(), refreshBlacklist(), refreshCollectionSummary()]);
    await refreshBackups();
    toast(`Wiederhergestellt: ${r.decks} Decks. Der vorherige Stand liegt als Sicherung bereit.`);
  } catch (err) { fail(err); }
}

async function refreshTrash() {
  let items;
  try { items = await api("/api/trash"); } catch (err) { fail(err); return; }
  $("#nav-trash").hidden = !items.length;
  $("#trash-count").textContent = items.length || "";
  $("#trash-list").innerHTML = items.map((t) => `<li>
      <span class="name">${esc(t.name)}</span>
      <span class="actions">
        <button type="button" class="btn small" data-trash-restore="${esc(t.id)}">Zurückholen</button>
        <button type="button" class="btn ghost small" data-trash-purge="${esc(t.id)}" aria-label="${esc(t.name)} endgültig löschen">Endgültig löschen …</button>
      </span></li>`).join("");
}
async function restoreFromTrash(id) {
  try {
    const r = await api(`/api/trash/${enc(id)}/restore`, { method: "POST" });
    await refreshDeckList();
    toast(`„${r.name}“ ist wieder da.`);
    go(`#/deck/${enc(r.slug)}`);
  } catch (err) { fail(err); }
}
$("#trash-list").addEventListener("click", async (e) => {
  const back = e.target.closest("button[data-trash-restore]");
  if (back) { void restoreFromTrash(back.dataset.trashRestore); return; }
  const purge = e.target.closest("button[data-trash-purge]");
  if (!purge) return;
  if (!(await ask({ title: "Endgültig löschen?", text: "Das Deck mit Versionen und Partien ist danach weg (außer in einer Sicherung).", ok: "Endgültig löschen", danger: true }))) return;
  try { await api(`/api/trash/${enc(purge.dataset.trashPurge)}`, { method: "DELETE" }); void refreshTrash(); } catch (err) { fail(err); }
});
$("#trash-empty").addEventListener("click", async () => {
  if (!(await ask({ title: "Papierkorb leeren?", text: "Alle Decks im Papierkorb werden endgültig gelöscht (außer in einer Sicherung).", ok: "Leeren", danger: true }))) return;
  try { await api("/api/trash", { method: "DELETE" }); void refreshTrash(); } catch (err) { fail(err); }
});

// ============================================================================================
// settings: sync with the own sync server (status, connect, pair another device, devices, conflicts)
// ============================================================================================
let syncInfo = null;
let syncSeenAt = null;  // the last run whose news were shown (no toast for runs before this page load)
let syncPairTimer = null;
const SYNC_POLL_MS = 30000;

const fmtAgo = (ts) => {
  if (!ts) return "nie";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "gerade eben";
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
  const d = Math.round(s / 86400);
  return d === 1 ? "gestern" : `vor ${d} Tagen`;
};
const fmtClock = (ts) => new Date(ts * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const syncHost = (url) => { try { return new URL(url).host; } catch { return url || ""; } };

function syncSummary(run) {
  if (!run) return "Noch nicht abgeglichen.";
  if (run.error) return `<span class="warn">Letzter Abgleich ${esc(fmtAgo(run.at))} hat nicht geklappt: ${esc(run.error)}</span>`;
  const parts = [];
  const more = (n) => (n ? ` und ${n} weitere` : "");
  if (run.incoming?.length) parts.push(`geholt: ${esc(run.incoming.join(", "))}${more(run.incoming_more)}`);
  if (run.outgoing?.length) parts.push(`gesendet: ${esc(run.outgoing.join(", "))}${more(run.outgoing_more)}`);
  if (run.conflicts) parts.push(`<a href="#" data-sync-conflicts>${run.conflicts} ${run.conflicts === 1 ? "Konflikt" : "Konflikte"}</a>`);
  return `Zuletzt abgeglichen ${esc(fmtAgo(run.at))} (${fmtClock(run.at)}) – ${parts.length ? parts.join(" · ") : "alles war schon aktuell"}.`;
}

function renderSyncDot() {
  const dot = $("#sync-dot");
  const on = syncInfo?.connected;
  dot.hidden = !on;
  if (!on) return;
  const bad = syncInfo.revoked || (syncInfo.last && !syncInfo.last.ok);
  dot.className = "sync-dot" + (syncInfo.running ? " busy" : bad ? " bad" : "");
  dot.title = syncInfo.running ? "Sync läuft …" : bad ? "Sync: Problem – siehe Einstellungen" : `Sync: abgeglichen ${fmtAgo(syncInfo.last_ok)}`;
  dot.setAttribute("aria-label", dot.title);
  dot.setAttribute("role", "img");
}

function renderSync() {
  renderSyncDot();
  const st = syncInfo;
  if (!st) return;
  const on = st.connected && !st.revoked;
  $("#sync-off").hidden = on;
  $("#sync-on").hidden = !on;
  $("#sync-revoked").hidden = !st.revoked;
  const f = $("#sync-connect").elements;
  if (!f.name.value) f.name.value = st.device?.name || st.default_name || "";
  if (!on) return;
  const d = st.device;
  const ok = st.last ? st.last.ok : null;
  $("#sync-line").innerHTML = `<span class="dot ${ok === false ? "bad" : ok ? "ok" : ""}" aria-hidden="true"></span>`
    + `<span>Verbunden mit ${esc(syncHost(d.server))} als „${esc(d.name)}“</span>`
    + (st.running ? '<span class="spinner" aria-label="Abgleich läuft"></span>' : "");
  $("#sync-result").innerHTML = syncSummary(st.last)
    + (st.pending_revalidation?.length ? ` <span class="muted">${st.pending_revalidation.length === 1 ? "Ein zusammengeführtes Deck wird" : `${st.pending_revalidation.length} zusammengeführte Decks werden`} noch geprüft (braucht Internet).</span>` : "");
  $("#sync-interval").value = String(st.interval);
  if (![...$("#sync-interval").options].some((o) => o.selected)) $("#sync-interval").value = "5";
  $("#sync-conflict-count").textContent = st.conflicts || "";
  $("#sync-details").textContent = `Server: ${d.server} · Gerät: ${d.name} (${d.device_id}) · verbunden seit ${fmtDate(new Date(d.paired_at * 1000).toISOString())}`;
}

async function refreshSync({ quiet = false } = {}) {
  try { syncInfo = await api("/api/sync"); } catch (err) { if (!quiet) fail(err); return; }
  if (syncSeenAt === null) syncSeenAt = syncInfo.last?.at || 0;
  renderSync();
  syncNews(syncInfo.last);
}

// news from the other devices: one toast per run that brought something in
function syncNews(run) {
  if (!run || !run.at || run.at <= syncSeenAt) return;
  syncSeenAt = run.at;
  if (!run.ok || !run.incoming?.length) return;
  const rest = run.incoming.length - 3 + (run.incoming_more || 0);
  const items = run.incoming.slice(0, 3).join(", ") + (rest > 0 ? ` und ${rest} weitere` : "");
  void refreshDeckList();
  toast(`Neu von deinen anderen Geräten: ${items}`, "info", 9000, { label: "Anzeigen", run: reloadAfterSync });
}

async function reloadAfterSync() {
  await Promise.all([refreshDeckList(), refreshTableRules(), refreshOpponents(), refreshBlacklist(), refreshCollectionSummary(), refreshOrders()]);
  if (edit) { toast("Du bearbeitest gerade dieses Deck – speichere oder verwirf zuerst, dann siehst du den neuen Stand."); return; }
  currentDeck = null;
  void route();
}

async function syncRun() {
  const btn = $("#sync-run");
  btn.disabled = true;
  if (syncInfo) { syncInfo.running = true; renderSync(); }
  try {
    const r = await api("/api/sync/run", { method: "POST" });
    syncInfo = r;
    renderSync();
    if (r.run.error) toast(r.run.error, "error", 7000);
    else if (!r.run.incoming?.length) toast(r.run.outgoing?.length ? "Abgeglichen – deine Änderungen sind auf dem Server." : "Abgeglichen – alles war schon aktuell.");
    syncNews(r.run);
    if (r.run.conflicts) void refreshSyncConflicts();
  } catch (err) { fail(err); void refreshSync({ quiet: true }); } finally { btn.disabled = false; }
}
$("#sync-run").addEventListener("click", syncRun);

$("#sync-connect").elements.link.addEventListener("input", (e) => {
  const v = e.target.value.trim();
  $("#sync-url-row").hidden = !/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(v);  // a bare code needs the address
});
$("#sync-connect").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const btn = $("#sync-connect-btn");
  btn.disabled = true;
  btn.textContent = "Verbinde und gleiche ab …";
  try {
    const r = await api("/api/sync/connect", { method: "POST", body: { link: f.link.value.trim(), url: f.url.value.trim(), name: f.name.value.trim() } });
    syncInfo = r;
    syncSeenAt = r.run?.at || syncSeenAt;
    f.link.value = "";
    renderSync();
    if (r.run?.error) toast(`Verbunden, aber der erste Abgleich hat nicht geklappt: ${r.run.error}`, "error", 8000);
    else toast(r.run?.incoming?.length ? "Verbunden – die Daten der anderen Geräte sind jetzt auch hier." : "Verbunden – deine Daten sind auf dem Server.");
    if (r.run?.incoming?.length) void reloadAfterSync();
  } catch (err) { fail(err); } finally { btn.disabled = false; btn.textContent = "Verbinden"; }
});

$("#sync-interval").addEventListener("change", async (e) => {
  try {
    await api("/api/settings", { method: "POST", body: { sync_interval: Number(e.target.value) } });
    toast(Number(e.target.value) ? "Gespeichert – abgeglichen wird beim Start, nach Änderungen und regelmäßig." : "Gespeichert – abgeglichen wird nur noch per Knopf.");
    void refreshSync({ quiet: true });
  } catch (err) { fail(err); }
});

$("#sync-pair").addEventListener("click", async () => {
  try {
    const p = await api("/api/sync/pair", { method: "POST" });
    $("#sync-qr").innerHTML = p.qr || "";
    $("#sync-qr").hidden = !p.qr;
    $("#sync-code").textContent = p.code;
    $("#sync-copy").dataset.link = p.link;
    $("#sync-pairing").hidden = false;
    clearInterval(syncPairTimer);
    const tick = () => {
      const left = Math.round(p.expires - Date.now() / 1000);
      $("#sync-code-hint").textContent = left > 0
        ? `Gültig noch ${Math.ceil(left / 60)} Min. (bis ${fmtClock(p.expires)}), nur einmal verwendbar.`
        : "Abgelaufen – bitte einen neuen Code erzeugen.";
      if (left <= 0) clearInterval(syncPairTimer);
    };
    tick();
    syncPairTimer = setInterval(tick, 15000);
  } catch (err) { fail(err); }
});
$("#sync-pair-close").addEventListener("click", () => { $("#sync-pairing").hidden = true; clearInterval(syncPairTimer); void refreshSyncDevices(); });
$("#sync-copy").addEventListener("click", async (e) => {
  try { await navigator.clipboard.writeText(e.target.dataset.link); toast("Link kopiert."); }
  catch { await ask({ title: "Kopplungslink", text: "Zum Kopieren markieren:", value: e.target.dataset.link, ok: "Schließen" }); }
});

async function refreshSyncDevices() {
  let data;
  try { data = await api("/api/sync/devices"); } catch (err) { $("#sync-devices").innerHTML = `<li class="muted small">${esc(err.message)}</li>`; return; }
  const kinds = { pc: "PC", phone: "Handy", other: "Gerät" };
  $("#sync-device-count").textContent = data.devices.length || "";
  $("#sync-devices").innerHTML = data.devices.map((d) => {
    const state = d.online ? '<span class="ok">online</span>' : `zuletzt ${esc(fmtAgo(d.last_seen))}`;
    return `<li>
      <div class="grow"><strong>${esc(d.name)}</strong> <span class="muted small">· ${kinds[d.kind] || "Gerät"}${d.this ? " · dieses Gerät" : ""}
        · ${state}</span></div>
      ${d.this ? "" : `<div class="actions"><button type="button" class="btn ghost small" data-sync-revoke="${esc(d.id)}" data-name="${esc(d.name)}">Abmelden …</button></div>`}
    </li>`;
  }).join("") || '<li class="muted small">Keine Geräte.</li>';
}
$("#sync-devices-box").addEventListener("toggle", (e) => { if (e.target.open) void refreshSyncDevices(); });
$("#sync-devices").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-sync-revoke]");
  if (!btn) return;
  if (!(await ask({ title: `„${btn.dataset.name}“ abmelden?`, text: "Das Gerät kann danach nicht mehr abgleichen, bis du es neu koppelst. Seine eigenen Daten bleiben dort erhalten.", ok: "Abmelden", danger: true }))) return;
  try { await api(`/api/sync/devices/${enc(btn.dataset.syncRevoke)}`, { method: "DELETE" }); toast(`„${btn.dataset.name}“ ist abgemeldet.`); void refreshSyncDevices(); } catch (err) { fail(err); }
});

const conflictVal = (v) => {
  if (v === null || v === undefined) return "–";
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > 140 ? t.slice(0, 140) + " …" : t;
};
async function refreshSyncConflicts() {
  let items;
  try { items = await api("/api/sync/conflicts"); } catch (err) { fail(err); return; }
  $("#sync-conflict-count").textContent = items.length || "";
  $("#sync-conflicts-none").hidden = items.length > 0;
  $("#sync-conflicts-clear").hidden = !items.length;
  $("#sync-conflicts").innerHTML = items.slice(0, 100).map((c) => `<li>
      <div class="grow"><strong>${esc(c.label)}</strong> <span class="muted small">· ${esc(fmtDate(c.at))} · ${esc(c.note)}</span>
        <div class="small">Feld <code>${esc(c.where)}</code> · gilt jetzt: <span class="conflict-val">${esc(conflictVal(c.kept))}</span>
          · hier war: <span class="conflict-val">${esc(conflictVal(c.local))}</span></div></div></li>`).join("");
}
$("#sync-conflicts-box").addEventListener("toggle", (e) => { if (e.target.open) void refreshSyncConflicts(); });
$("#sync-result").addEventListener("click", (e) => {
  if (!e.target.closest("[data-sync-conflicts]")) return;
  e.preventDefault();
  $("#sync-conflicts-box").open = true;
  $("#sync-conflicts-box").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#sync-conflicts-clear").addEventListener("click", async () => {
  try { await api("/api/sync/conflicts", { method: "DELETE" }); void refreshSyncConflicts(); void refreshSync({ quiet: true }); } catch (err) { fail(err); }
});

$("#sync-disconnect").addEventListener("click", async () => {
  if (!(await ask({ title: "Dieses Gerät trennen?", text: "Es meldet sich am Server ab und gleicht nicht mehr ab. Alle Daten hier bleiben erhalten; verbindest du es später wieder, geht es dort weiter.", ok: "Trennen", danger: true }))) return;
  try { syncInfo = await api("/api/sync/disconnect", { method: "POST" }); renderSync(); toast("Getrennt – die Daten auf diesem Gerät bleiben erhalten."); } catch (err) { fail(err); }
});

// keep the status fresh while the app is visible; coming back to the window syncs if it has been a while
setInterval(() => { if (document.visibilityState === "visible" && syncInfo?.connected) void refreshSync({ quiet: true }); }, SYNC_POLL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !syncInfo?.connected || syncInfo.revoked || !syncInfo.interval) return;
  if (!syncInfo.running && Date.now() / 1000 - (syncInfo.last?.at || 0) > 60) {
    api("/api/sync/run", { method: "POST" }).then((r) => { syncInfo = r; renderSync(); syncNews(r.run); }, () => {});
  }
});

// ============================================================================================
// settings: proxy printing, AI upscaling, local card DB
// ============================================================================================
let appSettings = {};
function applyFont(font) {
  document.documentElement.dataset.font = font === "inter" ? "inter" : "cascadia";
}
async function loadSettings() {
  appSettings = await api("/api/settings");
  applyFont(appSettings.font);
  applyHoverPreview(appSettings.hover_preview);
  const fontChoice = $("#font-choice");
  if (fontChoice) fontChoice.value = appSettings.font === "inter" ? "inter" : "cascadia";
  const hoverChoice = $("#hover-preview");
  if (hoverChoice) hoverChoice.checked = hoverPreview;
  const f = $("#settings-form").elements;
  const MODEL_HINTS = { "realesrgan-x4plus": " (empfohlen)", "realesrgan-x4plus-anime": " (für Zeichnungen, glättet stärker)" };
  f.upscale_model.innerHTML = appSettings.upscale_models.map((m) => `<option value="${esc(m)}">${esc(m + (MODEL_HINTS[m] || ""))}</option>`).join("")
    || '<option value="">– Programm nicht gefunden –</option>';
  for (const k of ["autofill_path", "mpcfill_server", "cardback_path", "browser", "site", "upscaler_path", "upscale_model", "descreen", "image_generator_url"]) if (f[k]) f[k].value = appSettings[k] ?? "";
  f.upscale.checked = !!appSettings.upscale;
  $("#upscaler-status").innerHTML = appSettings.upscaler_found
    ? `<span class="ok">✓ gefunden:</span> ${esc(appSettings.upscaler_found)}`
    : 'Nicht installiert – nur nötig, wenn du hochskalieren willst (<a href="https://github.com/xinntao/Real-ESRGAN/releases" target="_blank" rel="noopener">Download</a>).';
  $("#print-form").elements.upscale.checked = !!appSettings.upscale;
  $("#autofill-status").innerHTML = appSettings.autofill_found
    ? `<span class="ok">✓ gefunden:</span> ${esc(appSettings.autofill_found)}`
    : '<span class="warn">Nicht gefunden</span> – Pfad eintragen oder die exe in den Ordner <code>tools/</code> legen.';
  const stock = $("#print-form").elements.stock;
  stock.innerHTML = appSettings.stocks.map((s) => `<option ${s === appSettings.stock ? "selected" : ""}>${esc(s)}</option>`).join("");
  $("#print-form").elements.foil.checked = !!appSettings.foil;
  $("#pdf-paper").value = appSettings.paper || "A4";
}
let hoverSave = 0;
$("#hover-preview").addEventListener("change", async (e) => {
  const on = e.target.checked;
  const seq = ++hoverSave;
  applyHoverPreview(on);
  try {
    const saved = await api("/api/settings", { method: "POST", body: { hover_preview: on } });
    if (seq !== hoverSave) return; // a newer toggle or the settings form already saved
    appSettings = saved;
    applyHoverPreview(appSettings.hover_preview);
    e.target.checked = hoverPreview;
  } catch (err) {
    if (seq !== hoverSave) return;
    applyHoverPreview(appSettings.hover_preview);
    e.target.checked = hoverPreview;
    fail(err);
  }
});
$("#font-choice").addEventListener("change", async (e) => {
  const font = e.target.value === "inter" ? "inter" : "cascadia";
  applyFont(font);
  try {
    appSettings = await api("/api/settings", { method: "POST", body: { font } });
    applyFont(appSettings.font);
  } catch (err) {
    applyFont(appSettings.font);
    e.target.value = appSettings.font === "inter" ? "inter" : "cascadia";
    fail(err);
  }
});
$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.upscale = e.target.elements.upscale.checked;
  body.hover_preview = $("#hover-preview").checked; // outside the form; unchecked boxes are omitted from FormData
  hoverSave++;
  try {
    await api("/api/settings", { method: "POST", body });
    await loadSettings();
    toast("Einstellungen gespeichert.");
  } catch (err) { $("#settings-msg").textContent = err.message; }
});

async function refreshDbStatus() {
  const [st, run] = await Promise.all([api("/api/carddb"), api("/api/carddb/refresh")]).catch(() => [{}, {}]);
  const el = $("#db-status");
  if (run.running) {
    el.textContent = "Lade und importiere Bulk-Daten … (All Cards ≈ 375 MB, dauert einige Minuten)";
    $("#db-btn").disabled = true;
    setTimeout(refreshDbStatus, 5000);
    return;
  }
  $("#db-btn").disabled = false;
  if (run.error) el.innerHTML = `<span class="bad">Fehler: ${esc(run.error)}</span>`;
  else if (!st.available) el.innerHTML = '<span class="warn">Nicht vorhanden</span> – ohne lokale Datenbank wird die Scryfall-API live genutzt (langsamer, nur englische Namen).';
  else el.innerHTML = `<span class="ok">✓</span> ${st.cards} Karten, ${st.tags} Tags, ${st.languages.length} Sprachen · Stand ${esc(st.cards_updated_at?.slice(0, 10) ?? "?")}`
    + (st.schema_outdated ? ' · <span class="warn">Update empfohlen:</span> die Datenbank kennt noch keine Rückseiten doppelseitiger Karten'
      : st.needs_refresh ? ' · <span class="warn">Update empfohlen</span>' : "");
  $("#db-btn").textContent = st.available ? "Jetzt aktualisieren" : "Scryfall-Bulk-Daten laden";
}
$("#db-btn").addEventListener("click", async () => {
  await api("/api/carddb/refresh", { method: "POST" }).catch(fail);
  void refreshDbStatus();
});
