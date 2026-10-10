// Video assembly — ffmpeg (bundled via ffmpeg-static) + sharp.
// Har section: images (from..to) ko ek lambi strip mein jod kar, narration ki duration ke hisaab se
// scroll/excerpt karte hain, blurred background ke upar. Phir clips concat + voiceover mux.
//
// Policy-driven defaults (POLICY.md dekho):
//  * coveragePercent < 100 → "excerpt" mode: strip ke sirf chune hue windows dikhte hain,
//    aur poore CHAPTER ka total dikhaya hua hissa coverage budget ke andar rakha jaata hai
//    (WEBTOON fan-video rule: episode ka max 50%). Poora page sequence kabhi nahi.
//  * Koi music nahi — sirf voiceover. Music sirf YouTube Audio Library se, editor mein add karo.
//  * End card: official source credit.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const ffmpegPath = require('ffmpeg-static');
const { buildSrt } = require('./sections');

const PRESETS = {
  landscape: { W: 1920, H: 1080, stripW: 820 },  // 16:9 — strip beech mein, blurred bg
  portrait: { W: 1080, H: 1920, stripW: 1080 },  // 9:16 — Shorts/Reels, full width
};
const MAX_STRIP_HEIGHT = 28000; // sharp/ffmpeg memory ke liye cap

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-nostats', '-y', ...args]);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve();
      const tail = err.split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join(' | ');
      reject(new Error('ffmpeg failed: ' + tail));
    });
  });
}

const fx = (n) => Number(n).toFixed(3);

// ---------- Strip (images stacked vertically) ----------
async function buildStrip({ imagePaths, stripW, trimTop = 0, trimBottom = 0, outPath }) {
  const pieces = [];
  for (let i = 0; i < imagePaths.length; i++) {
    let img = sharp(imagePaths[i]).rotate();
    const meta = await img.metadata();
    if (!meta.width || !meta.height) throw new Error('Unreadable image: ' + path.basename(imagePaths[i]));
    let top = 0, height = meta.height;
    if (i === 0 && trimTop > 0 && trimTop < meta.height - 50) { top = trimTop; height -= trimTop; }
    if (i === imagePaths.length - 1 && trimBottom > 0 && trimBottom < height - 50) height -= trimBottom;
    if (top || height !== meta.height) img = img.extract({ left: 0, top, width: meta.width, height });
    const buf = await img.resize({ width: stripW }).jpeg({ quality: 90 }).toBuffer();
    const m2 = await sharp(buf).metadata();
    pieces.push({ buf, h: m2.height });
  }
  let totalH = pieces.reduce((a, p) => a + p.h, 0);
  let scale = 1;
  if (totalH > MAX_STRIP_HEIGHT) scale = MAX_STRIP_HEIGHT / totalH;
  const W = Math.max(16, Math.round(stripW * scale));
  if (scale < 1) {
    for (const p of pieces) {
      p.buf = await sharp(p.buf).resize({ width: W }).jpeg({ quality: 90 }).toBuffer();
      p.h = (await sharp(p.buf).metadata()).height;
    }
    totalH = pieces.reduce((a, p) => a + p.h, 0);
  }
  let y = 0;
  const composite = pieces.map((p) => { const c = { input: p.buf, top: y, left: 0 }; y += p.h; return c; });
  await sharp({ create: { width: W, height: totalH, channels: 3, background: '#000' } })
    .composite(composite).jpeg({ quality: 90 }).toFile(outPath);
  return { width: W, height: totalH };
}

// ---------- Background (blurred, dark) ----------
async function buildBackground({ stripPath, stripW, stripH, W, H, outPath }) {
  const regionH = Math.min(stripH, Math.max(64, Math.round(stripW * (H / W))));
  const top = Math.max(0, Math.round((stripH - regionH) / 2));
  await sharp(stripPath)
    .extract({ left: 0, top, width: stripW, height: regionH })
    .resize({ width: Math.round(W / 4), height: Math.round(H / 4), fit: 'cover' })
    .blur(12)
    .modulate({ brightness: 0.42, saturation: 0.85 })
    .resize({ width: W, height: H, fit: 'fill' })
    .jpeg({ quality: 80 })
    .toFile(outPath);
}

// ---------- Text overlays (sharp SVG → PNG; drawtext/font path ka jhanjhat nahi) ----------
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function buildWatermark({ text, outPath }) {
  if (!text || !text.trim()) return null;
  const fontSize = 30;
  const w = Math.min(900, Math.round(text.length * fontSize * 0.62) + 40), h = 56;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <text x="${w - 12}" y="40" text-anchor="end" font-family="Inter, Segoe UI, Arial, sans-serif" font-weight="700" font-size="${fontSize}"
      fill="#ffffff" fill-opacity="0.72" stroke="#000" stroke-opacity="0.5" stroke-width="1.2">${esc(text)}</text></svg>`;
  try {
    await sharp(Buffer.from(svg)).png().toFile(outPath);
    return outPath;
  } catch (e) {
    console.warn('  watermark skipped:', e.message);
    return null;
  }
}

async function buildEndCard({ W, H, lines, outPath }) {
  const fs1 = Math.round(H * 0.052), fs2 = Math.round(H * 0.034), fs3 = Math.round(H * 0.026);
  const cy = Math.round(H * 0.42);
  const [l1, l2, l3, l4] = lines.map(esc);
  const font = 'Inter, Segoe UI, Arial, sans-serif';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="100%" height="100%" fill="#0b0d12"/>
    <text x="50%" y="${cy}" text-anchor="middle" font-family="${font}" font-weight="800" font-size="${fs1}" fill="#eceef6">${l1 || ''}</text>
    <text x="50%" y="${cy + fs1 * 1.5}" text-anchor="middle" font-family="${font}" font-weight="600" font-size="${fs2}" fill="#a855f7">${l2 || ''}</text>
    <text x="50%" y="${cy + fs1 * 1.5 + fs2 * 1.7}" text-anchor="middle" font-family="${font}" font-size="${fs3}" fill="#8b93ad">${l3 || ''}</text>
    <text x="50%" y="${cy + fs1 * 1.5 + fs2 * 1.7 + fs3 * 1.8}" text-anchor="middle" font-family="${font}" font-size="${fs3}" fill="#8b93ad">${l4 || ''}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(outPath);
  return outPath;
}

// ---------- Motion plan ----------
const driftFor = (stripH, H, M) => Math.min(Math.round(H * 0.1), Math.max(0, Math.round((stripH - H) / Math.max(1, M))));
/** Ek section mein M windows dikhane par strip ka kitna px screen par aata hai */
function shownPxFor(stripH, H, M) {
  if (stripH <= H) return stripH;
  return Math.min(stripH, M * H + M * driftFor(stripH, H, M));
}

/**
 * Poore chapter ke liye windows plan: har section ko M windows, aur total dikhaya hua px
 * coverage budget (coverage% × total strip px) ke andar. Lambi strips pehle kam hoti hain.
 * @returns {number[]} har section ke liye M (0 = full scroll mode)
 */
function planWindows(stripHeights, H, coveragePercent) {
  if (coveragePercent >= 100) return stripHeights.map(() => 0);
  const cov = coveragePercent / 100;
  const M = stripHeights.map((h) => (h <= H ? 1 : Math.max(1, Math.floor((h / H) * cov))));
  const budget = cov * stripHeights.reduce((a, h) => a + h, 0);
  for (let guard = 0; guard < 500; guard++) {
    const total = stripHeights.reduce((a, h, i) => a + shownPxFor(h, H, M[i]), 0);
    if (total <= budget) break;
    let pick = -1;
    for (let i = 0; i < M.length; i++) {
      if (M[i] <= 1) continue;
      if (pick === -1 || M[i] > M[pick] || (M[i] === M[pick] && stripHeights[i] > stripHeights[pick])) pick = i;
    }
    if (pick === -1) break; // sab 1 window par hain — isse kam nahi ho sakta
    M[pick]--;
  }
  return M;
}

/**
 * Strip ke liye crop-y expression (ffmpeg expr, `t` seconds mein).
 *  - scroll mode (windows=0 / coverage 100): hold → linear scroll top→bottom → hold
 *  - excerpt mode: M windows evenly spaced, har window par halki si drift (Ken Burns feel).
 *    Baqi strip kabhi screen par nahi aati.
 * @returns {{ expr: string, shownPx: number, windows: number }}
 */
function motionPlan({ stripH, H, durationSec, holdSec, coveragePercent, windows }) {
  const D = Math.max(0.5, durationSec);
  const maxY = Math.max(0, stripH - H);
  if (maxY === 0) return { expr: '0', shownPx: stripH, windows: 1 };
  const hold = Math.min(holdSec, D / 4);
  const scrollMode = windows === 0 || (windows === undefined && coveragePercent >= 100);
  if (scrollMode) {
    const expr = `${maxY}*clip((t-${fx(hold)})/${fx(Math.max(0.1, D - 2 * hold))},0,1)`;
    return { expr, shownPx: stripH, windows: 0 };
  }
  const M = windows || Math.max(1, Math.floor((stripH / H) * coveragePercent / 100));
  const ys = [];
  for (let i = 0; i < M; i++) ys.push(M === 1 ? Math.round(maxY / 2) : Math.round((maxY * i) / (M - 1)));
  const seg = D / M;
  const drift = driftFor(stripH, H, M);
  let expr = '';
  for (let i = M - 1; i >= 0; i--) {
    const y0 = Math.max(0, Math.min(ys[i], maxY - drift));
    const piece = `${y0}+${drift}*clip((t-${fx(i * seg)})/${fx(seg)},0,1)`;
    expr = i === M - 1 ? piece : `if(lt(t,${fx((i + 1) * seg)}),${piece},${expr})`;
  }
  return { expr, shownPx: shownPxFor(stripH, H, M), windows: M };
}

// ---------- Per-section clip ----------
async function renderSectionClip({ bgPath, stripPath, stripW, stripH, W, H, fps, crf, durationSec, holdSec, coveragePercent, windows, watermarkPng, outPath }) {
  const plan = motionPlan({ stripH, H, durationSec, holdSec, coveragePercent, windows });
  const cropH = Math.min(stripH, H);
  const inputs = ['-loop', '1', '-framerate', String(fps), '-i', bgPath, '-loop', '1', '-framerate', String(fps), '-i', stripPath];
  let filter = `[1:v]crop=w=${stripW}:h=${cropH}:x=0:y='${plan.expr}'[fg];` +
    `[0:v][fg]overlay=x=(W-w)/2:y=(H-h)/2:format=auto[v0]`;
  let last = 'v0';
  if (watermarkPng) {
    inputs.push('-loop', '1', '-framerate', String(fps), '-i', watermarkPng);
    filter += ';[v0][2:v]overlay=x=W-w-28:y=H-h-24[v1]';
    last = 'v1';
  }
  filter += `;[${last}]format=yuv420p[v]`;
  await runFfmpeg([
    ...inputs, '-filter_complex', filter, '-map', '[v]',
    '-t', fx(durationSec), '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-an', outPath,
  ]);
  return plan;
}

async function renderStillClip({ imagePath, fps, crf, durationSec, outPath, fadeIn = 0.6 }) {
  await runFfmpeg([
    '-loop', '1', '-framerate', String(fps), '-i', imagePath,
    '-vf', `fade=t=in:st=0:d=${fx(fadeIn)},format=yuv420p`, '-t', fx(durationSec), '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-an', outPath,
  ]);
}

async function concatClips(clips, outPath) {
  const list = outPath + '.txt';
  const lines = clips.map((c) => "file '" + c.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'");
  fs.writeFileSync(list, lines.join('\n'));
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outPath]);
}

async function muxAudio({ videoPath, wavPath, outPath }) {
  await runFfmpeg([
    '-i', videoPath, '-i', wavPath, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-af', 'apad', '-shortest',
    '-movflags', '+faststart', outPath,
  ]);
}

// ---------- Main ----------
/**
 * @param {object} o
 * @param {string[]} o.imagePaths  chapter ki images (sorted)
 * @param {Array}   o.sections    [{ idx, from, to, startSec, durationSec, speakText }]
 * @param {string}  o.voiceoverWav
 * @param {string}  o.outDir
 * @param {object}  o.settings    { videoPreset, videoFps, videoQuality, channelName, trimFirstTop, trimLastBottom, holdSec, coveragePercent }
 * @param {object}  o.credits     { title, platform, url, author }
 * @param {function} [o.onProgress]
 */
async function renderChapterVideo({ imagePaths, sections, voiceoverWav, outDir, settings, credits, onProgress }) {
  const preset = PRESETS[settings.videoPreset] || PRESETS.landscape;
  const { W, H, stripW } = preset;
  const fps = settings.videoFps || 30, crf = settings.videoQuality || 22;
  const holdSec = settings.holdSec ?? 0.4;
  const coveragePercent = settings.coveragePercent ?? 50;
  const work = path.join(outDir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const total = sections.length * 2 + 4;
  let step = 0;
  const progress = (msg) => onProgress && onProgress(step, total, msg);

  const watermarkPng = await buildWatermark({ text: settings.channelName, outPath: path.join(work, 'watermark.png') });

  // Phase 1 — strips + backgrounds
  const prepared = [];
  for (const s of sections) {
    const imgs = imagePaths.slice(s.from - 1, s.to);
    if (!imgs.length) continue;
    step++; progress(`Preparing images for section ${s.idx + 1}/${sections.length} (images ${s.from}-${s.to})`);
    const stripPath = path.join(work, `strip-${s.idx}.jpg`);
    const trimTop = s.from === 1 ? settings.trimFirstTop || 0 : 0;
    const trimBottom = s.to === imagePaths.length ? settings.trimLastBottom || 0 : 0;
    const strip = await buildStrip({ imagePaths: imgs, stripW, trimTop, trimBottom, outPath: stripPath });
    const bgPath = path.join(work, `bg-${s.idx}.jpg`);
    await buildBackground({ stripPath, stripW: strip.width, stripH: strip.height, W, H, outPath: bgPath });
    prepared.push({ s, stripPath, bgPath, strip });
  }
  if (!prepared.length) throw new Error('No sections could be rendered.');

  // Phase 2 — chapter-level coverage plan
  const windows = planWindows(prepared.map((p) => p.strip.height), H, coveragePercent);

  // Phase 3 — clips
  const clips = [];
  const sectionReport = [];
  let shownPx = 0, totalPx = 0;
  for (let i = 0; i < prepared.length; i++) {
    const { s, stripPath, bgPath, strip } = prepared[i];
    step++; progress(`Rendering section ${s.idx + 1}/${sections.length} (${s.durationSec.toFixed(1)}s)`);
    const clipPath = path.join(work, `clip-${String(s.idx).padStart(3, '0')}.mp4`);
    const plan = await renderSectionClip({
      bgPath, stripPath, stripW: strip.width, stripH: strip.height, W, H, fps, crf,
      durationSec: s.durationSec, holdSec, coveragePercent, windows: windows[i], watermarkPng, outPath: clipPath,
    });
    clips.push(clipPath);
    shownPx += plan.shownPx;
    totalPx += strip.height;
    sectionReport.push({
      idx: s.idx, from: s.from, to: s.to, startSec: s.startSec, durationSec: s.durationSec,
      stripHeight: strip.height, shownPercent: Math.round((plan.shownPx / strip.height) * 100), windows: plan.windows,
    });
  }

  // End card — official source credit (4s)
  step++; progress('Rendering end card…');
  const endSec = 4;
  const endLines = [
    credits.title || '',
    credits.platform ? `Read the full chapter on ${credits.platform}` : 'Support the official release',
    credits.url || '',
    credits.author ? `© ${credits.author}` : '',
  ];
  const endImg = await buildEndCard({ W, H, lines: endLines, outPath: path.join(work, 'endcard.jpg') });
  const endClip = path.join(work, 'clip-end.mp4');
  await renderStillClip({ imagePath: endImg, fps, crf, durationSec: endSec, outPath: endClip });
  clips.push(endClip);

  step++; progress('Joining clips…');
  const silent = path.join(work, 'video-silent.mp4');
  await concatClips(clips, silent);

  step++; progress('Adding voiceover…');
  const videoPath = path.join(outDir, 'video.mp4');
  await muxAudio({ videoPath: silent, wavPath: voiceoverWav, outPath: videoPath });

  step++; progress('Writing captions…');
  const srtPath = path.join(outDir, 'captions.srt');
  fs.writeFileSync(srtPath, buildSrt(sections));

  const durationSec = sections.reduce((a, s) => a + s.durationSec, 0) + endSec;
  const shownPercent = totalPx ? Math.round((shownPx / totalPx) * 100) : 0;
  step = total; progress('Video ready');
  return {
    videoPath, srtPath, durationSec, preset: settings.videoPreset, W, H, fps, coveragePercent,
    shownPercent, avgShownPercent: shownPercent, sections: sectionReport,
  };
}

module.exports = { renderChapterVideo, motionPlan, planWindows, shownPxFor, buildStrip, buildBackground, PRESETS };
