"use strict";
// The desktop GUI, part 4 of 21: the job panel: one print, MPC Autofill or card DB run at a time, streamed via SSE.
// index.html loads the parts in order; they share one global scope.

let currentJob = null;   // id of the running job
let jobInfo = null;      // { id, kind, slot, route, slug, title, started, error, dismissed }
let eventSource = null;
let elapsedTimer = null;

function startJob(jobId, title, { kind, slot, route: home, slug = null }) {
  currentJob = jobId;
  jobInfo = { id: jobId, kind, slot, route: home, slug, title, started: Date.now(), error: null, dismissed: false };
  const panel = $("#job");
  panel.classList.remove("finished", "failed");
  $("#job-title").textContent = title;
  setJobStatus("Starte …");
  $("#log").innerHTML = "";
  $("#progress").hidden = true;
  $("#console-form").hidden = true;
  $("#job-details").open = false;
  $("#cancel-btn").textContent = "Abbrechen";
  resetTerminal();
  placeJobPanel();
  setBusy(true);
  tickElapsed();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(tickElapsed, 1000);
  if (eventSource) eventSource.close();
  eventSource = jobStream(jobId, handleEvent, (lost) => {
    if (currentJob !== jobId) return;
    if (lost) { handleEvent({ type: "error", text: lost }); handleEvent({ type: "done", ok: false }); }
    else if (lost === null) setJobStatus("Verbindung unterbrochen – verbinde neu …");
  });
}

// the job panel lives in the slot of the view that started it (deck print tab, order page, settings)
function placeJobPanel() {
  const panel = $("#job");
  const visible = jobInfo && !jobInfo.dismissed && (!jobInfo.slug || (currentDeck && currentDeck.slug === jobInfo.slug)
    || (parseHash().view === "orders" && currentOrder?.slug === jobInfo.slug));
  if (visible) { $(jobInfo.slot).appendChild(panel); panel.hidden = false; }
  else { document.body.appendChild(panel); panel.hidden = true; }
  for (const ind of [$("#job-indicator"), $("#job-indicator-top")]) {
    ind.hidden = !currentJob;
    if (currentJob) { ind.href = jobInfo.route; ind.title = jobInfo.title; }
  }
  if (currentJob) $("#job-indicator-text").textContent = jobInfo.title;
}

function setJobStatus(text) { $("#job-status").textContent = text; }

function tickElapsed() {
  if (!jobInfo) return;
  const s = Math.round((Date.now() - jobInfo.started) / 1000);
  $("#job-elapsed").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function setBusy(busy) {
  for (const sel of ["#prepare-btn", "#mpc-btn"]) {
    const b = $(sel);
    b.disabled = busy;
    b.title = busy ? "Es läuft gerade ein Auftrag" : "";
  }
}

function logLine(cls, text) {
  const log = $("#log");
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function handleEvent(ev) {
  switch (ev.type) {
    case "text": logLine("text", ev.text); setJobStatus(ev.text); break;
    case "status": logLine("tool", ev.text); setJobStatus(ev.text); break;
    case "error": logLine("error", "Fehler: " + ev.text); if (jobInfo) jobInfo.error = ev.text; break;
    case "result": logLine("result", ev.text); break;
    case "progress": {
      const bar = $("#progress");
      bar.hidden = false;
      bar.querySelector("div").style.width = `${(ev.done / Math.max(ev.total, 1)) * 100}%`;
      bar.querySelector("span").textContent = `${ev.done} / ${ev.total} · ${ev.text || ""}`;
      setJobStatus(`Bild ${ev.done} von ${ev.total}`);
      break;
    }
    case "print": void onPrepared(ev.result); break;
    case "console":
      if (ev.running) { openTerminal(); setJobStatus("MPC Autofill läuft – bediene es im Terminal."); }
      else if (term) term.options.disableStdin = true;
      break;
    case "term":
      if (term) term.write(ev.data);
      else logLine("text", ev.data.replace(ANSI_RE, "").trimEnd());
      break;
    case "done": void finishJob(ev); break;
  }
}

async function finishJob(ev) {
  eventSource.close();
  clearInterval(elapsedTimer);
  const info = jobInfo;
  currentJob = null;
  setBusy(false);
  $("#job").classList.add(ev.ok ? "finished" : "failed");
  $("#cancel-btn").textContent = "Schließen";
  if (!ev.ok) {
    setJobStatus(info.error || "Beendet, ohne Ergebnis. Details unten.");
    placeJobPanel();
    return;
  }
  switch (info.kind) {
    case "print":
      info.dismissed = true;
      toast("Druckdateien sind fertig.");
      break;
    default:  // autofill: keep the terminal output visible until closed
      setJobStatus("MPC Autofill ist beendet.");
  }
  placeJobPanel();
}

$("#cancel-btn").addEventListener("click", async () => {
  if (currentJob) {
    await api(`/api/jobs/${currentJob}/cancel`, { method: "POST" }).catch(() => {});
    return;
  }
  if (jobInfo) jobInfo.dismissed = true;
  placeJobPanel();
});
