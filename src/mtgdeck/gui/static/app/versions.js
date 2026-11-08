"use strict";
// The desktop GUI, part 12 of 21: the Verlauf tab: versions, diffs, restore, copy.
// index.html loads the parts in order; they share one global scope.

// ============================================================================================
// tab "Verlauf": versions, diffs, restore, copy
// ============================================================================================
let versions = [];

async function renderHistory(d) {
  versions = await api(`/api/decks/${enc(d.slug)}/versions`).catch(() => []);
  if (currentDeck?.slug !== d.slug) return;
  $("#version-count").textContent = versions.length > 1 ? versions.length : "";
  $("#compare-result").hidden = true;
  const cur = (d.currency || "eur").toUpperCase();
  $("#history").innerHTML = versions.length ? versions.slice().reverse().map((h) => `<li>
    <div class="vhead">
      <span class="vnum">${h.version ? "v" + h.version : "–"}</span>
      ${h.current ? '<span class="pill ok">aktuell</span>' : ""}
      <span class="when">${esc(fmtDate(h.at))}</span>
      <span class="muted small">${h.from && h.from !== h.to ? `${esc(h.from)} → ` : ""}${esc(h.to || "")}
        · ${esc(fmtPrice(h.price, cur))} · Power ${esc(fmtPower(h.power))}</span>
    </div>
    ${h.note ? `<div>${esc(h.note)}</div>` : ""}
    ${h.added?.length ? `<div class="plus">+ ${esc(h.added.join(", "))}</div>` : ""}
    ${h.removed?.length ? `<div class="minus">− ${esc(h.removed.join(", "))}</div>` : ""}
    ${h.version ? `<div class="vactions">
      ${!h.current ? `<button type="button" class="btn small" data-act="diff" data-v="${h.version}">Mit aktuell vergleichen</button>` : ""}
      ${h.restorable && !h.current ? `<button type="button" class="btn small" data-act="restore" data-v="${h.version}">Wiederherstellen</button>` : ""}
      ${h.restorable ? `<button type="button" class="btn small ghost" data-act="copy" data-v="${h.version}">Als neues Deck</button>` : ""}
      ${h.restorable ? `<button type="button" class="btn small ghost" data-act="text" data-v="${h.version}">Liste kopieren</button>` : ""}
    </div>` : ""}
  </li>`).join("") : '<li class="empty-inline">Noch keine Versionen – jede gespeicherte Änderung legt eine an.</li>';
  const opts = versions.filter((h) => h.restorable).map((h) => `<option value="${h.version}">v${h.version}${h.current ? " (aktuell)" : ""}</option>`).join("");
  const form = $("#compare-form").elements;
  form.a.innerHTML = opts;
  form.b.innerHTML = opts;
  const n = versions.filter((h) => h.restorable).length;
  if (n > 1) form.a.selectedIndex = n - 2;
  form.b.selectedIndex = n - 1;
  $("#compare-form").hidden = n < 2;
}

async function showDiff(a, b) {
  const r = await api(`/api/decks/${enc(currentDeck.slug)}/diff?a=${a}${b ? `&b=${b}` : ""}`);
  const box = $("#compare-result");
  const delta = (x, f) => (x.from === x.to || x.from == null || x.to == null ? esc(f(x.to)) : `${esc(f(x.from))} → <b>${esc(f(x.to))}</b>`);
  box.innerHTML = `<b>v${r.from_version} → v${r.to_version}</b>
    <dl class="kv">
      <dt>Stufe</dt><dd>${r.level.from === r.level.to ? esc(r.level.to) : `${esc(r.level.from)} → <b>${esc(r.level.to)}</b>`}</dd>
      <dt>Power</dt><dd>${delta(r.power, fmtPower)}</dd>
      <dt>Preis</dt><dd>${delta(r.price, (v) => fmtPrice(v, (currentDeck.currency || "eur").toUpperCase()))}</dd>
      <dt>Rein (${r.added.length})</dt><dd class="plus">${esc(r.added.join(", ") || "–")}</dd>
      <dt>Raus (${r.removed.length})</dt><dd class="minus">${esc(r.removed.join(", ") || "–")}</dd>
    </dl>`;
  box.hidden = false;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("#compare-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target.elements;
  showDiff(f.a.value, f.b.value).catch(fail);
});

$("#history").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !currentDeck) return;
  const v = Number(btn.dataset.v);
  try {
    if (btn.dataset.act === "diff") await showDiff(v);
    if (btn.dataset.act === "copy") await copyAsDeck(v);
    if (btn.dataset.act === "text") {
      const snap = await api(`/api/decks/${enc(currentDeck.slug)}/versions/${v}`);
      await navigator.clipboard.writeText(snap.export_text);
      toast(`Liste von v${v} kopiert.`);
    }
    if (btn.dataset.act === "restore") {
      const ok = await ask({ title: `Version ${v} wiederherstellen?`, text: "Sie wird als neue Version gespeichert – nichts geht verloren.", ok: "Wiederherstellen" });
      if (!ok) return;
      await api(`/api/decks/${enc(currentDeck.slug)}/versions/${v}/restore`, { method: "POST" });
      currentDeck = null;
      await refreshDeckList();
      await route();
      toast(`Version ${v} wiederhergestellt.`);
    }
  } catch (err) { fail(err); }
});
