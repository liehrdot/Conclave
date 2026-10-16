// Adding cards to the collection: the camera scanner and the "how does it go in" sheet.
//
// The scanner reads the card on the phone itself, without AI: Tesseract (vendor/tesseract, loaded only when the
// scanner opens) reads the name line at the top of the frame and the set line at the bottom left ("MKM • DE" and the
// collector number of cards since 2015). Set + number find the exact printing (also of German cards), otherwise the
// name goes to Scryfall's fuzzy search, which forgives a misread letter. A hit opens ``addSheet``: original or proxy,
// foil, language, printing and quantity; the choice of original/proxy and language sticks for the next card.

import { op, setPref, state, undo } from "./data.js";
import * as scry from "./scry.js";
import { closeSheet, openSheet, popPage, present, pushPage, redraw, toast } from "./ui.js";
import { $, $$, debounce, esc, icon, uid, vibrate } from "./util.js";

const OCR = "/app/vendor/tesseract";
// the parts of the frame that are read, as parts of its width and height: the top fifth (the name line, wherever the card
// sits in it) and the bottom left (the set line); a little beyond the frame, as cards are rarely held exactly in it
const TOP_BOX = { x: -0.04, y: -0.03, w: 0.96, h: 0.22 };
const BOTTOM_BOX = { x: -0.05, y: 0.84, w: 0.75, h: 0.19 };
const LANGS = { EN: "en", DE: "de", FR: "fr", IT: "it", ES: "es", SP: "es", PT: "pt", JP: "ja", JA: "ja", KO: "ko", RU: "ru", CS: "zhs", CT: "zht", PH: "ph" };
export const LANG_NAMES = { en: "Englisch", de: "Deutsch", fr: "Französisch", it: "Italienisch", es: "Spanisch", pt: "Portugiesisch", ja: "Japanisch",
  ko: "Koreanisch", ru: "Russisch", zhs: "Chinesisch", zht: "Chinesisch (trad.)", ph: "Phyrexianisch" };

// ---------- text recognition ----------
let engine = null;
function ocr() {
  engine ||= (async () => {
    const { default: { createWorker } } = await import(`${OCR}/tesseract.esm.min.js`);
    return createWorker("eng", 1, { workerPath: `${OCR}/worker.min.js`, corePath: `${OCR}/tesseract-core-simd-lstm.js`, langPath: OCR, workerBlobURL: false });
  })().catch((e) => { engine = null; throw e; });
  return engine;
}

// the recognised lines of a picture, top to bottom: {text, conf}; unsure words at the ends of a line (the mana cost,
// a bit of the frame) are left out
async function read(canvas, psm) {
  const w = await ocr();
  await w.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: "1" });
  const { data } = await w.recognize(canvas, {}, { text: true, blocks: true });
  const lines = (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  return lines.sort((a, b) => a.bbox.y0 - b.bbox.y0).map((l) => {
    const words = [...(l.words || [])];
    while (words.length > 1 && words[0].confidence < 45) words.shift();
    while (words.length > 1 && words[words.length - 1].confidence < 45) words.pop();
    return { text: words.length ? words.map((x) => x.text).join(" ") : l.text.trim(), conf: l.confidence };
  });
}

// the name candidates of the top strip: the first lines that look like words
export function nameLines(lines) {
  return [...new Set(lines.map((l) => cleanName(l.text)).filter((t) => t.length >= 3 && /\p{L}{3}/u.test(t)))].slice(0, 4);
}

// "Sol Rinq @" → "Sol Rinq": letters (also accents), spaces, apostrophes, commas, hyphens; stray symbols at the ends go
export function cleanName(text) {
  const line = String(text).split("\n").map((l) => l.trim()).sort((a, b) => b.length - a.length)[0] || "";
  const words = line.replace(/[’`´]/g, "'").replace(/[^\p{L}' ,\-]/gu, " ").split(/\s+/).filter(Boolean);
  while (words.length && !/\p{L}{2}/u.test(words[0])) words.shift();
  while (words.length && !/\p{L}{2}/u.test(words[words.length - 1])) words.pop();
  return words.join(" ").replace(/^[,'\-]+|[,'\-]+$/g, "").trim();
}

// "0123 R" / "MKM • DE ✒ Artist" (and older "123/280 R" / "M20 • EN") → {set, number, lang}
export function parseLine(text) {
  const t = String(text).toUpperCase().replace(/[|]/g, "I");
  const m = t.match(/\b([A-Z0-9]{3,5})\s*[^A-Z0-9\s]{0,2}\s*(EN|DE|FR|IT|ES|SP|PT|JP|JA|KO|RU|CS|CT|PH)\b/);
  if (!m || !/[A-Z]/.test(m[1])) return null;
  const before = t.slice(0, m.index);
  const n = before.match(/\b0*(\d{1,4})(?:\s*\/\s*\d{1,4})?\b/) || t.slice(m.index + m[0].length).match(/\b0*(\d{1,4})\s*\/\s*\d{1,4}\b/);
  return { set: m[1].toLowerCase(), number: n ? n[1] : "", lang: LANGS[m[2]] || "en" };
}

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
function ratio(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
// how well a read name fits a printing: its English name, its printed (German, …) name, the front face
// (a long piece of a name counts too: the first word is often cut off when the card sits askew)
export function similar(text, card) {
  const names = [card.name, card.printed_name, ...(card.card_faces || []).flatMap((f) => [f.name, f.printed_name])].filter(Boolean);
  const t = norm(text);
  return Math.max(0, ...names.map((n) => (t.length >= 8 && norm(n).includes(t) ? Math.max(0.8, ratio(text, n)) : ratio(text, n))));
}

const looked = new Map();  // read text → the printing Scryfall gave (or null): each text is asked once
function lookup(key, fn) {
  if (!looked.has(key)) looked.set(key, fn());
  return looked.get(key);
}

/** The printing a scan shows: by set + number (checked against the name), else by name; ``sure`` = no second look needed. */
export async function identify(name, line) {
  let bySet = null;
  if (line?.set && line.number) {
    bySet = await lookup(`#${line.set}/${line.number}/${line.lang}`, () => scry.printing(line.set, line.number, line.lang)
      .then((x) => x || (line.lang !== "en" ? scry.printing(line.set, line.number) : null)));
    // agrees with the name, or the name is a cut-off piece of it ("Fight" from "Rejoin the Fight")
    const piece = norm(name).length >= 4 && [bySet?.name, bySet?.printed_name].some((n) => norm(n).includes(norm(name)));
    if (bySet && (piece || similar(name, bySet) >= 0.45)) return { card: bySet, sure: true, bySet: true };
  }
  // a set line that disagrees with a clearly read name was misread: the name wins
  if (name.length < 3) return bySet ? { card: bySet, sure: false } : null;
  const c = await lookup(`${name}|${line?.set || ""}`, async () => (line?.set ? await scry.named(name, line.set) : null) || scry.named(name));
  if (c && similar(name, c) >= 0.7) return { card: c, sure: similar(name, c) >= 0.85 };
  // a German (or other) printed name; a misread letter fails Scryfall's search, so its longest word is asked too
  const word = name.split(/[\s\-,]+/).sort((a, b) => b.length - a.length)[0] || "";
  const list = await lookup(`*${name}`, async () => {
    if (name.length < 5) return [];
    const found = await scry.byPrintedName(name);
    return found.length || word.length < 6 || word === name ? found : scry.byPrintedName(word);
  });
  const p = list.reduce((best, x) => (similar(name, x) > (best ? similar(name, best) : 0) ? x : best), null);
  if (p && similar(name, p) >= 0.75) return { card: p, sure: similar(name, p) >= 0.85 };
  return null;
}

// ---------- camera picture → the two strips the text recognition reads ----------
// Where the card should be: its centre and size in the picture's own pixels. Live: the frame on the screen, mapped onto
// the video (object-fit: cover); a photo: a card-sized box tried at a few sizes (photoViews()).
function videoView(video, frame) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const vr = video.getBoundingClientRect(), fr = frame.getBoundingClientRect();
  const s = Math.max(vr.width / vw, vr.height / vh);
  const ox = vr.left + (vr.width - vw * s) / 2, oy = vr.top + (vr.height - vh * s) / 2;
  return { src: video, fw: fr.width / s, fh: fr.height / s, fcx: (fr.left + fr.width / 2 - ox) / s, fcy: (fr.top + fr.height / 2 - oy) / s };
}
function strip(view, box, height, angle = 0) {
  const { src: video, fw, fh, fcx, fcy } = view;
  const sw = fw * box.w, sh = fh * box.h;
  const c = document.createElement("canvas");
  c.height = height;
  c.width = Math.round((sw / sh) * height);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  // the box around the frame's centre, turned by ``angle`` (a tilted card comes out straight)
  const k = height / sh;
  g.setTransform(k, 0, 0, k, -(box.x - 0.5) * fw * k, -(box.y - 0.5) * fh * k);
  g.rotate(-angle);
  g.drawImage(video, -fcx, -fcy);
  g.setTransform(1, 0, 0, 1, 0, 0);
  // grey, contrast stretched (2 % – 98 %): glare and dim light read better
  const img = g.getImageData(0, 0, c.width, c.height), px = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) { const y = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0; px[i] = y; hist[y]++; }
  const n = px.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255 && (acc += hist[lo]) < n * 0.02; lo++);
  acc = 0;
  for (; hi > 0 && (acc += hist[hi]) < n * 0.02; hi--);
  const span = Math.max(24, hi - lo);
  for (let i = 0; i < px.length; i += 4) { const y = Math.max(0, Math.min(255, ((px[i] - lo) * 255) / span)); px[i] = px[i + 1] = px[i + 2] = y; }
  g.putImageData(img, 0, 0);
  return c;
}

// How far the card is turned (radians, clockwise): the frame lines at the top of the card, seen in a left and a right
// window, sit higher on one side – the shift that lines up both row profiles gives the angle.
function tilt(view) {
  const c = strip(view, { x: 0.04, y: -0.02, w: 0.92, h: 0.26 }, 220);
  const W = c.width, H = c.height;
  const px = c.getContext("2d").getImageData(0, 0, W, H).data;
  const profile = (from, to) => {
    const out = new Float64Array(H - 1);
    for (let y = 0; y < H - 1; y++) { let e = 0; for (let x = from; x < to; x++) e += Math.abs(px[((y + 1) * W + x) * 4] - px[(y * W + x) * 4]); out[y] = e; }
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    return out.map((v) => v - mean);
  };
  const L = profile(Math.round(W * 0.05), Math.round(W * 0.3)), R = profile(Math.round(W * 0.7), Math.round(W * 0.95));
  const span = W * 0.65, D = Math.round(span * 0.14);
  let best = 0, bestD = 0;
  for (let d = -D; d <= D; d++) {
    let sum = 0;
    for (let y = Math.max(0, -d); y < Math.min(L.length, L.length - d); y++) sum += L[y] * R[y + d];
    if (sum > best) { best = sum; bestD = d; }
  }
  return Math.atan2(bestD, span);
}

// The name line in the top strip: the two bands of rows with the most letter-like edges (art and table have fewer),
// each cut to the bright name bar in it – Tesseract reads a tight line far better than the whole strip.
function nameBands(c) {
  const W = c.width, H = c.height;
  const px = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const at = (x, y) => px[(y * W + x) * 4];
  const hb = Math.max(8, Math.round((0.05 / TOP_BOX.h) * H));  // a line of name text plus a little air
  const x0 = Math.round(W * 0.1), x1 = Math.round(W * 0.9);
  const energy = new Float64Array(H);
  for (let y = 0; y < H; y++) { let e = 0; for (let x = x0; x < x1; x++) e += Math.abs(at(x + 1, y) - at(x, y)); energy[y] = e; }
  const score = new Float64Array(Math.max(1, H - hb + 1));
  for (let y = 0; y < score.length; y++) { let s = 0; for (let k = 0; k < hb; k++) s += energy[y + k] || 0; score[y] = s; }
  const out = [];
  for (let i = 0; i < 2; i++) {
    let y = 0;
    for (let k = 1; k < score.length; k++) if (score[k] > score[y]) y = k;
    if (score[y] < 0) break;
    for (let k = Math.max(0, y - hb); k < Math.min(score.length, y + hb); k++) score[k] = -1;
    const pad = Math.round(hb / 4), ya = Math.max(0, y - pad), yb = Math.min(H, y + hb + pad);
    // the bar: the longest run of columns whose brighter pixels are bright (letters are the minority in a column)
    const col = new Float64Array(W);
    for (let x = 0; x < W; x++) {
      const v = [];
      for (let yy = ya; yy < yb; yy++) v.push(at(x, yy));
      v.sort((p, q) => p - q);
      col[x] = v[Math.floor(v.length * 0.75)];
    }
    const sm = col.map((_, x) => { let s = 0, n = 0; for (let k = Math.max(0, x - 4); k <= Math.min(W - 1, x + 4); k++) { s += col[k]; n++; } return s / n; });
    const sorted = [...sm].sort((p, q) => p - q);
    const thr = (sorted[Math.floor(W * 0.9)] + sorted[Math.floor(W * 0.1)]) / 2;
    let best = [0, 0, W], start = 0;
    for (let x = 0; x <= W; x++) {
      const on = x < W && sm[x] > thr;
      if (on && (x === 0 || !(sm[x - 1] > thr))) start = x;
      if (!on && x > 0 && sm[x - 1] > thr && x - start > best[0]) best = [x - start, start, x];
    }
    const found = best[0] > W * 0.35;
    const [, l, r] = found ? best : [W, 0, W];
    // its rows: the text itself – rows with many letter edges around the strongest one (not the frame above, not the art)
    let ta = y, tb = Math.min(H, y + hb);
    {
      const e = [];
      for (let yy = Math.max(0, y - (hb >> 1)); yy < Math.min(H, y + hb + (hb >> 1)); yy++) {
        let v = 0;
        for (let x = Math.max(0, l); x < Math.min(W - 1, r); x++) v += Math.abs(at(x + 1, yy) - at(x, yy));
        e.push([yy, v]);
      }
      let top = 0;
      for (let k = 1; k < e.length; k++) if (e[k][1] > e[top][1]) top = k;
      let a0 = top, b0 = top;
      while (a0 > 0 && e[a0 - 1][1] > e[top][1] * 0.3) a0--;
      while (b0 < e.length - 1 && e[b0 + 1][1] > e[top][1] * 0.3) b0++;
      const m = Math.round((b0 - a0 + 1) * 0.3);  // and some air: a tilted card slants the line
      if (b0 - a0 + 1 >= 6) [ta, tb] = [Math.max(0, e[a0][0] - m), Math.min(H, e[b0][0] + 1 + m)];
    }
    // both the tight cut and the whole band: which one reads better depends on the card's tilt and frame
    out.push(cutBand(c, found, l, r, ta, tb));
    if (ta > ya + 2 || tb < yb - 2) out.push(cutBand(c, found, l, r, ya, yb));
  }
  return out;
}

// The set line in the bottom strip: the band with the most letter edges (two lines of small print), light letters on
// the black border turned dark on light.
function lineBand(c) {
  const W = c.width, H = c.height;
  const px = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const at = (x, y) => px[(y * W + x) * 4];
  const hb = Math.max(10, Math.round((0.06 / BOTTOM_BOX.h) * H));
  const energy = new Float64Array(H);
  for (let y = 0; y < H; y++) { let e = 0; for (let x = 0; x < W - 1; x++) e += Math.abs(at(x + 1, y) - at(x, y)); energy[y] = e; }
  let best = 0, bestY = 0;
  for (let y = 0; y + hb <= H; y++) { let e = 0; for (let k = 0; k < hb; k++) e += energy[y + k]; if (e > best) { best = e; bestY = y; } }
  const ya = Math.max(0, bestY - (hb >> 3)), yb = Math.min(H, bestY + hb + (hb >> 3));
  let sum = 0, n = 0;
  for (let y = ya; y < yb; y++) for (let x = 0; x < W; x += 3) { sum += at(x, y); n++; }
  const dark = sum / n < 110;
  const pad = Math.round(hb * 0.25);
  const band = document.createElement("canvas");
  band.width = W + 2 * pad; band.height = yb - ya + 2 * pad;
  const g = band.getContext("2d");
  if (dark) g.filter = "invert(1)";
  g.fillStyle = dark ? "#141414" : "#ebebeb";
  g.fillRect(0, 0, band.width, band.height);
  g.drawImage(c, 0, ya, W, yb - ya, pad, pad, W, yb - ya);
  return band;
}

// a band as Tesseract likes it: dark letters on a light field with some air around (a dark bar is turned light)
function cutBand(c, found, l, r, ta, tb) {
  const W = c.width, th = tb - ta;
  const bx = found ? Math.min(W - 2, l + Math.max(4, Math.round(th * 0.3))) : 0;  // the bar's rounded end reads as a "(" or "B"
  const bw = Math.max(2, (found ? r - Math.round(th * 0.3) : W) - bx);
  const g = c.getContext("2d").getImageData(bx, ta, bw, th).data;
  let sum = 0;
  for (let k = 0; k < g.length; k += 4) sum += g[k];
  const dark = sum / (g.length / 4) < 100;
  const padPx = Math.round(th * 0.35);
  const band = document.createElement("canvas");
  band.width = bw + 2 * padPx; band.height = th + 2 * padPx;
  const bg = band.getContext("2d");
  if (dark) bg.filter = "invert(1)";
  bg.fillStyle = dark ? "#141414" : "#ebebeb";
  bg.fillRect(0, 0, band.width, band.height);
  bg.drawImage(c, bx, ta, bw, th, padPx, padPx, bw, th);
  return band;
}

/** The name candidates and the set line of the card in ``view``. */
async function readCard(view) {
  const angle = tilt(view);
  const topC = strip(view, TOP_BOX, 240, angle), botC = strip(view, BOTTOM_BOX, 300, angle);
  const rawTop = [];
  for (const band of nameBands(topC)) rawTop.push(...await read(band, "7"));
  const rawBot = await read(lineBand(botC), "6");
  return { names: nameLines(rawTop), line: parseLine(rawBot.map((l) => l.text).join("\n")) };
}
async function identifyRead({ names, line }, longest = false) {
  // a photo tries the longest read first: a box too big for the card also reads a piece of the name ("Fight")
  const order = longest ? [...names].sort((a, b) => norm(b).length - norm(a).length) : names;
  for (const n of order) { const hit = await identify(n, line); if (hit) return { ...hit, read: n }; }
  return line?.number ? identify("", line).then((hit) => hit && { ...hit, read: "" }) : null;
}
// how much of the card's name the read text covers (a box too big for the card reads only a piece: "Fight")
const coverage = (hit) => Math.max(...[hit.card.name, hit.card.printed_name].filter(Boolean)
  .map((n) => Math.min(1, norm(hit.read).length / Math.max(1, norm(n.split(" // ")[0]).length))));

// A photo from the phone's own camera app: no frame to line the card up in, so card-sized boxes from big (the card fills
// the picture) to small are tried around the centre; the first sure hit wins, else the first weak one.
const PHOTO_SIZES = [0.94, 0.82, 0.7, 0.58, 0.47];
async function photoPicture(file) {
  const bmp = await createImageBitmap(file);  // turned upright by its EXIF orientation
  const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}
function photoViews(pic) {
  const W = pic.width, H = pic.height;
  return PHOTO_SIZES.map((f) => {
    let fh = H * f, fw = fh * 63 / 88;
    if (fw > W * 0.96) { fw = W * 0.96 * (f / PHOTO_SIZES[0]); fh = fw * 88 / 63; }
    return { src: pic, fw, fh, fcx: W / 2, fcy: H / 2 };
  });
}
export async function scanPhoto(file) {
  const pic = await photoPicture(file);
  await ocr();
  let best = null, bestScore = 0;
  const views = photoViews(pic);
  for (let i = 0; i < views.length; i++) {
    const view = views[i];
    const r = await readCard(view);
    if (!r.names.length && !r.line?.number) continue;
    const hit = await identifyRead(r, true);
    if (!hit) {
      // text but no card: the card may sit off the centre – the same size a little to the left and right
      if (!view.shifted) for (const dx of [-0.05, 0.05]) views.splice(i + 1, 0, { ...view, fcx: view.fcx + dx * pic.width, shifted: true });
      continue;
    }
    const long = norm(hit.read).length;
    // set line and name agree > the whole name read > a piece of it; more text read = more sure
    const score = (hit.bySet ? 2 : 0) + (hit.sure ? 1 : 0.5) * (0.4 + coverage(hit)) + Math.min(long, 30) / 300;
    if (score > bestScore) { best = { card: hit.card, line: r.line }; bestScore = score; }
    if (hit.bySet || (hit.sure && coverage(hit) >= 0.85 && long >= 10)) break;  // as sure as it gets
  }
  return best;
}

// The back cameras a phone lists, each with a short name: an iPhone names its lenses ("Back Ultra Wide Camera",
// German "Rückseitige Ultraweitwinkelkamera"), an Android phone mostly lists one back camera ("camera2 0, facing back").
const FRONT = /front|vorder|user|facetime|selfie|avant|frontal/i;
function backLenses(devices) {
  const cams = devices.filter((d) => d.kind === "videoinput" && d.label && !FRONT.test(d.label));
  const name = (label, i) => (/ultra/i.test(label) ? "0,5×" : /tele/i.test(label) ? "Tele" : /triple|dual/i.test(label) ? "Auto"
    : /camera2? \d|kamera \d/i.test(label) && cams.length > 1 ? `Kamera ${i + 1}` : "1×");
  const out = cams.map((d, i) => ({ id: d.deviceId, label: name(d.label, i) }));
  const order = { "0,5×": 0, "1×": 1, Auto: 2, Tele: 3 };
  out.sort((a, b) => (order[a.label] ?? 4) - (order[b.label] ?? 4));
  return out.filter((x, i) => out.findIndex((y) => y.label === x.label) === i);  // one chip per name
}

// ---------- the scanner ----------
/** Full-screen camera that adds cards to the collection one after another. */
export function scanner() {
  let stream = null, running = true, paused = false, timer = null, added = 0, last = null, ignore = null;
  const stop = () => {
    document.body.classList.remove("camera");
    running = false;
    clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };
  present(`<div class="cam">
      <video id="cam-video" playsinline muted autoplay></video>
      <div class="cam-frame" id="cam-frame" aria-hidden="true"><span class="cam-name"></span><span class="cam-line"></span></div>
      <div class="cam-top">
        <button class="icon-btn glass" type="button" data-present-close aria-label="Scanner schließen">${icon("x")}</button>
        <span class="cam-title">Karte scannen</span>
        <button class="icon-btn glass" type="button" id="cam-torch" aria-label="Licht" aria-pressed="false" hidden>${icon("bolt")}</button>
      </div>
      <p class="cam-hint" id="cam-hint" role="status" aria-live="polite">Kamera startet …</p>
      <div class="cam-bottom">
        <div class="cam-lens-row"><div class="cam-lens" id="cam-lens" role="group" aria-label="Objektiv" hidden></div></div>
        <span class="cam-count" id="cam-count" hidden></span>
        <button class="btn glass" type="button" id="cam-photo">${icon("camera", "sm")}Foto aufnehmen</button>
        <button class="btn glass" type="button" id="cam-type">${icon("search", "sm")}Name eingeben</button>
        <input type="file" id="cam-file" accept="image/*" capture="environment" hidden>
      </div>
    </div>`, {
    bare: true, label: "Karte scannen",
    bind: async (el) => {
      document.body.classList.add("camera");
      const video = $("#cam-video", el), frame = $("#cam-frame", el), hint = $("#cam-hint", el);
      const say = (text, cls = "") => { hint.textContent = text; hint.className = `cam-hint ${cls}`; };
      const pause = (on) => { paused = on; el.querySelector(".cam").classList.toggle("paused", on); };
      $("#cam-type", el).addEventListener("click", () => { pause(true); searchSheet({ onClose: () => pause(false) }); });
      const found = (card, line) => {
        pause(true);
        vibrate(25);
        last = null;
        addSheet(card, {
          lang: card.lang !== "en" ? card.lang : line?.lang || "",
          onAdded: () => { added++; count(); ignore = card.oracle_id; },
          onClose: () => { say("Halte die Karte in den Rahmen – der Name oben."); pause(false); },
        });
      };
      // a photo from the phone's own camera app (sharper, its own zoom and macro): read like a frame, once
      const file = $("#cam-file", el);
      $("#cam-photo", el).addEventListener("click", () => { pause(true); file.value = ""; file.click(); });
      file.addEventListener("cancel", () => pause(false));
      file.addEventListener("change", async () => {
        const f = file.files?.[0];
        if (track?.readyState === "ended") open(track.getSettings?.().deviceId).catch(() => {});  // the camera app took it
        if (!f) return pause(false);
        say("Lese das Foto …", "reading");
        let hit = null;
        try { hit = await scanPhoto(f); } catch { /* no picture or no text recognition */ }
        if (!running) return;
        if (hit) found(hit.card, hit.line);
        else { toast("Auf dem Foto keine Karte erkannt", { sub: "Näher ran und den Namen scharf – oder „Name eingeben“." }); pause(false); }
      });
      const count = () => { const c = $("#cam-count", el); c.hidden = !added; c.textContent = `${added} hinzugefügt`; };

      // the camera, its lenses (an iPhone lists ultra wide, wide and tele as cameras of their own) and its zoom
      const torch = $("#cam-torch", el), lensBox = $("#cam-lens", el);
      let track = null, lenses = [];
      const open = async (deviceId) => {
        stream?.getTracks().forEach((t) => t.stop());
        // the camera's own picture, never cut to the screen's shape (that looked zoomed in); the frame maths handle any size
        const video_ = { width: { ideal: 1920 }, height: { ideal: 1080 }, resizeMode: { ideal: "none" } };
        stream = await navigator.mediaDevices.getUserMedia({ audio: false,
          video: deviceId ? { ...video_, deviceId: { exact: deviceId } } : { ...video_, facingMode: { ideal: "environment" } } });
        if (!running) return stop();
        video.srcObject = stream;
        await video.play().catch(() => {});
        track = stream.getVideoTracks()[0];
        try { track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {}); } catch { /* not supported */ }
        const caps = track.getCapabilities?.() || {};
        torch.hidden = !caps.torch;
        torch.setAttribute("aria-pressed", "false");
        lensChips(caps);
      };
      const lensChips = (caps) => {
        const current = track.getSettings?.().deviceId;
        let items = [];
        if (lenses.length > 1) items = lenses.map((l) => ({ label: l.label, on: l.id === current, run: () => pick(l.id) }));
        else if (caps.zoom && caps.zoom.max > caps.zoom.min) {
          const now = track.getSettings?.().zoom ?? caps.zoom.min;
          const steps = [...new Set([caps.zoom.min, 1, 2, 3].filter((z) => z >= caps.zoom.min && z <= Math.min(caps.zoom.max, 4)))];
          items = steps.map((z) => ({ label: `${String(Math.round(z * 10) / 10).replace(".", ",")}×`, on: Math.abs(z - now) < 0.05,
            run: () => track.applyConstraints({ advanced: [{ zoom: z }] }).then(() => lensChips(caps), () => {}) }));
        }
        lensBox.hidden = items.length < 2;
        lensBox.innerHTML = items.map((x, i) => `<button type="button" data-lens="${i}" aria-pressed="${x.on}">${esc(x.label)}</button>`).join("");
        for (const b of $$("[data-lens]", lensBox)) b.addEventListener("click", () => items[b.dataset.lens].run());
      };
      const pick = async (id) => {
        setPref("scanLens", id);
        try { await open(id); } catch { await open().catch(() => {}); }
      };
      torch.addEventListener("click", () => {
        const on = torch.getAttribute("aria-pressed") !== "true";
        track?.applyConstraints({ advanced: [{ torch: on }] }).then(() => torch.setAttribute("aria-pressed", on), () => {});
      });
      try {
        await open();
      } catch {
        say("Die Kamera ist hier nicht verfügbar oder nicht erlaubt – nimm ein Foto auf oder gib den Namen ein.", "warn");
        return;
      }
      if (!running) return;
      // the back cameras by name (only readable once the camera is allowed); the one picked last time comes back
      try {
        lenses = backLenses(await navigator.mediaDevices.enumerateDevices());
        const saved = lenses.find((l) => l.id === state.prefs.scanLens);
        if (saved && saved.id !== track.getSettings?.().deviceId) await pick(saved.id);
        else lensChips(track.getCapabilities?.() || {});
      } catch { /* keep the camera we have */ }
      say("Lade die Texterkennung …");
      try { await ocr(); } catch {
        say("Die Texterkennung lädt nicht – ohne Netz beim ersten Mal? Tippe auf „Name eingeben“.", "warn");
        return;
      }
      say("Halte die Karte in den Rahmen – der Name oben.");

      const tick = async () => {
        if (!running) return;
        if (paused || video.readyState < 2 || !video.videoWidth || document.hidden) { timer = setTimeout(tick, 300); return; }
        try {
          const { names, line } = await readCard(videoView(video, frame));
          if (!running || paused) { timer = setTimeout(tick, 300); return; }
          const name = names[0] || "";
          if (!names.length && !line?.number) {
            ignore = null;  // the card left the frame: the same card may come again
            say("Halte die Karte in den Rahmen – der Name oben.");
          } else {
            say(name ? `Lese „${name}“ …` : "Lese …", "reading");
            const hit = await identifyRead({ names, line });  // only the set line: the same read twice will do
            if (hit && running && !paused && hit.card.oracle_id !== ignore) {
              if (hit.sure || last === hit.card.id) { found(hit.card, line); timer = setTimeout(tick, 300); return; }
              last = hit.card.id;  // a weak match has to come twice in a row
            } else if (hit?.card.oracle_id === ignore) say("Schon hinzugefügt – nächste Karte bitte.", "done");
          }
        } catch { /* one bad frame */ }
        timer = setTimeout(tick, 120);
      };
      tick();
    },
    onClose: stop,
  });
}

// ---------- by name (no camera, or a card the scanner does not read) ----------
export function searchSheet({ onClose = null } = {}) {
  let q = "", items = [], busy = false, handedOver = false;
  const run = debounce(async () => {
    if (q.trim().length < 2) { items = []; return draw(); }
    busy = true; draw();
    try { items = await scry.searchCards(q.trim()); } catch { items = null; }
    busy = false; draw();
  }, 260);
  const draw = () => {
    const out = $("#add-results");
    if (!out) return;
    out.innerHTML = items === null ? `<p class="hint-small">Scryfall ist gerade nicht erreichbar.</p>`
      : items.length ? `<div class="group">${items.map((c) => `<button class="row" type="button" data-pick="${esc(c.name)}"><span class="main"><span class="title">${esc(c.de || c.name)}</span>
          <span class="subtitle">${esc(c.de ? c.name : c.type || "")}</span></span>${icon("chev-r", "sm chev")}</button>`).join("")}</div>`
      : `<p class="hint-small">${busy ? "Suche …" : q.trim().length >= 2 ? "Keine Karte gefunden." : "Deutsche und englische Namen gehen, ein Teil reicht."}</p>`;
    for (const b of $$("[data-pick]", out)) b.addEventListener("click", () => pick(b.dataset.pick));
  };
  const pick = async (name) => {
    const card = await scry.named(name);
    if (!card) { toast("Die Karte lädt gerade nicht – bitte noch einmal."); return; }
    const de = items?.find((x) => x.name === name)?.de;
    let picked = card;
    if (de) picked = (await scry.printing(card.set, card.collector_number, "de")) || card;
    handedOver = true;  // the add sheet takes this sheet's place (and its onClose)
    addSheet(picked, { onClose, lang: de ? "de" : "" });
  };
  openSheet(() => ({
    title: "Karte hinzufügen",
    body: `<label class="search"><span class="sr">Kartenname</span>${icon("search")}<input class="input" id="add-q" type="search" placeholder="Kartenname" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div id="add-results"></div>`,
    bind(el) {
      const input = $("#add-q", el);
      input.value = q;
      input.addEventListener("input", () => { q = input.value; run(); });
      setTimeout(() => input.focus(), 350);
      draw();
    },
  }), { onClose: () => { if (!handedOver) onClose?.(); } });
}

/** Open the sheet for a card by its English name (the card sheet of the Karten tab). */
export async function addByName(name, opts = {}) {
  const card = await scry.named(name);
  if (!card) { toast("Die Karte lädt gerade nicht – bitte noch einmal."); return; }
  addSheet(card, opts);
}

// ---------- how the card goes in ----------
const own = (oracleName) => (state.snap?.collection || []).filter((e) => e.name === oracleName);
export const fmtEur = (v) => (v == null || v === "" ? "" : `${Number(v).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`);

// ---------- where a card lives: one of the decks or a free text ("Binder rot") ----------
export function placeName(e) {
  if (e?.place_deck) return state.snap?.decks?.find((d) => d.slug === e.place_deck)?.name || e.place_deck;
  return e?.place || "";
}

function knownPlaces() {  // free-text places from the collection, most cards first
  const n = new Map();
  for (const e of state.snap?.collection || []) {
    const t = !e.place_deck && (e.place || "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    const hit = n.get(k) || { place: t, cards: 0 };
    hit.cards += e.qty;
    n.set(k, hit);
  }
  return [...n.values()].sort((a, b) => b.cards - a.cards || a.place.localeCompare(b.place));
}

// a sheet page to pick the place; onPick({place, place_deck}) gets "" for both when there is none
export function placePage(current, onPick) {
  return () => {
    const decks = [...(state.snap?.decks || [])].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const texts = knownPlaces();
    const cur = current() || {};
    const on = (deck, text) => (deck ? cur.place_deck === deck : !cur.place_deck && (cur.place || "").toLowerCase() === text.toLowerCase());
    const row = (attrs, title, sub, pressed) => `<button class="row" type="button" ${attrs}>
        <span class="main"><span class="title">${esc(title)}</span>${sub ? `<span class="subtitle">${esc(sub)}</span>` : ""}</span>${pressed ? icon("check", "sm") : ""}</button>`;
    return {
      title: "Ort", left: `<button class="btn plain" type="button" data-sheet-back>${icon("chev-l", "sm")}Zurück</button>`,
      body: `<form class="place-new" id="place-form"><label class="sr" for="place-text">Eigener Ort</label>
          <input class="input" id="place-text" maxlength="80" placeholder="z. B. Binder rot" autocomplete="off" enterkeyhint="done" value="${esc(cur.place_deck ? "" : cur.place || "")}">
          <button class="btn tint" type="submit">Übernehmen</button></form>
        <div class="group">${row('data-place-none', "Kein Ort", "", !cur.place_deck && !cur.place)}</div>
        ${decks.length ? `<div class="field-label">Decks</div><div class="group">${decks.map((d) => row(`data-place-deck="${esc(d.slug)}"`, d.name, (d.commanders || []).join(" + "), on(d.slug, ""))).join("")}</div>` : ""}
        ${texts.length ? `<div class="field-label">Deine Orte</div><div class="group">${texts.map((t) => row(`data-place-text="${esc(t.place)}"`, t.place, `${t.cards} ${t.cards === 1 ? "Karte" : "Karten"}`, on("", t.place))).join("")}</div>` : ""}`,
      bind(el) {
        const pick = (place, place_deck) => { onPick({ place, place_deck }); popPage(); };
        $("[data-place-none]", el).addEventListener("click", () => pick("", ""));
        for (const b of $$("[data-place-deck]", el)) b.addEventListener("click", () => pick("", b.dataset.placeDeck));
        for (const b of $$("[data-place-text]", el)) b.addEventListener("click", () => pick(b.dataset.placeText, ""));
        $("#place-form", el).addEventListener("submit", (ev) => {
          ev.preventDefault();
          const t = $("#place-text", el).value.trim().replace(/\s+/g, " ").slice(0, 80);
          const deck = t && decks.find((d) => d.name.toLowerCase() === t.toLowerCase());  // a typed deck name means the deck
          pick(deck ? "" : t, deck ? deck.slug : "");
        });
      },
    };
  };
}

export function addSheet(first, { lang = "", onAdded = null, onClose = null } = {}) {
  const sticky = state.prefs.scanAdd || {};
  let card = first;
  const finishes = () => card.finishes?.length ? card.finishes : ["nonfoil", "foil"];
  const s = { proxy: !!sticky.proxy, foil: finishes()[0] !== "nonfoil", lang: lang || card.lang || "en", qty: 1 };
  const last = state.prefs.scanPlace || {};  // the place used last, kept while it still exists
  const where = { place: last.place || "", place_deck: last.place_deck && state.snap?.decks?.some((d) => d.slug === last.place_deck) ? last.place_deck : "" };
  let printsList = null;

  const swapLang = async (to) => {  // the same printing in the chosen language, when Scryfall has it
    s.lang = to;
    redraw();
    if (card.lang === to) return;
    const other = await scry.printing(card.set, card.collector_number, to);
    if (other && s.lang === to) { card = other; redraw(); }
  };
  const main = () => {
    const facts = scry.entryFacts(card, { foil: s.foil });
    const have = own(card.name);
    const haveN = have.reduce((n, e) => n + e.qty, 0), haveP = have.filter((e) => e.proxy).reduce((n, e) => n + e.qty, 0);
    const printed = card.printed_name && card.printed_name !== card.name ? card.printed_name : "";
    const langs = [...new Set(["en", "de", card.lang, s.lang])];
    const fin = finishes();
    return {
      title: "Zur Sammlung",
      body: `<div class="add-card">
          <div class="add-img">${facts.image ? `<img src="${esc(facts.image)}" alt="${esc(card.name)}">` : ""}</div>
          <div class="add-facts">
            <b class="add-name">${esc(printed || card.name)}</b>${printed ? `<span class="add-sub">${esc(card.name)}</span>` : ""}
            <span class="add-sub">${esc(card.set_name)}</span>
            <span class="add-sub mono">${esc(String(card.set).toUpperCase())} · #${esc(card.collector_number)} · ${esc(card.lang.toUpperCase())}</span>
            ${facts.price_eur && !s.proxy ? `<span class="add-sub">etwa ${esc(fmtEur(facts.price_eur))}</span>` : ""}
            <button class="btn plain small add-print" type="button" id="add-print">Andere Ausgabe${icon("chev-r", "xs")}</button>
          </div>
        </div>
        ${haveN ? `<p class="add-have">${icon("check", "xs")}Schon in deiner Sammlung: ${haveN}×${haveP ? ` (davon ${haveP} Proxy)` : ""}</p>` : ""}
        <div class="field-label">Art</div>
        <div class="segmented" role="radiogroup" aria-label="Art" id="add-kind">
          <button type="button" role="radio" data-proxy="0" aria-pressed="${!s.proxy}" aria-checked="${!s.proxy}">Original</button>
          <button type="button" role="radio" data-proxy="1" aria-pressed="${s.proxy}" aria-checked="${s.proxy}">Proxy</button></div>
        <div class="field-label">Ausführung${fin.length === 1 ? `<span class="hint">diese Ausgabe gibt es nur ${fin[0] === "nonfoil" ? "ohne Foil" : "als Foil"}</span>` : ""}</div>
        <div class="segmented" role="radiogroup" aria-label="Ausführung" id="add-finish">${[["nonfoil", "Normal"], ["foil", "Foil"]].map(([f, label]) => {
          const on = f === "foil" ? s.foil : !s.foil, can = f === "foil" ? fin.some((x) => x !== "nonfoil") : fin.includes("nonfoil");
          return `<button type="button" role="radio" data-finish="${f}" aria-pressed="${on}" aria-checked="${on}"${can || on ? "" : " disabled"}>${label}</button>`; }).join("")}</div>
        <div class="field-label">Sprache</div>
        <div class="chips" id="add-lang">${langs.map((l) => `<button class="chip" type="button" data-lang="${esc(l)}" aria-pressed="${s.lang === l}">${esc(LANG_NAMES[l] || l)}</button>`).join("")}</div>
        <div class="field-label">Ort<span class="hint">optional</span></div>
        <div class="group"><button class="row" type="button" id="add-place"><span class="main"><span class="title">${esc(placeName(where) || "Kein Ort")}</span>
          <span class="subtitle">${where.place_deck ? "Deck" : where.place ? "Eigener Ort" : "Deck oder eigener Ort, z. B. Binder"}</span></span>${icon("chev-r", "sm")}</button></div>
        <div class="field-label">Anzahl</div>
        <div class="stepper big-stepper"><button type="button" data-step="-1" aria-label="Eine weniger"${s.qty > 1 ? "" : " disabled"}>−</button><output id="add-qty">${s.qty}</output><button type="button" data-step="1" aria-label="Eine mehr">+</button></div>`,
      foot: `<button class="btn primary big" type="button" id="add-go">${icon("plus", "sm")}${s.qty > 1 ? `${s.qty} Karten hinzufügen` : "Hinzufügen"}</button>`,
      bind(el) {
        for (const b of $$("[data-proxy]", el)) b.addEventListener("click", () => { s.proxy = b.dataset.proxy === "1"; redraw(); });
        for (const b of $$("[data-finish]", el)) b.addEventListener("click", () => { s.foil = b.dataset.finish !== "nonfoil"; redraw(); });
        for (const b of $$("[data-lang]", el)) b.addEventListener("click", () => swapLang(b.dataset.lang));
        for (const b of $$("[data-step]", el)) b.addEventListener("click", () => { s.qty = Math.max(1, Math.min(99, s.qty + Number(b.dataset.step))); redraw(); });
        $("#add-print", el).addEventListener("click", () => pushPage(printPage));
        $("#add-place", el).addEventListener("click", () => pushPage(placePage(() => where, (w) => Object.assign(where, w))));
        $("#add-go", el).addEventListener("click", () => {
          const entry = { id: uid(), ...scry.entryFacts(card, { foil: s.foil }), proxy: s.proxy, foil: s.foil, lang: s.lang, qty: s.qty,
            place: where.place_deck ? "" : where.place, place_deck: where.place_deck };
          const sent = op("collection.add", { entry });
          setPref("scanAdd", { proxy: s.proxy });
          setPref("scanPlace", { place: entry.place, place_deck: entry.place_deck });
          onAdded?.(entry);
          closeSheet();
          const what = `${s.qty > 1 ? `${s.qty}× ` : ""}${printed || card.name}`;
          toast(`${what} ist in der Sammlung`, { ok: true, sub: [s.proxy ? "Proxy" : "Original", s.foil ? "Foil" : "", LANG_NAMES[s.lang], placeName(where)].filter(Boolean).join(" · "),
            action: { label: "Rückgängig", run: () => undo(sent) } });
        });
      },
    };
  };
  const printPage = () => {
    if (!printsList) scry.prints(card.oracle_id, { lang: s.lang === "en" ? "" : "any" }).then((list) => { printsList = list; redraw(); });
    const list = (printsList || []).filter((p) => s.lang === "en" ? p.lang === "en" : p.lang === s.lang || p.lang === "en");
    return {
      title: "Ausgabe wählen", left: `<button class="btn plain" type="button" data-sheet-back>${icon("chev-l", "sm")}Zurück</button>`,
      body: printsList === null ? `<p class="hint-small">Lade die Ausgaben …</p>`
        : `<div class="group">${list.map((p) => { const f = scry.entryFacts(p); return `<button class="row print-row" type="button" data-print="${esc(p.id)}" aria-current="${p.id === card.id}">
          <span class="thumb card-thumb">${f.image ? `<img src="${esc(f.image.replace("/normal/", "/small/"))}" alt="" loading="lazy">` : ""}</span>
          <span class="main"><span class="title">${esc(p.set_name)}</span><span class="subtitle mono">${esc(p.set.toUpperCase())} · #${esc(p.collector_number)} · ${esc(p.lang.toUpperCase())} · ${esc((p.released_at || "").slice(0, 4))}</span></span>
          ${p.id === card.id ? icon("check", "sm") : ""}</button>`; }).join("") || `<div class="empty"><p>Keine anderen Ausgaben gefunden.</p></div>`}</div>`,
      bind(el) {
        for (const b of $$("[data-print]", el)) b.addEventListener("click", () => {
          const p = printsList.find((x) => x.id === b.dataset.print);
          if (p) { card = p; s.lang = p.lang; if (!finishes().includes(s.foil ? "foil" : "nonfoil")) s.foil = finishes()[0] !== "nonfoil"; }
          popPage();
        });
      },
    };
  };
  openSheet(main, { onClose });
}

export const ownedQty = (name) => own(name).reduce((n, e) => n + e.qty, 0);
