// Runs in the Moxfield window (see moxfield.rs). Conclave sends no requests to Moxfield: this script keeps the
// deck JSON the page itself loads and offers „In Conclave importieren“ on deck pages. On the collection page it keeps
// the CSV that the user's own click on Moxfield's „Export“ produces and offers „Sammlung an Conclave geben“.
(() => {
  if (window.top !== window || window.__conclave) return;
  window.__conclave = true;
  const IMPORT = "https://conclave-import.invalid/";
  const decks = {};  // public deck id → the deck JSON the page loaded
  const deckId = (path) => (path.match(/\/decks\/(?:all\/)?([A-Za-z0-9_-]+)/) || [])[1];

  function keep(url, text) {
    try {
      const u = new URL(url, location.href);
      if (!/(^|\.)moxfield\.com$/.test(u.hostname) || !u.pathname.includes("/decks/all/")) return;
      const id = deckId(u.pathname);
      const data = JSON.parse(text);
      if (id && data && typeof data === "object") decks[data.publicId || id] = data;
    } catch { /* not a deck */ }
  }

  // the collection export: a CSV whose header names the card and its count (Moxfield writes "Count","Name",…)
  let collectionCsv = "";
  const MAX_CSV = 20 * 1024 * 1024;
  function keepCsv(text) {
    if (typeof text !== "string" || text.length > MAX_CSV) return;
    const head = text.replace(/^\ufeff/, "").split(/\r?\n/, 1)[0].toLowerCase();
    if (/(^|[,;\t"])\s*name\s*("|[,;\t]|$)/.test(head) && /count|quantity/.test(head)) collectionCsv = text;
  }
  const isCsvUrl = (url) => /export|csv/i.test(url) && /collection/i.test(url);

  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = realFetch.apply(this, arguments);
    const url = typeof input === "string" ? input : input?.url;
    if (url && url.includes("/decks/all/")) p.then((r) => r.clone().text().then((t) => keep(url, t))).catch(() => {});
    else if (url) {
      p.then((r) => {
        if (isCsvUrl(String(url)) || /csv/i.test(r.headers.get("content-type") || "")) r.clone().text().then(keepCsv);
      }).catch(() => {});
    }
    return p;
  };
  const realObjectUrl = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    try {
      if (obj instanceof Blob && obj.size < MAX_CSV && /csv|text|octet-stream|^$/i.test(obj.type)) obj.text().then(keepCsv).catch(() => {});
    } catch { /* not ours */ }
    return realObjectUrl.apply(this, arguments);
  };
  document.addEventListener("click", (e) => {  // a data: link with the CSV in it
    const a = e.target instanceof Element && e.target.closest("a[href^='data:']");
    if (!a) return;
    try {
      const href = a.getAttribute("href"), comma = href.indexOf(",");
      const body = href.slice(comma + 1);
      keepCsv(/;base64/i.test(href.slice(0, comma)) ? new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))) : decodeURIComponent(body));
    } catch { /* not a CSV */ }
  }, true);
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (String(url).includes("/decks/all/")) {
      this.addEventListener("load", () => {
        try { keep(String(url), typeof this.response === "string" ? this.response : JSON.stringify(this.response)); } catch {}
      });
    } else if (isCsvUrl(String(url))) {
      this.addEventListener("load", () => {
        try {
          if (typeof this.response === "string") keepCsv(this.response);
          else if (this.response instanceof Blob) this.response.text().then(keepCsv);
        } catch {}
      });
    }
    return open.apply(this, arguments);
  };

  function board(b) {
    const cards = b && typeof b === "object" ? (b.cards && typeof b.cards === "object" ? b.cards : b) : {};
    const out = [];
    for (const v of Object.values(cards)) {
      const name = v && v.card && v.card.name;
      if (typeof name === "string" && name) out.push([name, Number(v.quantity) || 1]);
    }
    return out;
  }

  function payload(id) {
    const d = decks[id];
    if (!d) return null;
    const boards = d.boards || d;  // v3: boards.<board>.cards, v2: <board> at the top level
    return {
      name: typeof d.name === "string" ? d.name : "",
      url: `https://moxfield.com/decks/${id}`,
      commanders: board(boards.commanders).map(([n]) => n),
      cards: board(boards.mainboard),
    };
  }

  let bar, btn, note;
  function build() {
    bar = document.createElement("div");
    btn = document.createElement("button");
    note = document.createElement("span");
    btn.textContent = "In Conclave importieren";
    Object.assign(bar.style, {
      position: "fixed", left: "50%", bottom: "16px", transform: "translateX(-50%)", zIndex: 2147483647,
      display: "none", alignItems: "center", gap: "12px", padding: "8px 10px 8px 16px", borderRadius: "8px",
      background: "#111", color: "#eee", font: "14px system-ui, sans-serif", boxShadow: "0 4px 18px rgba(0,0,0,.35)",
    });
    Object.assign(btn.style, {
      background: "#4ae05a", color: "#000", border: "0", borderRadius: "6px", padding: "8px 14px",
      font: "600 14px system-ui, sans-serif", cursor: "pointer",
    });
    note.textContent = "Conclave";
    bar.append(note, btn);
    btn.addEventListener("click", () => {
      if (onCollection()) { sendCollection(); return; }
      const id = deckId(location.pathname);
      const p = id && payload(id);
      if (!p || !p.cards.length) {
        note.textContent = "Deck noch nicht geladen – lade die Seite neu (F5).";
        return;
      }
      location.href = IMPORT + "?d=" + encodeURIComponent(JSON.stringify(p));
    });
    document.documentElement.append(bar);
  }

  // a big CSV goes in parts: one cancelled navigation carries at most CHUNK characters (URLs stop near 2 MB)
  const CHUNK = 400 * 1024;
  function sendCollection() {
    if (!collectionCsv) {
      note.textContent = "Klicke zuerst bei Moxfield auf „Export“ (CSV).";
      return;
    }
    const id = Math.random().toString(36).slice(2, 10);
    const parts = Math.ceil(collectionCsv.length / CHUNK);
    btn.disabled = true;
    note.textContent = "Wird übergeben …";
    for (let i = 0; i < parts; i++) {
      const msg = { kind: "collection", id, part: i, parts, csv: collectionCsv.slice(i * CHUNK, (i + 1) * CHUNK) };
      setTimeout(() => { location.href = IMPORT + "?d=" + encodeURIComponent(JSON.stringify(msg)); }, i * 400);
    }
    setTimeout(() => { btn.disabled = false; }, parts * 400 + 1000);
  }
  const onCollection = () => /^\/collection(\/|$)/.test(location.pathname);

  setInterval(() => {
    if (!document.body) return;
    if (!bar) build();
    const onDeck = location.pathname.startsWith("/decks/") && (deckId(location.pathname) || "").length >= 10;  // not /decks/public …
    const coll = onCollection() || !!collectionCsv;
    bar.style.display = onDeck || coll ? "flex" : "none";
    if (coll && !onDeck) {
      const rows = collectionCsv ? collectionCsv.split(/\r?\n/).filter((l) => l.trim()).length - 1 : 0;
      btn.textContent = rows ? `Sammlung an Conclave geben (${rows} Zeilen)` : "Sammlung an Conclave geben";
      if (!btn.disabled) note.textContent = rows ? "Export gefunden" : "Klicke bei Moxfield auf „Export“ (CSV)";
    } else {
      btn.textContent = "In Conclave importieren";
      if (!onDeck) note.textContent = "Conclave";
    }
  }, 500);
})();
