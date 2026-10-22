// Runs in the Cardmarket window (see cardmarket.rs). Conclave sends no requests to Cardmarket: this bar walks the
// Verkaufsliste card by card, opens each card's page when the user clicks and fills Cardmarket's own sell form with
// the values from Conclave. It never submits anything – the user checks the form and clicks Cardmarket's button.
(() => {
  if (window.top !== window || window.__conclaveSell) return;
  const HOST = "https://conclave-sell.invalid/";
  const SENT = "conclave-sell-sent";  // sessionStorage: {id, at} after the user clicked Cardmarket's sell button
  const SENT_FOR = 3 * 60 * 1000;
  const CONDITIONS = { MT: [1, "mint"], NM: [2, "near mint"], EX: [3, "excellent"], GD: [4, "good"], LP: [5, "light played"], PL: [6, "played"], PO: [7, "poor"] };
  const LANGUAGES = {
    1: ["english", "englisch", "anglais", "inglés", "inglese"], 2: ["french", "französisch", "français", "francés", "francese"],
    3: ["german", "deutsch", "allemand", "alemán", "tedesco"], 4: ["spanish", "spanisch", "espagnol", "español", "spagnolo"],
    5: ["italian", "italienisch", "italien", "italiano"], 6: ["s-chinese", "simplified chinese", "chinesisch (vereinfacht)", "chinese"],
    7: ["japanese", "japanisch", "japonais", "japonés", "giapponese"], 8: ["portuguese", "portugiesisch", "portugais", "portugués", "portoghese"],
    9: ["russian", "russisch", "russe", "ruso", "russo"], 10: ["korean", "koreanisch", "coréen", "coreano"],
    11: ["t-chinese", "traditional chinese", "chinesisch (traditionell)"],
  };
  let state = null, form = null, filledFor = null, note = "", watch = null, reveal = false;

  const send = (a, extra = {}) => { location.href = HOST + "?" + new URLSearchParams({ a, ...extra }); };
  Object.defineProperty(window, "__conclaveSell", { value: (s) => { state = s; update(); }, writable: false, configurable: false });

  const card = () => state && state.cards[state.current];
  const isDone = (c) => !!c && state.done.includes(c.id);
  const nextOpen = () => {
    for (let k = 1; k <= state.cards.length; k++) {
      const i = (state.current + k) % state.cards.length;
      if (!state.done.includes(state.cards[i].id)) return i;
    }
    return -1;
  };
  const eur = (v) => v == null ? "–" : Number(v).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const label = (el) => {
    const l = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest("label");
    return `${el.name || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""} ${el.placeholder || ""} ${l ? l.textContent : ""}`.toLowerCase();
  };

  // ---- finding Cardmarket's sell form (by what its fields are, not by fixed positions) ----
  const options = (sel) => [...sel.options].map((o) => `${o.value} ${o.textContent}`.toLowerCase());
  const isCondition = (sel) => sel.tagName === "SELECT" && (/condition|zustand/.test(label(sel)) || options(sel).some((o) => /near mint|\bnm\b/.test(o)));
  const isLanguage = (sel) => sel.tagName === "SELECT" && (/language|sprache/.test(label(sel)) || options(sel).some((o) => /english|englisch/.test(o)));
  function fields(f) {
    const all = [...f.querySelectorAll("input, select, textarea")];
    const pick = (test) => all.find((el) => test(el)) || null;
    return {
      price: pick((el) => el.tagName === "INPUT" && /price|preis/.test(label(el)) && !/min|max|from|to\b|bis|von/.test(label(el)) && !["hidden", "checkbox", "radio"].includes(el.type)),
      amount: pick((el) => /amount|quantity|anzahl|menge|count/.test(label(el)) && el.type !== "hidden"),
      condition: pick(isCondition),
      language: pick(isLanguage),
      foil: pick((el) => el.type === "checkbox" && /foil/.test(label(el))),
      comment: pick((el) => (el.tagName === "TEXTAREA" || el.type === "text") && /comment|kommentar/.test(label(el))),
    };
  }
  function findForm() {
    let best = null, bestScore = 0;
    for (const f of document.forms) {
      if (f.querySelector('input[type="password"]') || f.closest("#conclave-sell-bar")) continue;
      const x = fields(f);
      const score = (x.price ? 3 : 0) + (x.condition ? 3 : 0) + (x.amount ? 1 : 0) + (x.language ? 1 : 0) + (x.comment ? 1 : 0)
        + ((f.method || "").toLowerCase() === "post" ? 2 : 0);
      if (score > bestScore) { best = f; bestScore = score; }
    }
    return bestScore >= 6 ? best : null;
  }

  // ---- filling it: native setters + input/change events, so the page's own scripts see the values ----
  function setValue(el, v) {
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function choose(sel, test) {
    const o = [...sel.options].find((opt) => test(opt));
    if (!o) return false;
    setValue(sel, o.value);
    return true;
  }
  function fill(f, c) {
    const x = fields(f), done = [], missing = [];
    const mark = (el) => { el.style.outline = "3px solid #4ae05a"; el.style.outlineOffset = "1px"; };
    const step = (name, el, run) => { if (el && run(el) !== false) { mark(el); done.push(name); } else missing.push(name); };
    step("Anzahl", x.amount, (el) => el.tagName === "SELECT"
      ? choose(el, (o) => Number(o.value) === c.qty) || choose(el, (o) => o.textContent.trim() === String(c.qty))
      : setValue(el, c.qty));
    const [condId, condName] = CONDITIONS[c.condition] || CONDITIONS.NM;
    step("Zustand", x.condition, (el) => choose(el, (o) => o.value.toUpperCase() === c.condition || Number(o.value) === condId)
      || choose(el, (o) => new RegExp(`\\b${c.condition}\\b`, "i").test(o.textContent) || o.textContent.toLowerCase().includes(condName)));
    const names = LANGUAGES[c.lang_id] || [];
    step("Sprache", x.language, (el) => choose(el, (o) => Number(o.value) === c.lang_id) || choose(el, (o) => names.some((n) => o.textContent.trim().toLowerCase() === n)));
    if (x.foil) step("Foil", x.foil, (el) => { el.checked = !!c.foil; el.dispatchEvent(new Event("change", { bubbles: true })); });
    else if (c.foil) missing.push("Foil");
    const comma = !/^\/en\//.test(location.pathname);  // the German, French … pages write 0,90
    step("Preis", x.price, (el) => { if (c.price == null) return false; setValue(el, comma ? Number(c.price).toFixed(2).replace(".", ",") : Number(c.price).toFixed(2)); });
    if (c.comment) step("Kommentar", x.comment, (el) => setValue(el, c.comment));
    return { done, missing };
  }

  // ---- after the user's click on Cardmarket's button: did it work? ----
  const failed = () => [...document.querySelectorAll(".alert-danger, .alert-error, .error-message")].some(visible);
  const succeeded = () => [...document.querySelectorAll(".alert-success")].some(visible);
  function watchSubmit(f, c) {
    const remember = () => {
      try { sessionStorage.setItem(SENT, JSON.stringify({ id: c.id, at: Date.now() })); } catch { /* storage off */ }
      let n = 0;  // pages that answer without reloading show a message in place
      const t = setInterval(() => {
        if (++n > 40) return clearInterval(t);
        if (succeeded() && !isDone(c)) { clearInterval(t); sessionStorage.removeItem(SENT); send("done", { id: c.id }); }
      }, 500);
    };
    f.addEventListener("submit", remember, true);
    for (const b of f.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])')) b.addEventListener("click", remember, true);
  }
  // a page loaded after that click: an error message stays on the bar, otherwise the card counts as listed
  function checkSent() {
    let sent = null;
    try { sent = JSON.parse(sessionStorage.getItem(SENT) || "null"); } catch { /* storage off */ }
    if (!sent || Date.now() - sent.at > SENT_FOR) return null;
    sessionStorage.removeItem(SENT);
    const c = state.cards.find((x) => x.id === sent.id);
    if (!c || isDone(c)) return null;
    if (failed()) return { warn: "Cardmarket hat einen Fehler gemeldet – sieh dir die Meldung an, korrigiere die Werte und klicke noch einmal." };
    send("done", { id: c.id });
    return { sent: true };
  }

  // ---- the bar ----
  let bar;
  const el = (tag, text, style) => { const e = document.createElement(tag); if (text) e.textContent = text; if (style) Object.assign(e.style, style); return e; };
  const BTN = { background: "#2a2a2a", color: "#eee", border: "1px solid #555", borderRadius: "6px", padding: "7px 12px", font: "600 13px system-ui, sans-serif", cursor: "pointer" };
  const PRIMARY = { ...BTN, background: "#4ae05a", color: "#000", border: "0" };
  const button = (text, run, style = BTN, title = "") => { const b = el("button", text, style); b.type = "button"; if (title) b.title = title; b.addEventListener("click", run); return b; };
  function copy(text) {
    const t = el("textarea");
    t.value = text;
    document.body.append(t);
    t.select();
    try { document.execCommand("copy"); } catch { /* nothing to do */ }
    t.remove();
  }
  function formInfo() {  // for a bug report when the form changed: the fields' names and labels, never their values
    return JSON.stringify([...document.forms].map((f) => ({
      action: (f.getAttribute("action") || "").split("?")[0], method: f.method,
      fields: [...f.querySelectorAll("input, select, textarea")].filter((x) => x.type !== "hidden" || /product|article/i.test(x.name))
        .map((x) => ({ tag: x.tagName.toLowerCase(), type: x.type, name: x.name, id: x.id, label: label(x).trim().slice(0, 80),
          options: x.tagName === "SELECT" ? [...x.options].slice(0, 12).map((o) => `${o.value}=${o.textContent.trim()}`) : undefined })),
    })), null, 1);
  }

  function update() {
    if (!document.body) return void document.addEventListener("DOMContentLoaded", update, { once: true });
    if (!state || !state.cards?.length) { bar?.remove(); bar = null; return; }
    const after = checkSent();
    const c = card();
    if (after?.sent) { note = "Eingestellt – einen Moment …"; return render(c, false); }
    const onProduct = /\/Products\/Singles\//.test(location.pathname) || /idProduct=/.test(location.search);
    const pageId = Number(document.querySelector('input[name="idProduct"]')?.value) || null;
    const wrong = onProduct && c.product_id && pageId && pageId !== c.product_id;
    if (!isDone(c) && onProduct && !wrong && filledFor !== c.id) {
      form = findForm();
      if (form) {
        const r = fill(form, c);
        filledFor = c.id;
        watchSubmit(form, c);
        note = `Ausgefüllt: ${r.done.join(", ") || "nichts"}.${r.missing.length ? ` Bitte selbst eintragen: ${r.missing.join(", ")}.` : ""}`
          + ` Prüfe alles und klicke dann auf Cardmarkets Knopf zum Einstellen.${c.product_id ? "" : " Achte darauf, dass es der richtige Druck ist."}`;
        reveal = true;
      } else {
        note = "Kein Verkaufen-Formular auf dieser Seite. Bist du angemeldet? Öffnet Cardmarket das Formular erst nach einem Klick, fülle ich es danach aus.";
        clearInterval(watch);
        let n = 0;
        watch = setInterval(() => { if (findForm() || ++n > 600) { clearInterval(watch); if (n <= 600) update(); } }, 500);
      }
    } else if (wrong) note = "Diese Seite zeigt einen anderen Druck als in Conclave – „Zur Karte“ öffnet den richtigen.";
    else if (!onProduct && !isDone(c)) note = "Melde dich bei Cardmarket an, falls nötig, und klicke dann auf „Zur Karte“.";
    else if (isDone(c)) note = "✓ Eingestellt.";
    if (after?.warn) note = `${after.warn} ${note}`;
    render(c, onProduct && !wrong);
  }

  function render(c, here) {
    bar?.remove();
    bar = el("div", "", {
      position: "fixed", left: "50%", bottom: "14px", transform: "translateX(-50%)", zIndex: 2147483647, width: "min(860px, calc(100vw - 24px))",
      display: "flex", flexDirection: "column", gap: "8px", padding: "12px 14px", borderRadius: "10px", boxSizing: "border-box",
      background: "#111", color: "#eee", font: "14px system-ui, sans-serif", boxShadow: "0 6px 24px rgba(0,0,0,.4)",
    });
    bar.id = "conclave-sell-bar";
    const done = state.done.length, n = state.cards.length;
    const head = el("div", "", { display: "flex", gap: "10px", alignItems: "baseline", flexWrap: "wrap" });
    head.append(el("span", `Conclave · Karte ${state.current + 1} von ${n}${done ? ` · ${done} eingestellt` : ""}`, { color: "#4ae05a", fontWeight: "700" }));
    const facts = [c.set_name ? `${c.set_name}${c.collector_number ? ` #${c.collector_number}` : ""}` : "", c.condition, c.lang_name, c.foil ? "Foil" : "", `${c.qty}×`, eur(c.price)].filter(Boolean);
    head.append(el("b", c.name, { fontSize: "15px" }), el("span", facts.join(" · "), { color: "#bbb" }));
    const msg = el("div", note, { color: isDone(c) ? "#4ae05a" : "#ddd" });
    const row = el("div", "", { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" });
    const next = nextOpen();
    if (isDone(c)) {
      if (next >= 0) row.append(button("Nächste Karte", () => send("goto", { i: next }), PRIMARY));
      row.append(button("Doch nicht eingestellt", () => send("undone", { id: c.id })));
    } else {
      if (!here) row.append(button("Zur Karte", () => send("goto", { i: state.current }), PRIMARY));
      else row.append(button("Ist eingestellt", () => send("done", { id: c.id }), BTN, "Wenn Conclave es nicht selbst bemerkt hat"));
      if (here) row.append(button("Neu ausfüllen", () => { filledFor = null; update(); }));
      if (next >= 0 && next !== state.current) row.append(button("Überspringen", () => send("goto", { i: next })));
      if (c.price != null) row.append(button(`Preis kopieren (${eur(c.price)})`, () => copy(Number(c.price).toFixed(2))));
      if (c.comment) row.append(button("Kommentar kopieren", () => copy(c.comment)));
    }
    const right = el("span", "", { marginLeft: "auto", display: "flex", gap: "8px" });
    right.append(button("Formular-Info kopieren", () => { copy(formInfo()); msg.textContent = "Formular-Info kopiert – schick sie, wenn das Ausfüllen nicht klappt."; },
      { ...BTN, background: "none", border: "0", color: "#999", fontWeight: "400" }, "Nur die Namen der Felder, keine Werte"));
    right.append(button(done === n ? "Fertig" : "Schließen", () => send("close")));
    row.append(right);
    bar.append(head, msg, row);
    document.documentElement.append(bar);
    // the bar must never hide Cardmarket's button: room below the page, and the filled form scrolled above the bar
    const room = bar.offsetHeight + 28;
    document.body.style.paddingBottom = `${room}px`;
    if (reveal && form) {
      reveal = false;
      const r = form.getBoundingClientRect();
      const space = innerHeight - room;
      window.scrollBy(0, r.height + 32 > space ? r.top - 16 : r.bottom - space + 16);  // a tall form: its top
    }
  }

  // the shell sends the list after every page load; ask for it if that was missed
  setTimeout(() => { if (!state) send("state"); }, 3000);
})();
