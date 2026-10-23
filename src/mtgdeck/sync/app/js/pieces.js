// Small view pieces shared by the screens and the sheets (kept here so no module has to import screens.js).

import { setPref, state } from "./data.js";
import { artFallback, esc } from "./util.js";

export const art = (name, kind = "art", cls = "") => `<img data-card="${esc(name)}" data-kind="${kind}" alt="" class="${cls}" loading="lazy">`;

export const CATS = ["Ramp", "Draw", "Removal", "Board Wipe", "Counterspell", "Tutor", "Protection", "Synergy", "Win Condition", "Utility", "Land"];
export const CAT_LABELS = { Ramp: "Ramp", Draw: "Kartenzug", Removal: "Removal", "Board Wipe": "Board Wipes", Counterspell: "Counterspells",
  Tutor: "Tutoren", Protection: "Schutz", Synergy: "Synergie", "Win Condition": "Siegbedingung", Utility: "Sonstiges", Land: "Länder", "": "Sonstiges" };

// colour backgrounds while artwork loads (CSSOM, so no inline styles are needed in the markup)
export function paint(root) {
  for (const el of root.querySelectorAll("[data-bg]")) if (!el.style.background) el.style.background = artFallback(el.dataset.bg);
}

export function rememberCard(name) {
  const list = [name, ...(state.prefs.recentCards || []).filter((n) => n !== name)].slice(0, 12);
  setPref("recentCards", list);
}
