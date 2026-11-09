"use strict";
// The desktop GUI, part 1 of 21: small helpers every part uses: $, api(), toast(), ask(), formats, the store.
// index.html loads the parts in order; they share one global scope.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = encodeURIComponent;

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error("Keine Verbindung zur App – läuft mtg-gui noch? Bitte neu starten und die Seite neu laden.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(errorText(res, data)), { status: res.status });
  return data;
}

// a readable German message for a failed request
function errorText(res, data) {
  const d = data?.detail;
  if (typeof d === "string" && d) return d;
  if (Array.isArray(d) && d.length) {  // pydantic: [{loc, msg}]
    return "Ungültige Eingabe: " + d.map((e) => `${(e.loc || []).filter((x) => x !== "body").join(".")} ${e.msg || ""}`.trim()).join("; ");
  }
  if (res.status >= 500) return `Interner Fehler (${res.status}) – Details stehen im Fenster, in dem mtg-gui läuft.`;
  if (res.status === 404) return "Nicht gefunden – vielleicht wurde es inzwischen gelöscht.";
  return `Anfrage fehlgeschlagen (${res.status})`;
}

// follow a job's events; onLost(text) when the job is gone (app restarted) – null while reconnecting
function jobStream(jobId, onEvent, onLost) {
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  es.onopen = () => onLost(false);
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      onLost("Die Verbindung zum Auftrag ist weg – vermutlich wurde die App neu gestartet. Bitte den Auftrag noch einmal starten.");
    } else onLost(null);  // the browser reconnects; the server resumes via Last-Event-ID
  };
  return es;
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const store = {  // per-browser conveniences only (view mode); failures are harmless
  get(k) { try { return localStorage.getItem("mtgdeck." + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("mtgdeck." + k, v); } catch { /* ignore */ } },
};

// German number format everywhere: 32,00 € · 3,8 · 1.234
const fmtNum = (v, suffix = "", digits = null) => {
  if (v === null || v === undefined || v === "" || Number.isNaN(Number(v))) return v === null || v === undefined || v === "" ? "–" : `${v}${suffix}`;
  const opts = digits === null ? { maximumFractionDigits: 2 } : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  return `${Number(v).toLocaleString("de-DE", opts)}${suffix}`;
};
const fmtPower = (v) => fmtNum(v, "", 1);
const CURRENCY_SIGNS = { eur: "€", usd: "$", "€": "€", "$": "$" };
const fmtPrice = (v, cur = "") => fmtNum(v, cur ? " " + (CURRENCY_SIGNS[String(cur).toLowerCase()] || cur) : "", 2);
const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.replace("T", " ").slice(0, 16) : d.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
};
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// non-blocking notifications (success, hints, errors)
function toast(text, kind = "info", ms = 4500, action = null) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === "error" ? "alert" : "check")}<span>${esc(text)}</span>`;
  if (action) {  // e.g. { label: "Rückgängig", run: () => … }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-action";
    b.textContent = action.label;
    b.addEventListener("click", () => { el.remove(); action.run(); });
    el.appendChild(b);
  }
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? ms + 3000 : ms);
  return el;
}
const fail = (err) => toast(err.message || String(err), "error");

// confirm / prompt as a proper dialog. Returns true (confirm), the entered text (prompt) or null.
function ask({ title, text = "", value = null, ok = "OK", danger = false }) {
  const dlg = $("#ask-dialog"), input = $("#ask-input");
  $("#ask-title").textContent = title;
  $("#ask-text").textContent = text;
  $("#ask-text").hidden = !text;
  input.hidden = value === null;
  input.value = value ?? "";
  $("#ask-ok").textContent = ok;
  $("#ask-ok").classList.toggle("danger-fill", danger);
  return new Promise((resolve) => {
    const done = (result) => { resolve(result); if (dlg.open) dlg.close(); };
    $("#ask-cancel").onclick = () => done(null);
    $("#ask-form").onsubmit = (e) => { e.preventDefault(); done(value === null ? true : input.value.trim() || null); };
    dlg.onclose = () => resolve(null);
    dlg.showModal();
    if (value !== null) { input.focus(); input.select(); } else $("#ask-ok").focus();
  });
}

// dialogs close on a click outside their box (Esc works natively)
for (const dlg of $$("dialog")) {
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
}
