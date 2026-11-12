"use strict";
// The desktop GUI, part 20 of 21: the desktop app panel and the update view.
// index.html loads the parts in order; they share one global scope.

// ---------- desktop app (Tauri shell): the panel appears only while the shell polls the backend ----------
let desktopShell = null, desktopAnnounced = null, desktopTimer = null, desktopRetries = 0;
const UPDATE_BUSY = ["preparing", "downloading", "verifying", "installing"];
async function refreshDesktop() {
  let d;
  clearTimeout(desktopTimer);
  try { d = await api("/api/desktop"); } catch {
    // the installer stops the backend: the window keeps the view until the app restarts
    if (["verifying", "installing"].includes(updateView.update?.state)) { renderUpdateView({ ...updateView.update }, { gone: true }); desktopTimer = setTimeout(refreshDesktop, 2000); }
    return;
  }
  desktopShell = d.shell;
  $("#desktop-panel").hidden = !d.shell;
  if (!d.shell) {
    if (store.get("update") && desktopRetries++ < 10) desktopTimer = setTimeout(refreshDesktop, 3000);  // the shell's first poll is still to come
    return;
  }
  $("#desktop-version").textContent = d.shell.version || "–";
  $("#desktop-autostart").checked = !!d.shell.autostart;
  $("#desktop-notify").checked = !!d.notify;
  $("#desktop-preview").checked = !!d.preview;
  const u = d.shell.update;
  renderDesktopUpdate(u);
  followUpdate(u, d.shell.version);
  if (u?.state === "available" && desktopAnnounced !== u.version && !updateView.update) {  // once per announced version
    desktopAnnounced = u.version;
    toast(`Version ${u.version} der Desktop-App ist da.`, "info", 9000, { label: "Ansehen", run: () => go("#/settings") });
  }
  const busy = UPDATE_BUSY.includes(u?.state) || updateView.waiting;
  desktopTimer = setTimeout(refreshDesktop, busy ? 500 : 5 * 60 * 1000);
}
const fmtMB = (bytes) => fmtNum(bytes / 1048576, "", bytes < 10 * 1048576 ? 1 : 0);
function fmtLeft(s) {
  if (!Number.isFinite(s) || s < 0) return "";
  if (s < 5) return "gleich fertig";
  if (s < 60) return `noch etwa ${Math.ceil(s / 5) * 5} s`;
  return `noch etwa ${Math.ceil(s / 60)} Min.`;
}
function renderDesktopUpdate(u) {
  const el = $("#desktop-update");
  $("#desktop-install").hidden = u?.state !== "available";
  $("#desktop-check").disabled = !!u && UPDATE_BUSY.includes(u.state);
  if (!u) { el.textContent = ""; return; }
  const at = u.checked ? ` (geprüft ${new Date(u.checked * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })})` : "";
  const first = (u.notes || "").split("\n").find((l) => l.trim()) || "";
  const text = {
    unknown: "Noch nicht nach Updates gesucht.",
    none: `Auf dem neuesten Stand${at}.`,
    available: `${/-/.test(u.version) ? "Vorschau-Version" : "Version"} ${u.version} ist da${first ? ` – ${first.slice(0, 140).replace(/[.!]$/, "")}` : ""}.`,
    preparing: "Das Update wird vorbereitet …",
    downloading: `Lädt Version ${u.version} … ${u.total > 0 ? `${Math.floor(((u.downloaded || 0) / u.total) * 100)} %` : `${fmtMB(u.downloaded || 0)} MB`}`,
    verifying: "Prüft die Signatur des Updates …",
    installing: "Installiert – die App startet gleich neu.",
    error: u.failed_step ? `Update fehlgeschlagen: ${updateErrorText(u)}` : `Update-Prüfung fehlgeschlagen: ${u.error || "unbekannter Fehler"}`,
    unconfigured: "Updates sind in diesem Build nicht eingerichtet.",
  }[u.state] || "";
  el.textContent = text;
  el.className = `small ${u.state === "error" ? "warn" : u.state === "available" ? "ok" : "muted"}`;
  if (UPDATE_BUSY.includes(u.state) && !$("#update-view").open) {
    el.append(" ");
    const show = document.createElement("button");
    show.type = "button"; show.className = "link-btn"; show.textContent = "Anzeigen";
    show.addEventListener("click", () => openUpdateView());
    el.append(show);
  }
}

// ---------- the update view: steps, megabytes, speed, errors (the shell pushes its state while it installs) ----------
const UPDATE_STEPS = ["preparing", "downloading", "verifying", "installing", "restarting"];
// request: the command that started it (for „Erneut versuchen“); waiting: sent, but the shell has not answered with a
// newer state (rev) than `sinceRev` yet, so an old error or "available" is not shown as the outcome
const updateView = { request: null, update: null, waiting: false, waitingSince: 0, sinceRev: -1, hidden: false };
function updateErrorText(u) {
  const raw = String(u.error || "");
  if (/^(Version .* läuft schon|Es gibt gerade kein Update)/.test(raw)) return raw;
  return {
    preparing: "Die Update-Infos von GitHub ließen sich nicht laden. Ist das Internet da?",
    downloading: "Der Download ist abgebrochen. Ist das Internet da? „Erneut versuchen“ lädt das Update noch einmal.",
    verifying: "Die heruntergeladene Datei hat keine gültige Signatur. Zur Sicherheit wurde nichts installiert.",
    installing: "Der Installer ließ sich nicht starten. Conclave läuft in der bisherigen Version weiter.",
  }[u.failed_step] || raw || "Unbekannter Fehler.";
}
function openUpdateView() {
  updateView.hidden = false;
  if (!$("#update-view").open) $("#update-view").showModal();
  renderUpdateView(updateView.update || { state: "preparing" });
}
// start an install: "install_update" (the announced update) or "install_version" (any version, also an older one)
async function startUpdate(request) {
  updateView.request = request;
  updateView.update = { state: "preparing", version: request.value || desktopShell?.update?.version, rev: -1 };
  updateView.waiting = true;
  updateView.waitingSince = Date.now();
  updateView.sinceRev = desktopShell?.update?.rev ?? -1;
  store.set("update", JSON.stringify({ to: updateView.update.version || "", from: desktopShell?.version || "", request }));
  openUpdateView();
  await api("/api/desktop/command", { method: "POST", body: request });
  clearTimeout(desktopTimer);
  desktopTimer = setTimeout(refreshDesktop, 400);
}
// what the poll brought: open the view when an install runs (also one started elsewhere), report the end
function followUpdate(u, version) {
  if (!u) return;
  const busy = UPDATE_BUSY.includes(u.state);
  if (updateView.waiting) {
    if ((u.rev ?? 0) > updateView.sinceRev && (busy || u.state === "error")) updateView.waiting = false;
    else if (Date.now() - updateView.waitingSince > 30000) {  // the shell never took the command
      updateView.waiting = false;
      u = { ...u, state: "error", failed_step: "preparing", error: "Die Desktop-App hat den Auftrag nicht angenommen." };
    } else return;  // the command has not reached the shell yet: keep "Vorbereiten"
  }
  if (busy) {
    updateView.update = u;
    if (!updateView.hidden && !$("#update-view").open) $("#update-view").showModal();
    renderUpdateView(u);
  } else if (updateView.update && UPDATE_BUSY.includes(updateView.update.state)) {
    updateView.update = u;  // the install ended without restarting: an error (or nothing happened)
    renderUpdateView(u);
    if (u.state === "error" && !$("#update-view").open) openUpdateView();
  }
  renderUpdateIndicator();
  const pending = (() => { try { return JSON.parse(store.get("update") || "null"); } catch { return null; } })();
  if (pending && !busy) {
    if (pending.to && version === pending.to && pending.from !== version) {
      if (!$("#whats-new").open) toast(`Conclave ${version} ist installiert.`, "success", 9000, { label: "Was ist neu?", run: () => openWhatsNew() });
      store.set("update", "");
    } else if (u.state === "error" && u.failed_step && !updateView.update) {
      updateView.request = pending.request;  // the app restarted after a failed install: show what went wrong
      updateView.update = u;
      openUpdateView();
      store.set("update", "");
    } else if (u.state !== "error") store.set("update", "");
  }
}
function renderUpdateView(u, { gone = false } = {}) {
  const state = gone ? "restarting" : u.state;
  const failed = state === "error";
  const step = failed ? (u.failed_step || "preparing") : state;
  const at = UPDATE_STEPS.indexOf(step);
  $$("#uv-steps li").forEach((li, i) => {
    li.className = i < at ? "done" : i === at ? (failed ? "failed" : "current") : "";
    li.toggleAttribute("aria-current", i === at);
  });
  const version = u.version || updateView.request?.value || "";
  const preview = /-/.test(version);
  $("#uv-title").textContent = failed ? "Update fehlgeschlagen"
    : version ? `${preview ? "Vorschau " : ""}${version} wird installiert` : "Update wird installiert";
  const from = u.current || desktopShell?.version;
  $("#uv-sub").textContent = from && version ? `Conclave ${from} → ${version}` : "Conclave";
  // percent, megabytes, speed, time left
  const bar = $("#uv-bar"), fill = bar.firstElementChild;
  const measured = state === "downloading" && u.total > 0;
  bar.classList.toggle("indeterminate", state === "preparing" || (state === "downloading" && !measured));
  bar.classList.toggle("working", ["verifying", "installing", "restarting"].includes(state));
  bar.hidden = failed;
  $(".uv-figures").hidden = failed;
  const pct = measured ? Math.min(100, Math.floor((u.downloaded / u.total) * 100))
    : ["verifying", "installing", "restarting"].includes(state) ? 100 : failed ? (u.progress ?? 0) : 0;
  fill.style.width = `${pct}%`;
  if (measured) bar.setAttribute("aria-valuenow", pct); else bar.removeAttribute("aria-valuenow");
  $("#uv-percent").textContent = state === "downloading" ? (measured ? `${pct} %` : fmtMB(u.downloaded || 0) + " MB") : failed ? "" : state === "preparing" ? "" : "100 %";
  let detail = "";
  if (state === "downloading") {
    const parts = [measured ? `${fmtMB(u.downloaded || 0)} von ${fmtMB(u.total)} MB` : "Größe unbekannt"];
    if (u.speed > 0) parts.push(`${fmtNum(u.speed / 1048576, "", 1)} MB/s`);
    if (measured && u.speed > 0) parts.push(fmtLeft((u.total - u.downloaded) / u.speed));
    detail = parts.join(" · ");
  } else if (["verifying", "installing", "restarting"].includes(state) && u.total) detail = `${fmtMB(u.total)} MB geladen`;
  $("#uv-detail").textContent = detail;
  $("#uv-status").textContent = {
    preparing: "Fragt GitHub nach der Update-Datei …",
    downloading: "Lädt das Update herunter. Du kannst so lange weiterarbeiten.",
    verifying: "Prüft die Signatur, damit nur echte Conclave-Updates installiert werden …",
    installing: "Beendet den Hintergrunddienst und startet den Installer …",
    restarting: "Der Installer läuft. Conclave schließt sich kurz und startet danach von selbst neu.",
    error: "",
  }[state] ?? "";
  $("#uv-error").hidden = !failed;
  if (failed) {
    $("#uv-error-text").textContent = updateErrorText(u);
    $("#uv-error-raw").textContent = u.error || "–";
  }
  $("#uv-hide").hidden = failed || ["installing", "restarting"].includes(state);
  $("#uv-close").hidden = !failed;
  $("#uv-log").hidden = !failed;
  $("#uv-retry").hidden = !failed || !updateView.request || /^Version .* läuft schon/.test(u.error || "");
  $("#update-view .dialog-actions").hidden = $$("#update-view .dialog-actions .btn").every((b) => b.hidden);
  renderUpdateIndicator();
}
// the sidebar pill while the view is hidden: a ring with the percentage
function renderUpdateIndicator() {
  const u = updateView.update, ind = $("#update-indicator");
  const show = !!u && !$("#update-view").open && (UPDATE_BUSY.includes(u.state) || (u.state === "error" && updateView.hidden));
  ind.hidden = !show;
  if (!show) return;
  const pct = u.state === "downloading" && u.total > 0 ? Math.floor((u.downloaded / u.total) * 100) : u.state === "preparing" ? 0 : 100;
  ind.style.setProperty("--p", pct);
  ind.classList.toggle("failed", u.state === "error");
  $("#update-indicator-text").textContent = u.state === "error" ? "Update fehlgeschlagen"
    : u.state === "downloading" ? `Update lädt … ${u.total > 0 ? pct + " %" : ""}` : "Update wird installiert …";
}
$("#update-indicator").addEventListener("click", openUpdateView);
$("#uv-hide").addEventListener("click", () => { updateView.hidden = true; $("#update-view").close(); renderUpdateIndicator(); });
$("#uv-close").addEventListener("click", () => { updateView.hidden = false; updateView.update = null; $("#update-view").close(); renderUpdateIndicator(); });
$("#uv-log").addEventListener("click", () => api("/api/desktop/command", { method: "POST", body: { type: "open_log" } }).catch(fail));
$("#uv-retry").addEventListener("click", () => { if (updateView.request) startUpdate(updateView.request).catch(fail); });
$("#update-view").addEventListener("cancel", (e) => {  // Esc: hide while downloading, never during the install itself
  const st = updateView.update?.state;
  e.preventDefault();
  if (st === "error" || !UPDATE_BUSY.includes(st)) $("#uv-close").click();
  else if (!["installing"].includes(st)) $("#uv-hide").click();
});
$("#desktop-check").addEventListener("click", async () => {
  try {
    await api("/api/desktop/command", { method: "POST", body: { type: "check_update" } });
    $("#desktop-update").textContent = "Suche nach Updates …";
    clearTimeout(desktopTimer);
    desktopTimer = setTimeout(refreshDesktop, 15000);
  } catch (err) { fail(err); }
});
$("#desktop-install").addEventListener("click", () => startUpdate({ type: "install_update" }).catch(fail));
// preview builds and switching to any other version (also back to an older one)
let desktopReleases = [];
const versionKey = (v) => {  // 0.1.10-preview.3 sorts after 0.1.9 and before 0.1.10
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[^.]+\.(\d+))?/.exec(v || "") || [];
  return [+m[1] || 0, +m[2] || 0, +m[3] || 0, m[4] === undefined ? Infinity : +m[4]];
};
const olderThan = (a, b) => { const x = versionKey(a), y = versionKey(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };
async function loadDesktopVersions() {
  const sel = $("#desktop-versions"), note = $("#desktop-versions-note"), current = desktopShell?.version;
  note.textContent = "Lädt die Versionen von GitHub …";
  $("#desktop-switch").disabled = true;
  try { desktopReleases = (await api("/api/desktop/releases")).releases; } catch (err) { note.textContent = err.message; return; }
  sel.innerHTML = desktopReleases.map((r) => {
    const date = r.date ? new Date(r.date).toLocaleDateString("de-DE", { day: "numeric", month: "short" }) : "";
    const label = `${r.version}${r.preview ? " · Vorschau" : ""}${date ? ` · ${date}` : ""}${r.version === current ? " · läuft gerade" : ""}`;
    return `<option value="${esc(r.version)}"${r.version === current ? " disabled" : ""}>${esc(label)}</option>`;
  }).join("");
  const pick = desktopReleases.find((r) => r.version !== current && olderThan(r.version, current)) || desktopReleases.find((r) => r.version !== current);
  if (pick) sel.value = pick.version;
  note.textContent = desktopReleases.length ? "" : "Keine Versionen gefunden.";
  $("#desktop-switch").disabled = !pick;
}
$("#desktop-other").addEventListener("toggle", (e) => { if (e.target.open) void loadDesktopVersions(); });
$("#desktop-versions").addEventListener("change", () => { $("#desktop-switch").disabled = !$("#desktop-versions").value; });
$("#desktop-preview").addEventListener("change", async (e) => {
  try {
    await api("/api/settings", { method: "POST", body: { desktop_preview: e.target.checked } });
    await api("/api/desktop/command", { method: "POST", body: { type: "check_update" } });
    toast(e.target.checked ? "Vorschau-Versionen werden ab jetzt angeboten." : "Nur noch freigegebene Versionen. Eine Vorschau bleibt, bis die nächste Version kommt.");
    if ($("#desktop-other").open) void loadDesktopVersions();
    clearTimeout(desktopTimer);
    desktopTimer = setTimeout(refreshDesktop, 15000);
  } catch (err) { fail(err); }
});
$("#desktop-switch").addEventListener("click", async () => {
  const version = $("#desktop-versions").value, current = desktopShell?.version;
  const r = desktopReleases.find((x) => x.version === version);
  if (!r) return;
  const older = olderThan(version, current);
  const ok = await ask({
    title: `Zu Version ${version} wechseln?`,
    text: older
      ? `Version ${version} ist älter als ${current}. Was danach dazukam, fehlt dort. Vorher wird eine Sicherung deiner Daten angelegt, dann startet die App neu. Neuere Versionen bietet sie dir weiter an.`
      : `Vorher wird eine Sicherung deiner Daten angelegt, dann startet die App neu.`,
    ok: "Wechseln",
  });
  if (!ok) return;
  try {
    await api("/api/backups", { method: "POST" });
    await startUpdate({ type: "install_version", value: version });
  } catch (err) { fail(err); }
});
$("#desktop-autostart").addEventListener("change", async (e) => {
  try {
    await api("/api/desktop/command", { method: "POST", body: { type: "autostart", value: e.target.checked } });
    toast(e.target.checked ? "Startet künftig beim Anmelden im Hintergrund." : "Startet nicht mehr automatisch.");
  } catch (err) { fail(err); }
});
$("#desktop-notify").addEventListener("change", async (e) => {
  try { await api("/api/settings", { method: "POST", body: { desktop_notify: e.target.checked } }); } catch (err) { fail(err); }
});
$("#desktop-data").addEventListener("click", () => api("/api/desktop/command", { method: "POST", body: { type: "open_data" } }).catch(fail));
$("#desktop-log").addEventListener("click", () => api("/api/desktop/command", { method: "POST", body: { type: "open_log" } }).catch(fail));
if (/Mac|iPhone|iPad/.test(navigator.platform)) $("#palette-btn kbd").textContent = "⌘ K";

// ---------- „Was ist neu?“ (issue #129): once after an update, and from Über Conclave and Ctrl+K ----------
let whatsNewSeen = null;  // the version to mark as seen when the dialog closes (only when it opened by itself)
const wnText = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
const wnRelease = (r, head) => `<section class="wn-release">${head ? `<h3>Conclave ${esc(r.version)}</h3>` : ""}`
  + `<ul class="wn-items">${r.items.map((it) => `<li><div><b>${wnText(it.title)}</b><p>${wnText(it.text)}</p></div></li>`).join("")}</ul></section>`;
function showWhatsNew(version, releases, { preview = false } = {}) {
  const one = releases.length === 1;
  const names = releases.map((r) => r.version).reverse();
  $("#wn-title").textContent = one ? `Neu in Conclave ${names[0]}` : releases.length ? "Neu seit deinem letzten Update" : "Was ist neu?";
  $("#wn-sub").textContent = preview ? `Vorschau-Version ${version}: das kommt mit Conclave ${names.at(-1) || "der nächsten Version"}.`
    : one ? "Das bringt diese Version mit." : releases.length ? `Die Versionen ${names.join(", ").replace(/, ([^,]+)$/, " und $1")}.` : "";
  $("#wn-body").innerHTML = releases.length ? releases.map((r) => wnRelease(r, !one)).join("")
    : '<p class="empty-inline">Zu dieser Version gibt es keine Notizen.</p>';
  const older = $("#wn-older");
  older.open = false;
  older.dataset.after = releases.at(-1)?.version || "";
  $("#wn-older-body").innerHTML = "";
  if (!$("#whats-new").open) { setNavOpen(false); $("#whats-new").showModal(); }
}
// „Frühere Versionen“: the notes older than the ones shown, loaded when opened
$("#wn-older").addEventListener("toggle", async (e) => {
  const box = e.currentTarget;
  if (!box.open || $("#wn-older-body").innerHTML) return;
  let all;
  try { all = (await api("/api/whatsnew?all=1")).releases; } catch (err) { return fail(err); }
  const rest = all.slice(all.findIndex((r) => r.version === box.dataset.after) + 1);
  $("#wn-older-body").innerHTML = rest.length ? rest.map((r) => wnRelease(r, true)).join("") : '<p class="muted small">Keine älteren Notizen.</p>';
});
async function openWhatsNew() {
  let d;
  try { d = await api("/api/whatsnew?all=1"); } catch (err) { return fail(err); }
  showWhatsNew(d.version, d.current ? [d.current] : [], { preview: d.preview });
}
// at the start: the notes once after an update. In the desktop app wait for the shell's first poll, since a preview
// build's number is only the shell's. A fresh install marks its version as seen without showing anything.
async function checkWhatsNew(tries = 0) {
  let h;
  try { h = await api("/api/health"); } catch { return; }
  if (h.frozen && !desktopShell) {
    try { desktopShell = (await api("/api/desktop")).shell; } catch { /* asked again below */ }
    if (!desktopShell && tries < 8) return void setTimeout(() => checkWhatsNew(tries + 1), 2000);
  }
  let d;
  try { d = await api("/api/whatsnew"); } catch { return; }
  if (d.show && !$("#update-view").open) {
    whatsNewSeen = d.version;
    showWhatsNew(d.version, d.releases, { preview: d.preview });
  } else if (!d.seen) void api("/api/whatsnew/seen", { method: "POST", body: { version: d.version } }).catch(() => {});
}
$("#whats-new").addEventListener("close", () => {
  if (whatsNewSeen) void api("/api/whatsnew/seen", { method: "POST", body: { version: whatsNewSeen } }).catch(() => {});
  whatsNewSeen = null;
});
$("#wn-close").addEventListener("click", () => $("#whats-new").close());
$("#about-whatsnew").addEventListener("click", () => openWhatsNew());
