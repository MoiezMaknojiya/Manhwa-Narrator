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

module.exports = { imageMeta, detectPanels, renderCrop, renderSquare, clampRect, cropName, normaliseCrops, budgetFor };
