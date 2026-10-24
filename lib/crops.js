// Panel cropping — webtoon strip se chhote crops (CapCut ke liye), copyright budget ke saath.
//  * detectPanels: strip ko 120px chauda grayscale karke har row ka std-dev dekhta hai — ek-rang (white/black) rows = gutter.
//    Gutters ke beech ka hissa = panel. Suggestions hain, user adjust karta hai.
//  * renderCrop: sharp extract → JPEG (source resolution, koi upscale nahi).
//  * Budget: ek image ke saare crops ki height ka total ≤ image height × budget% (default 40%).
const fs = require('fs');
const sharp = require('sharp');

const metaCache = new Map();   // file → { width, height, mtime }
const panelCache = new Map();  // file → { mtime, panels }

async function imageMeta(filePath) {
  const st = fs.statSync(filePath);
  const c = metaCache.get(filePath);
  if (c && c.mtime === st.mtimeMs) return c;
  const m = await sharp(filePath).metadata();
  const out = { width: m.width || 0, height: m.height || 0, mtime: st.mtimeMs };
  metaCache.set(filePath, out);
  return out;
}

/**
 * @returns {Promise<{y0:number,y1:number}[]>} panels (source px, top→bottom), gutters hata kar
 */
async function detectPanels(filePath, { sampleWidth = 120, sdThreshold = 6, minGutterRows = 4, minPanelPx = 120 } = {}) {
  const st = fs.statSync(filePath);
  const c = panelCache.get(filePath);
  if (c && c.mtime === st.mtimeMs) return c.panels;
  const meta = await imageMeta(filePath);
  const { data, info } = await sharp(filePath).resize({ width: sampleWidth }).grayscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const scale = meta.height / H;
  const gutters = [];
  let run = null;
  for (let y = 0; y < H; y++) {
    let sum = 0, sum2 = 0;
    for (let x = 0; x < W; x++) { const v = data[y * W + x]; sum += v; sum2 += v * v; }
    const mean = sum / W;
    const sd = Math.sqrt(Math.max(0, sum2 / W - mean * mean));
    const isGutter = sd < sdThreshold;
    if (isGutter) { if (!run) run = { y0: y, y1: y }; else run.y1 = y; }
    else if (run) { if (run.y1 - run.y0 + 1 >= minGutterRows) gutters.push(run); run = null; }
  }
  if (run && run.y1 - run.y0 + 1 >= minGutterRows) gutters.push(run);
  const panels = [];
  let prev = 0;
  for (const g of gutters) {
    const y0 = Math.round(prev * scale), y1 = Math.round(g.y0 * scale);
    if (y1 - y0 >= minPanelPx) panels.push({ y0, y1 });
    prev = g.y1 + 1;
  }
  const tailY0 = Math.round(prev * scale);
  if (meta.height - tailY0 >= minPanelPx) panels.push({ y0: tailY0, y1: meta.height });
  panelCache.set(filePath, { mtime: st.mtimeMs, panels });
  return panels;
}

/** rect ko image ke andar clamp karo; integers */
function clampRect(rect, meta) {
  let x = Math.max(0, Math.round(Number(rect.x) || 0));
  let y = Math.max(0, Math.round(Number(rect.y) || 0));
  let w = Math.round(Number(rect.w) || meta.width);
  let h = Math.round(Number(rect.h) || 0);
  if (x >= meta.width) x = 0;
  if (y >= meta.height) y = Math.max(0, meta.height - 1);
  w = Math.max(16, Math.min(w, meta.width - x));
  h = Math.max(16, Math.min(h, meta.height - y));
  return { x, y, w, h };
}

async function renderCrop(filePath, rect, { quality = 85 } = {}) {
  const meta = await imageMeta(filePath);
  const r = clampRect(rect, meta);
  return sharp(filePath).extract({ left: r.x, top: r.y, width: r.w, height: r.h }).jpeg({ quality, mozjpeg: true }).toBuffer();
}

/** Square face crop (reference faces): rect clamp → shorter side → resize size×size JPEG */
async function renderSquare(filePath, rect, size = 256, { quality = 90 } = {}) {
  const meta = await imageMeta(filePath);
  const r = clampRect(rect, meta);
  const side = Math.min(r.w, r.h);
  const sq = { x: Math.min(r.x, meta.width - side), y: Math.min(r.y, meta.height - side), w: side, h: side };
  const buffer = await sharp(filePath).extract({ left: sq.x, top: sq.y, width: side, height: side }).resize(size, size).jpeg({ quality, mozjpeg: true }).toBuffer();
  return { rect: sq, buffer };
}

/**
 * Gemini ka face box → source-pixel square rect (margin ke saath).
 * fb = { image: n (1-based), part: p (1-based), box: [ymin, xmin, ymax, xmax] in 0-1000 of THAT part }
 * layouts = gemini.js ke imageLayouts: { scale, width, slices: [{ top, height }] } (resized coords)
 */
function faceRectFromBox(fb, layouts, { margin = 0.3 } = {}) {
  if (!fb || typeof fb !== 'object') return null;
  const i = parseInt(fb.image, 10) - 1;
  const L = Array.isArray(layouts) ? layouts[i] : null;
  if (!L || !L.slices || !L.slices.length) return null;
  const p = Math.max(1, parseInt(fb.part, 10) || 1);
  const sl = L.slices[p - 1];
  if (!sl) return null;
  const b = Array.isArray(fb.box) ? fb.box.map(Number) : [];
  if (b.length !== 4 || b.some((v) => !Number.isFinite(v))) return null;
  const [y0, x0, y1, x1] = b;
  if (y1 <= y0 || x1 <= x0 || x0 < 0 || y0 < 0 || x1 > 1000 || y1 > 1000) return null;
  const bw = (x1 - x0) / 1000, bh = (y1 - y0) / 1000;
  if (bw < 0.04 || bh < 0.015 || bw > 0.9 || bh > 0.7) return null; // sliver ya poora panel = face nahi
  const k = 1 / (L.scale || 1); // resized → source px
  const x = (x0 / 1000) * L.width * k, y = (sl.top + (y0 / 1000) * sl.height) * k;
  const w = bw * L.width * k, h = bh * sl.height * k;
  const side = Math.max(w, h) * (1 + margin);
  return { imageIndex: i, x: Math.round(x + w / 2 - side / 2), y: Math.round(y + h / 2 - side / 2), w: Math.round(side), h: Math.round(side) };
}

/** 01a, 01b … (image 1-based index + letter in y-order) */
function cropName(imageIndex, k) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const suffix = k < 26 ? letters[k] : letters[Math.floor(k / 26) - 1] + letters[k % 26];
  return String(imageIndex).padStart(2, '0') + suffix;
}

/** Saved crops ko normalise karo: array of rects, y-order, clamp */
function normaliseCrops(list, meta) {
  if (!Array.isArray(list)) return [];
  return list.map((r) => clampRect(r || {}, meta)).sort((a, b) => a.y - b.y).slice(0, 26);
}

function budgetFor(meta, percent) {
  return Math.floor(meta.height * (Math.min(100, Math.max(10, Number(percent) || 40)) / 100));
}

module.exports = { imageMeta, detectPanels, renderCrop, renderSquare, faceRectFromBox, clampRect, cropName, normaliseCrops, budgetFor };
