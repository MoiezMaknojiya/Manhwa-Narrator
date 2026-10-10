// Narration script ko "--- [IMAGE n] ---" markers par sections mein todta hai.
// Har section = kaunsi images (from..to) + bolne wala text. Video/TTS dono isi par chalte hain.

const MARKER_RE = /^\s*-{2,}\s*\[\s*IMAGES?\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*\]\s*-{2,}\s*$/i;

/**
 * Script text ko TTS ke liye saaf karo:
 * - markdown (**bold**, # headings) hatao
 * - `"Hyeon kehta hai": baat` → `Hyeon kehta hai: baat` (quotes awaaz mein ajeeb lagte hain)
 * - extra blank lines collapse, par paragraph breaks rakho (TTS wahan natural pause deta hai)
 */
function toSpeakText(raw) {
  return (raw || '')
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^\s*"([^"\n]{3,120})"\s*:\s*/gm, '$1: ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {string} narration  poora script
 * @param {number} imageCount chapter mein kitni images hain
 * @returns {{ sections: Section[], warnings: string[] }}
 *   Section = { idx, from, to, text, speakText, chars }
 *   from/to 1-based image numbers (inclusive). Har image exactly ek section mein aati hai
 *   (gaps pichhle section mein merge, overlap pehle wale ko milta hai).
 */
function parseSections(narration, imageCount) {
  const warnings = [];
  const lines = (narration || '').replace(/\r/g, '').split('\n');
  const raw = []; // { from, to, lines[] }
  const preamble = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(MARKER_RE);
    if (m) {
      const from = parseInt(m[1], 10);
      const to = m[2] ? parseInt(m[2], 10) : from;
      cur = { from: Math.min(from, to), to: Math.max(from, to), lines: [] };
      raw.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    } else {
      preamble.push(line);
    }
  }

  if (!raw.length) {
    // Koi marker nahi — poora script ek section, saari images
    const text = lines.join('\n').trim();
    if (!text) return { sections: [], warnings: ['Script is empty.'] };
    warnings.push('No --- [IMAGE n] --- markers found — whole script will play over all images.');
    const s = { idx: 0, from: 1, to: Math.max(1, imageCount), text, speakText: toSpeakText(text) };
    s.chars = s.speakText.length;
    return { sections: [s], warnings };
  }

  const pre = preamble.join('\n').trim();
  if (pre) raw[0].lines.unshift(pre, '');

  // Clamp to real images, drop sections that point beyond the images
  const sections = [];
  for (const r of raw) {
    let from = r.from, to = r.to;
    if (imageCount > 0) {
      if (from > imageCount) {
        warnings.push(`Marker [IMAGE ${from}] points past the last image (${imageCount}) — merged into previous section.`);
        if (sections.length) { sections[sections.length - 1].text += '\n\n' + r.lines.join('\n').trim(); continue; }
        from = imageCount;
      }
      to = Math.min(to, imageCount);
    }
    const text = r.lines.join('\n').trim();
    if (!text) { warnings.push(`[IMAGE ${from}] has no narration text — skipped.`); continue; }
    sections.push({ from, to, text });
  }
  if (!sections.length) return { sections: [], warnings: [...warnings, 'No usable sections.'] };

  // Image coverage: har image exactly ek section ko do (gaps → previous, overlaps → earlier wins)
  let nextFree = 1;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (s.to < nextFree) {
      // poora range pehle hi cover ho chuka — is section ko koi nayi image nahi milti; pichhli image par rehta hai
      warnings.push(`[IMAGES ${s.from}-${s.to}] repeats earlier images — it will replay image ${nextFree - 1}.`);
      s.from = s.to = Math.max(1, nextFree - 1);
      s.replay = true;
      continue;
    }
    if (s.from < nextFree) s.from = nextFree; // overlap trim
    if (s.from > nextFree) {
      // gap: pichhla section in images ko bhi dikhayega
      const prev = sections[i - 1];
      if (prev) {
        prev.to = s.from - 1;
        warnings.push(`Images ${nextFree}-${s.from - 1} have no marker — shown during the previous section.`);
      } else {
        s.from = nextFree;
      }
    }
    nextFree = s.to + 1;
  }
  if (imageCount > 0 && nextFree <= imageCount) {
    const last = sections[sections.length - 1];
    warnings.push(`Images ${nextFree}-${imageCount} have no marker — shown during the last section.`);
    last.to = imageCount;
  }

  sections.forEach((s, i) => {
    s.idx = i;
    s.speakText = toSpeakText(s.text);
    s.chars = s.speakText.length;
  });
  return { sections, warnings };
}

/** Sentence-wise split for SRT cues. */
function splitSentences(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+(?=[^a-z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toSrtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(x).padStart(3, '0')}`;
}

function wrapCue(text, max = 42) {
  if (text.length <= max) return text;
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > max && line) { lines.push(line); line = w; }
    else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  // SRT mein 2 lines se zyada achhi nahi lagti — zyada ho toh jod do
  if (lines.length > 2) return lines[0] + '\n' + lines.slice(1).join(' ');
  return lines.join('\n');
}

/**
 * sections: [{ speakText, startSec, durationSec }] → SRT text.
 * Har section ke andar sentences ko unke characters ke hisaab se time milta hai.
 */
function buildSrt(sections) {
  const cues = [];
  for (const s of sections) {
    const sentences = splitSentences(s.speakText);
    const total = sentences.reduce((a, t) => a + t.length, 0) || 1;
    // Chhote sentences ko jod do taake cue bohot chhota na ho
    const groups = [];
    let buf = '';
    for (const sent of sentences) {
      buf = buf ? buf + ' ' + sent : sent;
      if (buf.length >= 60) { groups.push(buf); buf = ''; }
    }
    if (buf) groups.push(buf);
    let t = s.startSec;
    for (const g of groups) {
      const d = (g.length / total) * s.durationSec;
      cues.push({ start: t, end: t + d, text: g });
      t += d;
    }
  }
  return cues
    .map((c, i) => `${i + 1}\n${toSrtTime(c.start)} --> ${toSrtTime(Math.max(c.start + 0.3, c.end - 0.05))}\n${wrapCue(c.text)}\n`)
    .join('\n');
}

module.exports = { parseSections, toSpeakText, buildSrt, splitSentences, MARKER_RE };
