"use strict";
// The desktop GUI, part 11 of 21: the Partien tab: game log, record and the game form.
// index.html loads the parts in order; they share one global scope.

// ============================================================================================
// tab "Partien": game log, record and "learn from your games"
// ============================================================================================
let gameData = null;  // { slug, games, stats, learn_focus, issue_labels, result_labels }

async function loadGames(d) {
  renderKnownOpps();
  renderGameForm();
  $("#game-deck-cards").innerHTML = [...d.commanders, ...d.cards.map((c) => c.name)].map((n) => `<option value="${esc(n)}">`).join("");
  try {
    const data = await api(`/api/decks/${enc(d.slug)}/games`);
    if (currentDeck?.slug !== d.slug) return;
    renderGames(d.slug, data);
  } catch { /* the tab shows the empty state */ }
}

function renderGames(slug, data) {
  const first = !gameData;
  gameData = { slug, ...data };
  const formBox = $("#game-form-box");
  if (formBox.dataset.slug !== slug) {
    formBox.dataset.slug = slug;
    resetGameForm();
    formBox.open = !data.games.length;
  }
  if (first || !$("#game-issues").children.length) {
    // the reasons that happen most first; six at a time, the rest behind "mehr …"
    const seen = Object.fromEntries((data.stats.issues || []).map((i) => [i.key, i.count]));
    const keys = Object.keys(data.issue_labels).sort((a, b) => (seen[b] || 0) - (seen[a] || 0));
    $("#game-issues").innerHTML = keys.map((k, i) =>
      `<label${i >= 6 ? " hidden" : ""}><input type="checkbox" name="issues" value="${esc(k)}"><span>${esc(data.issue_labels[k])}</span></label>`).join("")
      + (keys.length > 6 ? '<button type="button" class="chip" id="game-issues-more">mehr …</button>' : "");
  }
  const st = data.stats;
  $("#game-count").textContent = st.games || "";
  $("#game-learn").hidden = !data.learn_focus;
  $("#game-learn").textContent = data.learn_focus ? `${data.learn_focus}.` : "";
  const pct = st.win_rate === null ? "–" : `${Math.round(st.win_rate * 100)} %`;
  const maxIssue = Math.max(1, ...st.issues.map((i) => i.count));
  $("#game-stats").innerHTML = !st.games ? '<p class="empty-inline">Die Bilanz erscheint nach der ersten Partie.</p>' : `
    <div class="kpis"><div><b>${st.games}</b><span>Partien</span></div><div><b>${st.wins}–${st.losses}${st.draws ? "–" + st.draws : ""}</b><span>Siege–Niederlagen</span></div>
      <div><b>${pct}</b><span>Siegquote</span></div><div><b>${st.avg_turn ?? "–"}</b><span>Ø Zug am Ende</span></div></div>
    ${st.issues.length ? `<h3 class="small muted">Häufigste Probleme</h3><ul class="issue-bars">${st.issues.slice(0, 6).map((i) =>
      `<li><span>${esc(i.label)}</span><span class="bar"><i style="width:${(i.count / maxIssue) * 100}%"></i></span><span>${i.count}×</span></li>`).join("")}</ul>` : ""}
    ${st.per_version.length > 1 ? `<p class="game-stats-more">Pro Version: ${st.per_version.map((v) => `v${v.version} ${v.wins}/${v.games}`).join(" · ")}</p>` : ""}
    ${st.mvps.length ? `<p class="game-stats-more">Beste Karten: ${st.mvps.map((m) => `${esc(m.name)}${m.count > 1 ? ` (${m.count}×)` : ""}`).join(", ")}</p>` : ""}
    ${st.opponents.length ? `<p class="game-stats-more">Häufigste Gegner: ${st.opponents.map((o) => esc(o.name)).join(", ")}</p>` : ""}
    ${st.places ? `<p class="game-stats-more">Platzierung: Ø ${fmtNum(st.places.avg)}${st.places.avg_players ? ` bei ${fmtNum(st.places.avg_players)} Spielern` : ""} · ${st.places.counts.map((c) => `${c.count}× ${c.place}. Platz`).join(" · ")}</p>` : ""}
    ${st.rounds ? roundStatsHtml(st.rounds) : ""}`;
  $("#game-empty").hidden = !!data.games.length;
  $("#game-list").innerHTML = data.games.slice().reverse().map((g) => `<li data-id="${esc(g.id)}">
      <div class="when"><span class="res ${esc(g.result)}">${esc(data.result_labels[g.result] || g.result)}</span>${g.place ? `<br><span class="place${g.place === 1 ? " first" : ""}">${esc(g.place)}. Platz</span>` : ""}<br><span class="meta">${esc(fmtDate(g.played))}${g.version ? ` · v${esc(g.version)}` : ""}</span></div>
      <div>${g.opponents.length ? `gegen ${g.opponents.map((o, i) => (g.opponent_ids?.[i] ? `<a href="#/opponents/${enc(g.opponent_ids[i])}">${esc(o)}</a>` : esc(o)) + (g.opponent_places?.[i] ? ` <span class="place${g.opponent_places[i] === 1 ? " first" : ""}">(${esc(g.opponent_places[i])}.)</span>` : "")).join(", ")}` : '<span class="meta">Gegner nicht notiert</span>'}${g.turn ? ` · Zug ${esc(g.turn)}` : ""}${g.how && data.how_labels?.[g.how] ? ` · ${esc(data.how_labels[g.how])}` : ""}
        ${g.started === "me" ? '<br><span class="meta">Ich habe angefangen</span>' : Number.isInteger(g.started) && g.opponents[g.started] ? `<br><span class="meta">Angefangen: ${esc(g.opponents[g.started])}</span>` : ""}
        ${g.mvp ? `<br>Beste Karte: <strong>${esc(g.mvp)}</strong>` : ""}${g.note ? `<br><span class="meta">${esc(g.note)}</span>` : ""}
        ${g.issues.length ? `<div class="issues">${g.issues.map((i) => `<span>${esc(data.issue_labels[i] || i)}</span>`).join("")}</div>` : ""}
        ${g.round_turns ? roundBoxHtml(g.round, g.round_turns) : ""}</div>
      <button type="button" class="icon-btn game-del" aria-label="Partie löschen" title="Partie löschen">${icon("x")}</button></li>`).join("");
}

// rounds counted with Conclave Table (or the phone's former Runden-Helfer): what they say over all games, and one round turn by turn
const cmdShort = (name) => String(name || "").split(",")[0].split(" // ")[0];
function roundStatsHtml(r) {
  const maxLost = Math.max(1, ...r.per_turn.map((t) => t.avg_lost));
  return `<h3 class="small muted round-stats-head">Aus den Runden-Protokollen · ${r.rounds} ${r.rounds === 1 ? "Runde" : "Runden"}</h3>
    ${r.sources.length ? `<p class="game-stats-more">Am meisten Schaden: ${r.sources.slice(0, 3).map((x) => `<strong>${esc(cmdShort(x.name))}</strong> ${x.damage}${x.cmd ? ` (${x.cmd} Commander-Schaden)` : ""}${r.rounds > 1 ? ` in ${x.rounds} ${x.rounds === 1 ? "Runde" : "Runden"}` : ""}`).join(" · ")}</p>` : ""}
    ${r.per_turn.some((t) => t.avg_lost) ? `<p class="game-stats-more">Leben verloren pro eigenem Zug${r.rounds > 1 ? " (Schnitt)" : ""}:</p>
      <ul class="issue-bars turn-bars">${r.per_turn.slice(0, 10).map((t) => `<li${r.worst_turn?.turn === t.turn ? ' class="worst"' : ""}><span>Zug ${t.turn}</span><span class="bar"><i style="width:${(t.avg_lost / maxLost) * 100}%"></i></span><span>${t.avg_lost ? "−" + fmtNum(t.avg_lost) : "0"}</span></li>`).join("")}</ul>` : ""}
    ${r.avg_end_life !== null ? `<p class="game-stats-more">Leben am Ende${r.rounds > 1 ? " im Schnitt" : ""}: ${fmtNum(r.avg_end_life)}${r.poison_rounds ? ` · Gift in ${r.poison_rounds} ${r.poison_rounds === 1 ? "Runde" : "Runden"}` : ""}</p>` : ""}`;
}

function roundBoxHtml(r, turns) {
  const mins = r.started && r.ended ? Math.max(0, Math.round((new Date(r.ended) - new Date(r.started)) / 60000)) : null;
  const pts = [r.start_life, ...turns.map((t) => t.life)];
  const W = 300, H = 56, max = Math.max(...pts, 1), min = Math.min(0, ...pts);
  const spark = pts.length > 2 ? `<svg class="round-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Leben pro Zug: ${pts.join(", ")}">
    <polyline points="${pts.map((v, i) => `${((i / (pts.length - 1)) * W).toFixed(1)},${(H - 4 - ((v - min) / (max - min || 1)) * (H - 8)).toFixed(1)}`).join(" ")}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>` : "";
  const cmd = (r.cmd || []).filter((c) => c.dmg).sort((a, b) => b.dmg - a.dmg);
  return `<details class="more round-box"><summary>Runde ansehen <span class="muted">· ${esc(r.life ?? "–")} Leben am Ende · ${turns.length} ${turns.length === 1 ? "Zug" : "Züge"}${mins !== null ? ` · ${mins} Min.` : ""}</span></summary>
    <div class="round-head">${spark}
      <div class="round-facts"><span>Start <b>${esc(r.start_life)}</b></span><span>Ende <b>${esc(r.life ?? "–")}</b></span>${r.poison ? `<span>Gift <b>${esc(r.poison)}</b></span>` : ""}
        ${cmd.map((c) => `<span>${esc(cmdShort(c.name))} <b>${esc(c.dmg)}</b>/21</span>`).join("")}</div></div>
    <table class="round-turns"><thead><tr><th>Zug</th><th>Leben</th><th>Was passiert ist</th></tr></thead><tbody>
      ${turns.slice().reverse().map((t) => `<tr><td>${t.turn}</td><td><b>${t.life}</b>${t.lost || t.gained ? ` <span class="${t.lost > t.gained ? "down" : "up"}">${t.lost > t.gained ? "−" + (t.lost - t.gained) : "+" + (t.gained - t.lost)}</span>` : ""}</td>
        <td>${t.events.length ? t.events.map(esc).join(" · ") : '<span class="muted">nichts</span>'}${t.notes.map((n) => `<br><em>${esc(n)}</em>`).join("")}</td></tr>`).join("")}
    </tbody></table></details>`;
}

// ---------- the game form, like the phone's game sheet: result, opponents as chips, places, the rest folded away ----------
const GAME_OPPS_MAX = 5;
let gameOpps = [];  // [{name, id, note, place, image}]
let gameMe = null;  // my finishing place

function resetGameForm() {
  $("#game-form").reset();
  gameOpps = []; gameMe = null;
  renderGameForm();
}
const commanderArt = (url) => (url ? url.replace("/normal/", "/art_crop/") : "");

function addGameOpp(name, id = null) {
  name = name.trim();
  if (!name) return;
  if (gameOpps.some((o) => (id && o.id === id) || o.name.toLowerCase() === name.toLowerCase())) return;
  if (gameOpps.length >= GAME_OPPS_MAX) { toast(`Höchstens ${GAME_OPPS_MAX} Gegner.`, "error"); return; }
  const known = id ? oppIndex.find((o) => o.id === id) : oppIndex.find((o) => o.commanders.some((c) => c.toLowerCase() === name.toLowerCase()));
  const o = { name, id: known?.id || null, note: "", place: null, image: commanderArt(known?.image) };
  gameOpps.push(o);
  if (!o.image) void api(`/api/card?name=${enc(name)}`).then((c) => { o.image = commanderArt(c.image); renderGameForm(); }).catch(() => {});
  renderGameForm();
}

function renderGameForm() {
  const form = $("#game-form");
  const result = form.elements.result.value;
  // opponents
  $("#game-opps").innerHTML = gameOpps.map((o, i) => `<span class="gf-opp" role="listitem">${o.image ? `<img src="${esc(o.image)}" alt="">` : '<i aria-hidden="true"></i>'}
      <span>${esc(o.name)}</span><button type="button" class="icon-btn" data-remove="${i}" aria-label="${esc(o.name)} entfernen">${icon("x")}</button></span>`).join("");
  $("#game-opp-add").hidden = gameOpps.length >= GAME_OPPS_MAX;
  const known = $$("#game-known-opps button[data-oid]");
  for (const b of known) b.hidden = gameOpps.some((o) => o.id === b.dataset.oid);
  $("#game-known-opps").hidden = !known.some((b) => !b.hidden);
  // places: me + the opponents, 1..N
  const n = 1 + gameOpps.length;
  if (gameMe > n) gameMe = null;
  for (const o of gameOpps) if (o.place > n) o.place = null;
  const rows = [{ who: "me", name: "Ich", place: gameMe }, ...gameOpps.map((o, i) => ({ who: String(i), name: o.name, place: o.place }))];
  $("#game-places-box").hidden = n < 2;
  $("#game-places").innerHTML = n < 2 ? "" : rows.map((r) => `<div class="place-row${r.place === 1 ? " first" : ""}" data-who="${r.who}">
      <span class="place-name">${esc(r.name)}${r.place === 1 ? ` <span class="first-label">${icon("trophy")}Gewinner</span>` : ""}</span>
      <span class="place-pick" role="radiogroup" aria-label="Platz: ${esc(r.name)}">${Array.from({ length: n }, (_, k) => k + 1).map((x) =>
        `<button type="button" role="radio" data-place="${x}" aria-checked="${r.place === x}" aria-label="${x}. Platz">${x}</button>`).join("")}</span>
    </div>`).join("");
  // what went wrong: only after a loss or a draw
  $("#game-issues-box").hidden = !(result === "loss" || result === "draw");
  // notes per opponent (under "Mehr Details")
  const notes = $("#game-opp-notes");
  const typing = notes.contains(document.activeElement);
  if (!typing) {
    notes.innerHTML = gameOpps.map((o, i) => `<label class="field"><span>Aufgefallen bei ${esc(o.name)}</span>
      <input data-note="${i}" value="${esc(o.note)}" placeholder="z. B. Combo mit Thassa's Oracle"></label>`).join("");
  }
  // the one primary button names what gets saved
  const label = { win: "Sieg speichern", loss: "Niederlage speichern", draw: "Unentschieden speichern" }[result] || "Partie speichern";
  $("#game-save").textContent = label;
  $("#game-save").disabled = !result;
  $("#game-save-hint").hidden = !!result;
  const els = form.elements;
  const howLabel = $(`#game-how input:checked + span`)?.textContent || "";
  $("#game-more-sum").textContent = [els.turn.value ? `Zug ${els.turn.value}` : "", howLabel, els.mvp.value.trim(), els.note.value.trim() ? "Notiz" : ""].filter(Boolean).join(" · ");
}

// a place (the same again clears it); the last open player gets the place left; my 1st place = win, later = loss
function setGamePlace(who, place) {
  const get = (w) => (w === "me" ? gameMe : gameOpps[Number(w)].place);
  const set = (w, v) => { if (w === "me") gameMe = v; else gameOpps[Number(w)].place = v; };
  set(who, get(who) === place ? null : place);
  const all = ["me", ...gameOpps.map((_, i) => String(i))];
  const open = all.filter((w) => !get(w));
  const taken = new Set(all.map(get).filter(Boolean));
  if (get(who) && open.length === 1 && taken.size === all.length - 1) set(open[0], all.map((_, i) => i + 1).find((x) => !taken.has(x)));
  const els = $("#game-form").elements;
  if (gameMe === 1) els.result.value = "win";
  else if (gameMe && els.result.value !== "draw") els.result.value = "loss";
}

wireAutocomplete($("#game-opp-input"), $("#ac-game-opp"));
const addTypedOpp = () => { const input = $("#game-opp-input"); addGameOpp(input.value); input.value = ""; input.focus(); };
$("#game-opp-btn").addEventListener("click", addTypedOpp);
$("#game-opp-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTypedOpp(); } });
$("#game-opps").addEventListener("click", (e) => {
  const b = e.target.closest("[data-remove]");
  if (!b) return;
  gameOpps.splice(Number(b.dataset.remove), 1);
  renderGameForm();
});
$("#game-places").addEventListener("click", (e) => {
  const b = e.target.closest("[data-place]");
  if (!b) return;
  setGamePlace(b.closest("[data-who]").dataset.who, Number(b.dataset.place));
  renderGameForm();
});
$("#game-issues").addEventListener("click", (e) => {
  if (e.target.id !== "game-issues-more") return;
  for (const l of $$("#game-issues label")) l.hidden = false;
  e.target.remove();
});
$("#game-opp-notes").addEventListener("input", (e) => { if (e.target.dataset.note) gameOpps[Number(e.target.dataset.note)].note = e.target.value; });
// a picked "how" can be taken back by clicking it again
$("#game-how").addEventListener("click", (e) => {
  const input = e.target.closest("label")?.querySelector("input");
  if (input?.checked && e.target.tagName === "SPAN") { e.preventDefault(); input.checked = false; renderGameForm(); }
});
$("#game-form").addEventListener("input", (e) => { if (["turn", "mvp", "note"].includes(e.target.name)) renderGameForm(); });
$("#game-form").addEventListener("change", (e) => {
  if (e.target.name === "result") {
    if (e.target.value === "win" && !gameMe && gameOpps.length) gameMe = 1;
    if (e.target.value === "loss" && gameMe === 1) gameMe = null;
  }
  renderGameForm();
});

$("#game-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentDeck) return;
  const f = new FormData(e.target);
  const body = {
    result: f.get("result"), turn: f.get("turn") ? Number(f.get("turn")) : null, mvp: f.get("mvp") || null,
    opponents: gameOpps.map((o) => o.name), opponent_ids: gameOpps.map((o) => o.id), opponent_notes: gameOpps.map((o) => o.note.trim()),
    remember_opponents: !!f.get("remember_opponents"), issues: f.getAll("issues"), note: f.get("note") || "", how: f.get("how") || null,
    place: gameOpps.length ? gameMe : null, opponent_places: gameOpps.map((o) => o.place),
  };
  if (body.result === "win") body.issues = [];
  const slug = currentDeck.slug;
  try {
    const data = await api(`/api/decks/${enc(slug)}/games`, { method: "POST", body });
    resetGameForm();
    if (currentDeck?.slug === slug) renderGames(slug, data);
    if (body.opponents.length) void refreshOpponents().then(renderKnownOpps);
    toast(body.result === "win" ? "Sieg gespeichert – Glückwunsch!" : "Partie gespeichert.");
  } catch (err) { fail(err); }
});
$("#game-list").addEventListener("click", async (e) => {
  const b = e.target.closest(".game-del");
  if (!b || !currentDeck) return;
  if (!(await ask({ title: "Partie löschen?", ok: "Löschen", danger: true }))) return;
  const slug = currentDeck.slug;
  try { renderGames(slug, await api(`/api/decks/${enc(slug)}/games/${enc(b.closest("li").dataset.id)}`, { method: "DELETE" })); }
  catch (err) { fail(err); }
});
