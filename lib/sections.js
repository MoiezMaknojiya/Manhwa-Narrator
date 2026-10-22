// Narration script ko "--- [IMAGE n] ---" markers par sections mein todta hai.
// Har section = kaunsi images (from..to) + bolne wala text. Har section ki apni alag voice clip banti hai.

const { canonicalizeNamesInText } = require('./names');

const MARKER_RE = /^\s*-{2,}\s*\[\s*IMAGES?\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*\]\s*-{2,}\s*$/i;
const LABEL_LINE_RE = /^\s*"([^"\n]{3,120})"\s*:\s*(\S.*)$/;

/**
 * Double attribution theek karo — KOI lafz giraye baghair. Gemini kabhi narration line colon par
 * khatam karta hai ("Sin Ji-hyeok maze lete hue aage badhta hai:") aur foran baad label wali line
 * deta hai ("Sin Ji-hyeok taana maarte hue kehta hai": baat) — naam/bolne wala do baar aata hai.
 *  - lead-in poora jumla ban jaata hai (":" → ".") — scene ki baat bachi rehti hai
 *  - label poora rehta hai (andaaz "taana maarte hue" = TTS ka emotion), sirf shuru ka NAAM hat jaata hai
 *    jab wahi naam lead-in mein pehle se ho → "Taana maarte hue kehta hai": baat
 */
function mergeLeadIns(text) {
  const lines = (text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.endsWith(':') && !t.startsWith('"') && !MARKER_RE.test(t)) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const m = j < lines.length ? lines[j].match(LABEL_LINE_RE) : null;
      if (m) {
        const lead = t.slice(0, -1).trim();
        out.push(lead + (/[.!?…]$/.test(lead) ? '' : '.'));
        out.push('');
        out.push(`"${stripKnownName(m[1], lead)}": ${m[2].trim()}`);
        i = j;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

const LEAD_TITLES = new Set(['chhota', 'chhoti', 'chota', 'choti', 'bada', 'badi', 'boodha', 'boodhi', 'nanha', 'nanhi', 'young', 'master', 'elder', 'lord', 'lady', 'old', 'little']);
/**
 * Label ke shuru ka naam (Capitalized words ka run, e.g. "Chhota Hyeon", "Sin Ji-hyeok") hatao agar lead-in mein
 * WAHI POORA naam (contiguous) maujood hai. Sirf ek lafz milna kaafi nahi ("Namgung Muryong" vs lead "Namgung Yeongryeong" → kuch nahi hat-ta).
 * Shuru ke title words ("Chhota") naam ka hissa nahi — "Chhota Hyeon" lead "Hyeon ke chehre…" se match karta hai.
 */
function stripKnownName(label, lead) {
  const words = label.trim().split(/\s+/);
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, '');
  let n = 0;
  while (n < words.length - 2 && /^\p{Lu}/u.test(words[n])) n++; // kam az kam 2 lafz (andaaz + verb) bachne chahiye
  if (!n) return label;
  let t = 0;
  while (t < n - 1 && LEAD_TITLES.has(norm(words[t]))) t++;
  const core = words.slice(t, n).map(norm).filter(Boolean);
  if (!core.length || core.some((w) => w.length < 3)) return label; // "Ji" jaise 2-letter fragments par kabhi nahi
  const leadNorm = ' ' + lead.toLowerCase().replace(/[^\p{L}\p{N}'\s-]/gu, ' ').replace(/\s+/g, ' ').trim() + ' ';
  if (!leadNorm.includes(' ' + core.join(' ') + ' ')) return label;
  const rest = words.slice(n).join(' ');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * Script text ko TTS ke liye saaf karo:
 * - markdown (**bold**, # headings) hatao
 * - `"Hyeon kehta hai": baat` → `Hyeon kehta hai: baat` (quotes awaaz mein ajeeb lagte hain)
 * - extra blank lines collapse, par paragraph breaks rakho (TTS wahan natural pause deta hai)
 * - roster diya ho: naam ki variant spelling / ALL-CAPS → roster spelling, aur "say as" (pronounce) lagao —
 *   taake har clip mein har naam ek hi tarah bola jaye
 */
function toSpeakText(raw, roster) {
  let text = mergeLeadIns(raw)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^\s*"([^"\n]{3,120})"\s*:\s*/gm, '$1: ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (roster && roster.length) {
    text = canonicalizeNamesInText(text, roster);
    for (const c of roster) {
      if (!c.pronounce || !c.name) continue;
      const re = new RegExp(`(^|[^\\p{L}])${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}])`, 'gu');
      text = text.replace(re, `$1${c.pronounce}`);
    }
  }
  return text;
}

/**
 * @param {string} narration  poora script
 * @param {number} imageCount chapter mein kitni images hain
 * @param {{roster?: object[]}} [opts] roster → speakText mein naam ki spelling/pronounce normalise
 * @returns {{ sections: Section[], warnings: string[] }}
 *   Section = { idx, from, to, text, speakText, chars }
 *   from/to 1-based image numbers (inclusive). Har image exactly ek section mein aati hai
 *   (gaps pichhle section mein merge, overlap pehle wale ko milta hai).
 */
function parseSections(narration, imageCount, { roster } = {}) {
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
    const s = { idx: 0, from: 1, to: Math.max(1, imageCount), text, speakText: toSpeakText(text, roster) };
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
    s.speakText = toSpeakText(s.text, roster);
    s.chars = s.speakText.length;
  });
  return { sections, warnings };
}

module.exports = { parseSections, toSpeakText, mergeLeadIns, MARKER_RE };
