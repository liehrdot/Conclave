// Runs in the Moxfield window (see moxfield.rs). Conclave sends no requests to Moxfield: this script keeps the
// deck JSON the page itself loads and offers „In Conclave importieren“ on deck pages.
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

  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = realFetch.apply(this, arguments);
    const url = typeof input === "string" ? input : input?.url;
    if (url && url.includes("/decks/all/")) p.then((r) => r.clone().text().then((t) => keep(url, t))).catch(() => {});
    return p;
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (String(url).includes("/decks/all/")) {
      this.addEventListener("load", () => {
        try { keep(String(url), typeof this.response === "string" ? this.response : JSON.stringify(this.response)); } catch {}
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

  setInterval(() => {
    if (!document.body) return;
    if (!bar) build();
    const onDeck = location.pathname.startsWith("/decks/") && (deckId(location.pathname) || "").length >= 10;  // not /decks/public …
    bar.style.display = onDeck ? "flex" : "none";
    if (!onDeck) note.textContent = "Conclave";
  }, 500);
})();
