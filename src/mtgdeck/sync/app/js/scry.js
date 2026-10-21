// Card data straight from Scryfall (CORS is allowed): names → images and texts, batched via /cards/collection
// (75 per request), cached in local storage; commander and card search incl. German names; German printed text.
// Scryfall asks for 50–100 ms between API requests – one queue keeps that. Images (cards.scryfall.io) are a CDN.

import { load, save } from "./util.js";

const API = "https://api.scryfall.com";
const KEY = "amtisch.cards.v2";  // v1 could hold a foreign printing's image (scanned cards), dropped below
const KEY_DE = "amtisch.cards.de.v1";
const cache = load(KEY, {});
try { localStorage.removeItem("amtisch.cards.v1"); } catch { /* private mode */ }
const cacheDe = load(KEY_DE, {});
let saveTimer = null;
const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { save(KEY, cache); save(KEY_DE, cacheDe); }, 400); };

let chain = Promise.resolve();
function api(path, init) {  // one request at a time, ~100 ms apart
  const run = chain.then(() => fetch(API + path, { ...init, headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) } }));
  chain = run.then(() => new Promise((r) => setTimeout(r, 100)), () => new Promise((r) => setTimeout(r, 100)));
  return run.then((res) => (res.ok ? res.json() : res.status === 404 ? null : Promise.reject(new Error(`Scryfall ${res.status}`))));
}

function pick(card) {
  const faces = card.card_faces || [];
  const uris = card.image_uris || faces[0]?.image_uris || {};
  const text = card.oracle_text ?? faces.map((f) => f.oracle_text).filter(Boolean).join("\n—\n");
  return {
    name: card.name, type: card.type_line || faces.map((f) => f.type_line).join(" // "),
    cost: card.mana_cost ?? faces.map((f) => f.mana_cost).filter(Boolean).join(" // "),
    text, colors: (card.color_identity || []).join(""), art: uris.art_crop, image: uris.normal, small: uris.small,
    back: faces[1]?.image_uris?.normal || null, pt: card.power != null ? `${card.power}/${card.toughness}` : null,
    uri: card.scryfall_uri, lang: card.lang || "en",
  };
}
// the name cache shows a card in English: a scanned Japanese printing only fills it until the English one is fetched
const foreign = (i) => i && i.lang && i.lang !== "en";
const remember = (card, asked) => {
  const info = pick(card);
  if (foreign(info) && cache[info.name] && !foreign(cache[info.name])) return info;
  cache[info.name] = info;
  if (asked && asked !== info.name) cache[asked] = info;
  const front = info.name.split(" // ")[0];
  if (front !== info.name) cache[front] = info;
  persist();
  return info;
};

export const cached = (name) => (cache[name] && !foreign(cache[name]) ? cache[name] : null);

// ---- batched lookups by name ----
const waiting = new Map();  // name -> [resolve]
let batchTimer = null;
export function info(name) {
  if (!name) return Promise.resolve(null);
  if (cached(name)) return Promise.resolve(cache[name]);
  return new Promise((resolve) => {
    if (!waiting.has(name)) waiting.set(name, []);
    waiting.get(name).push(resolve);
    clearTimeout(batchTimer);
    batchTimer = setTimeout(flush, 30);
  });
}
async function flush() {
  const names = [...waiting.keys()];
  while (names.length) {
    const part = names.splice(0, 75);
    let data = null;
    try { data = await api("/cards/collection", { method: "POST", body: JSON.stringify({ identifiers: part.map((n) => ({ name: n.split(" // ")[0] })) }) }); } catch { /* offline */ }
    const byName = {};
    for (const card of data?.data || []) {  // asked by the front face: Scryfall does not find "Front // Back" by its whole name
      const info = pick(card);
      byName[info.name.toLowerCase()] = card;
      byName[info.name.split(" // ")[0].toLowerCase()] = card;
    }
    for (const n of part) {
      const card = byName[n.toLowerCase()] || byName[n.split(" // ")[0].toLowerCase()];
      const result = card ? remember(card, n) : null;
      for (const r of waiting.get(n) || []) r(result);
      waiting.delete(n);
    }
  }
}

// fill <img data-card="Name" data-kind="art|small|image"> once the data is there
export function hydrate(root) {
  for (const img of root.querySelectorAll("img[data-card]:not([src])")) {
    const kind = img.dataset.kind || "art";
    const set = (i) => {
      if (!i?.[kind]) return;
      img.crossOrigin = "anonymous";  // a CORS response the service worker can cache (no opaque padding)
      img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
      img.addEventListener("error", () => { if (img.crossOrigin) { img.removeAttribute("crossorigin"); img.src = i[kind]; } }, { once: true });
      img.src = i[kind];
    };
    const c = cached(img.dataset.card);
    if (c) set(c); else info(img.dataset.card).then(set);
  }
}

// ---- search ----
const ok = (d) => (d?.data || []);
export async function searchCommanders(q, { partner = false } = {}) {  // partner: also Backgrounds and the like
  const kind = partner ? "(is:commander OR t:background)" : "is:commander";
  const data = await api(`/cards/search?q=${encodeURIComponent(`${q} ${kind}`)}&include_multilingual=true&unique=cards&order=edhrec`);
  return ok(data).slice(0, 8).map((c) => remember(c));
}
export async function searchCards(q) {
  const [auto, multi] = await Promise.all([
    api(`/cards/autocomplete?q=${encodeURIComponent(q)}`).catch(() => null),
    api(`/cards/search?q=${encodeURIComponent(q)}&include_multilingual=true&unique=cards&order=edhrec`).catch(() => null),
  ]);
  const out = new Map();
  for (const c of ok(multi).slice(0, 10)) { const i = remember(c); out.set(i.name, { name: i.name, de: c.printed_name && c.lang === "de" ? c.printed_name : null, type: i.type }); }
  for (const n of auto?.data || []) if (!out.has(n)) out.set(n, { name: n, type: cached(n)?.type || "" });
  return exactFirst([...out.values()], q).slice(0, 15);
}

/** The card named exactly ``q`` before cards that only carry it on a face (Rampant Growth before
 * Studious First-Year // Rampant Growth, the creature with it as its prepared spell); otherwise the order stays. */
export function exactFirst(list, q) {
  const k = q.trim().toLowerCase();
  const rank = (c) => (c.name.toLowerCase() === k || c.de?.toLowerCase() === k ? 0 : c.name.toLowerCase().startsWith(`${k} // `) ? 1 : 2);
  return list.map((c, i) => [rank(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}

// any Scryfall query (the AI card search): one page of up to 175 cards, most played in Commander first
export async function searchQuery(q, page = 1, { multilingual = false } = {}) {  // multilingual: German names match too
  let data;
  try {
    data = await api(`/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=edhrec&page=${page}${multilingual ? "&include_multilingual=true" : ""}`);
  } catch (e) {
    throw new Error(/ 400$/.test(e.message) ? "Scryfall versteht diese Suche nicht – bitte anpassen." : "Scryfall ist gerade nicht erreichbar.");
  }
  const cards = ok(data).map((c) => { const i = remember(c); return { name: i.name, type: i.type, cost: i.cost }; });
  return { cards, total: data?.total_cards || 0, next: data?.has_more ? page + 1 : null };
}

// !"Rampant Growth" also finds Studious First-Year // Rampant Growth (its prepared spell): keep only the card itself
const sameCard = (c, name) => { const n = c.name.toLowerCase(), q = name.toLowerCase(); return n === q || n.startsWith(`${q} // `); };

// German printed name/type/text of a card (null when there is no German printing)
export async function german(name) {
  if (name in cacheDe) return cacheDe[name];
  let de = null;
  try {
    const d = await api(`/cards/search?q=${encodeURIComponent(`!"${name}" lang:de`)}&unique=prints&order=released&dir=desc&include_multilingual=true`);
    const c = ok(d).find((x) => sameCard(x, name));
    if (c) {
      const f = c.card_faces || [];
      de = { name: c.printed_name || f.map((x) => x.printed_name).filter(Boolean).join(" // "),
             type: c.printed_type_line || f.map((x) => x.printed_type_line).filter(Boolean).join(" // "),
             text: c.printed_text ?? f.map((x) => x.printed_text).filter(Boolean).join("\n—\n") };
    }
  } catch { return null; }  // offline: ask again next time
  cacheDe[name] = de;
  persist();
  return de;
}

// ---- printings (the collection keeps one entry per printing) ----
// the whole Scryfall card (one printing); also fills the name cache, so images and texts show without another request
const printingOf = (card) => { if (card?.object === "card") { remember(card); return card; } return null; };
const quiet = (p) => p.then(printingOf, () => null);

/** One printing by set code and collector number, in ``lang`` when given (null when Scryfall has none). */
export const printing = (set, number, lang = "") =>
  quiet(api(`/cards/${encodeURIComponent(set.toLowerCase())}/${encodeURIComponent(number)}${lang && lang !== "en" ? `/${encodeURIComponent(lang)}` : ""}`));

/** Fuzzy name lookup (typos and missing letters are fine; English names), optionally in one set. */
export const named = (q, set = "") =>
  quiet(api(`/cards/named?fuzzy=${encodeURIComponent(q)}${set ? `&set=${encodeURIComponent(set.toLowerCase())}` : ""}`));

/** Printings whose printed (e.g. German) name or text matches ``q``, newest first (the caller picks the best name). */
export async function byPrintedName(q) {
  try {
    const d = await api(`/cards/search?q=${encodeURIComponent(q)}&include_multilingual=true&unique=prints&order=released&dir=desc`);
    return ok(d).slice(0, 60).map(printingOf).filter(Boolean);
  } catch { return []; }
}

/** All printings of a card (newest first), for picking the right one; ``lang`` "any" also lists other languages. */
export async function prints(oracleId, { lang = "" } = {}) {
  const q = `oracleid:${oracleId}${lang && lang !== "any" ? ` lang:${lang}` : ""} game:paper`;
  const out = [];
  let page = 1;
  while (page && page <= 3) {
    let d;
    try { d = await api(`/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released&dir=desc&page=${page}${lang ? "&include_multilingual=true" : ""}`); }
    catch { break; }
    out.push(...ok(d));
    page = d?.has_more ? page + 1 : 0;
  }
  return out;
}

/** The facts a collection entry keeps about a printing (like ``scryfall.printing`` on the PC). */
export function entryFacts(card, { foil = false } = {}) {
  const faces = card.card_faces || [];
  const uris = card.image_uris || faces[0]?.image_uris || {};
  const p = card.prices || {};
  const price = (cur) => (foil ? p[`${cur}_foil`] || p[cur] : p[cur] || p[`${cur}_foil`]) || null;
  return { name: card.name, scryfall_id: card.id, set: card.set, set_name: card.set_name, collector_number: card.collector_number,
    image: uris.normal || null, image_back: !card.image_uris && faces[1]?.image_uris?.normal || null,
    price_eur: price("eur"), price_usd: price("usd") };
}

/** Artwork of a collection entry: its Scryfall id gives the image (the read model leaves the URL out). */
export function entryImage(e, size = "small") {
  const id = e?.scryfall_id;
  if (id && /^[0-9a-f-]{36}$/.test(id)) return `https://cards.scryfall.io/${size}/front/${id[0]}/${id[1]}/${id}.jpg`;
  return e?.image || null;
}
