// Voiceover — Gemini TTS (Interactions API, REST). Script sections → chunks → WAV → per-section timing.
//  * Style alag field (speech_metadata.style) mein jaata hai, isliye awaaz mein nahi padha jaata.
//  * Sections ke beech <long pause> tag → saaf silence → boundary detection asaan.
//  * Har chunk cache hota hai (hash of model+voice+style+text): script ka ek hissa badlo,
//    sirf wahi chunk dobara banta hai — baqi quota bachta hai.
//  * SKIP GUARD: LLM-TTS kabhi kabhi poore paragraphs chhod deta hai (test mein 2 sections gayab the).
//    Har chunk ki bolne ki raftaar (chars/sec) check hoti hai — bohot tez = text skip hua →
//    pehle wahi chunk dobara, phir bhi short ho toh us chunk ke sections ek-ek karke.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { withKeys } = require('./keyring');

const TTS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const SECTION_PAUSE = '<long pause>';
const PAUSE_GUESS_SEC = 1.0; // <long pause> lagbhag itna silence deta hai
const MAX_SECTIONS_PER_CHUNK = 4; // zyada sections ek request mein = skip ka khatra zyada
const RATE_MAX = 24;  // chars/sec — Roman Urdu narration ~14-20; isse tez = kuch chhoda gaya
const RATE_MIN = 5;   // isse dheema = ajeeb output (lambi khamoshi)
const SPLIT_GAP_SEC = 0.9; // per-section mode mein sections ke beech silence

// Google ke 30 prebuilt voices (docs: ai.google.dev/gemini-api/docs/speech-generation)
const TTS_VOICES = [
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm'], ['Fenrir', 'Excitable'],
  ['Leda', 'Youthful'], ['Orus', 'Firm'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'],
  ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'], ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'],
  ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'], ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'],
  ['Alnilam', 'Firm'], ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'], ['Achird', 'Friendly'],
  ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'], ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
].map(([name, tone]) => ({ name, tone }));

// ---------- WAV helpers ----------
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('TTS did not return a WAV file');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') { data = { offset: off + 8, length: Math.min(size, buf.length - off - 8) }; break; }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('Malformed WAV from TTS');
  const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
  return { ...fmt, dataOffset: data.offset, dataLength: data.length, durationSec: data.length / bytesPerSec, bytesPerSec };
}

function wavHeader(dataLength, { sampleRate = 24000, channels = 1, bits = 16 } = {}) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLength, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  h.writeUInt16LE(channels * (bits / 8), 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(dataLength, 40);
  return h;
}

const pcmOf = (buf, info) => buf.subarray(info.dataOffset, info.dataOffset + info.dataLength);
const silencePcm = (sec, info) => Buffer.alloc(Math.round(sec * info.bytesPerSec / 2) * 2);

// ---------- Gemini TTS request ----------
async function ttsRequest({ key, model, voice, style, text }) {
  const content = { type: 'text', text };
  if (style && style.trim()) content.annotations = [{ type: 'speech_metadata', style: style.trim() }];
  const body = {
    model,
    input: [{ type: 'user_input', content: [content] }],
    response_format: { type: 'audio', mime_type: 'audio/wav' },
    generation_config: { speech_config: [{ voice }] },
  };
  const res = await fetch(TTS_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || `HTTP ${res.status}`;
    const err = new Error(`${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  let audio = null;
  for (const step of json.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const c of step.content || []) if (c.type === 'audio' && c.data) audio = c;
  }
  if (!audio) throw new Error('TTS returned no audio — try another voice/model.');
  const buf = Buffer.from(audio.data, 'base64');
  const usage = json.usage || {};
  return {
    wav: buf,
    mimeType: audio.mime_type,
    usage: { promptTokens: usage.total_input_tokens || 0, candidateTokens: usage.total_output_tokens || 0, totalTokens: usage.total_tokens || 0 },
  };
}

// ---------- Chunking ----------
function chunkSections(sections, maxChars, maxSections = MAX_SECTIONS_PER_CHUNK) {
  const chunks = [];
  let cur = null;
  for (const s of sections) {
    const len = s.speakText.length + SECTION_PAUSE.length + 2;
    if (!cur || cur.chars + len > maxChars || cur.sectionIdxs.length >= maxSections) {
      cur = { sectionIdxs: [], parts: [], chars: 0 };
      chunks.push(cur);
    }
    cur.sectionIdxs.push(s.idx);
    cur.parts.push(s.speakText);
    cur.chars += len;
  }
  for (const c of chunks) {
    c.text = c.parts.join(`\n\n${SECTION_PAUSE}\n\n`);
    c.textChars = c.parts.reduce((a, t) => a + t.length, 0);
  }
  return chunks;
}

// ---------- Silence detection (ffmpeg) ----------
function detectSilences(wavPath, { noiseDb = -35, minDur = 0.35 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-nostats', '-i', wavPath, '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`, '-f', 'null', '-']);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', () => {
      const out = [];
      const re = /silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g;
      let m;
      while ((m = re.exec(err))) {
        const start = parseFloat(m[1]), end = parseFloat(m[2]);
        out.push({ start, end, mid: (start + end) / 2, dur: end - start });
      }
      resolve(out);
    });
  });
}

/**
 * Ek chunk ke andar sections ki boundaries: characters ke hisaab se andaza, phir
 * qareeb-tareen silence par snap (window ke andar). Monotonic rakha jaata hai.
 */
function assignBoundaries(sectionChars, totalSec, silences) {
  const n = sectionChars.length;
  if (n === 1) return [0];
  const totalChars = sectionChars.reduce((a, b) => a + b, 0) || 1;
  const speechSec = Math.max(0.5, totalSec - (n - 1) * PAUSE_GUESS_SEC);
  const window = Math.max(1.5, totalSec * 0.08);
  const starts = [0];
  let cum = 0, prev = 0;
  const usable = silences.filter((s) => s.dur >= 0.45 && s.start > 0.3 && s.end < totalSec - 0.3);
  for (let k = 1; k < n; k++) {
    cum += sectionChars[k - 1];
    const est = (cum / totalChars) * speechSec + (k - 0.5) * PAUSE_GUESS_SEC;
    let best = null;
    for (const s of usable) {
      if (s.mid <= prev + 0.8) continue;
      const d = Math.abs(s.mid - est);
      if (d <= window && (!best || d < best.d)) best = { t: s.end - 0.15, d }; // silence ke aakhir ke qareeb — agla section wahan se bolta hai
    }
    const t = best ? Math.max(prev + 0.8, best.t) : Math.max(prev + 0.8, est);
    starts.push(Math.min(t, totalSec - 0.5 * (n - k)));
    prev = starts[k];
  }
  return starts;
}

// ---------- Skip guard ----------
const rateOf = (chars, sec) => (sec > 0 ? chars / sec : Infinity);
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
/** true = audio text ke hisaab se bohot chhota (ya ajeeb lamba) hai */
function isSuspect(chars, sec, refRate) {
  const r = rateOf(chars, sec);
  if (r > RATE_MAX || r < RATE_MIN) return true;
  if (refRate && r > refRate * 1.3) return true;
  return false;
}

// ---------- Main ----------
function chunkHash({ model, voice, style, text }) {
  return crypto.createHash('sha1').update([model, voice, style || '', text].join('\u0001')).digest('hex').slice(0, 16);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-nostats', '-y', ...args]);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.split('\n').filter(Boolean).slice(-3).join(' | ')))));
  });
}

/**
 * @returns {Promise<{ sections: {idx,startSec,durationSec,chars}[], totalSec, voiceoverWav, voiceoverMp3,
 *                     chunks: {hash,file,durationSec,sectionIdxs,cached,split,retried}[], usedKeyIndex, tokenUsage, requests, warnings }>}
 */
async function synthesizeChapter({ keys, activeKeyIndex, model, voice, style, maxChars, sections, outDir, onProgress, onAttempt }) {
  if (!sections.length) throw new Error('Nothing to narrate — script has no sections.');
  const chunksDir = path.join(outDir, 'chunks');
  fs.mkdirSync(chunksDir, { recursive: true });
  const chunks = chunkSections(sections, maxChars);
  const total = chunks.length + 2;
  const progress = (i, msg) => onProgress && onProgress(i, total, msg);

  let keyIndex = activeKeyIndex;
  let requests = 0;
  const tokenUsage = { promptTokens: 0, candidateTokens: 0, totalTokens: 0 };
  const sectionById = Object.fromEntries(sections.map((s) => [s.idx, s]));
  const timeline = []; // { idx, startSec, durationSec }
  const warnings = [];
  const acceptedRates = [];
  let cursor = 0;
  const pcmParts = [];
  let fmt = null;

  const requestWav = async (text) => {
    const { result, usedKeyIndex } = await withKeys(
      { keys, activeKeyIndex: keyIndex, onAttempt: (idx, label) => { requests++; if (onAttempt) onAttempt(idx, label); }, what: 'voiceover' },
      (key) => ttsRequest({ key, model, voice, style, text })
    );
    keyIndex = usedKeyIndex;
    for (const k of Object.keys(tokenUsage)) tokenUsage[k] += result.usage[k] || 0;
    return result.wav;
  };

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    c.hash = chunkHash({ model, voice, style, text: c.text });
    c.file = path.join(chunksDir, `${c.hash}.wav`);
    c.metaFile = path.join(chunksDir, `${c.hash}.json`);
    c.cached = fs.existsSync(c.file) && fs.statSync(c.file).size > 1000;
    const first = c.sectionIdxs[0] + 1, last = c.sectionIdxs[c.sectionIdxs.length - 1] + 1;
    const label = c.sectionIdxs.length > 1 ? `sections ${first}-${last}` : `section ${first}`;
    progress(i, `Voiceover chunk ${i + 1}/${chunks.length}${c.cached ? ' (cached)' : ''} — ${label}`);
    const refRate = median(acceptedRates);

    let wav, info, meta = null;
    if (c.cached) {
      wav = fs.readFileSync(c.file);
      info = parseWav(wav);
      try { meta = JSON.parse(fs.readFileSync(c.metaFile, 'utf8')); } catch { meta = null; }
      if (!meta && isSuspect(c.textChars, info.durationSec, refRate)) { c.cached = false; } // purana suspect cache — dobara banao
    }
    if (!c.cached) {
      wav = await requestWav(c.text);
      info = parseWav(wav);
      meta = null;
      if (isSuspect(c.textChars, info.durationSec, refRate)) {
        const r1 = rateOf(c.textChars, info.durationSec).toFixed(1);
        progress(i, `Chunk ${i + 1} sounds too short (${r1} chars/s) — TTS may have skipped text, retrying…`);
        console.log(`  ⚠️ voiceover: chunk ${i + 1} suspect (${r1} chars/s) — retrying`);
        const wav2 = await requestWav(c.text);
        const info2 = parseWav(wav2);
        if (info2.durationSec > info.durationSec) { wav = wav2; info = info2; }
        c.retried = true;
      }
      if (isSuspect(c.textChars, info.durationSec, refRate) && c.sectionIdxs.length > 1) {
        // Chunk abhi bhi short — sections ek-ek karke (timing phir EXACT hoti hai)
        progress(i, `Chunk ${i + 1} still short — generating its ${c.sectionIdxs.length} sections one by one…`);
        console.log(`  ⚠️ voiceover: chunk ${i + 1} still suspect — splitting per section`);
        const parts = [];
        let fmtLocal = null;
        for (const idx of c.sectionIdxs) {
          const text = sectionById[idx].speakText;
          let w = await requestWav(text);
          let inf = parseWav(w);
          if (isSuspect(text.length, inf.durationSec, refRate)) {
            const w2 = await requestWav(text);
            const inf2 = parseWav(w2);
            if (inf2.durationSec > inf.durationSec) { w = w2; inf = inf2; }
            if (isSuspect(text.length, inf.durationSec, refRate))
              warnings.push(`Section ${idx + 1} may still have skipped text (${rateOf(text.length, inf.durationSec).toFixed(1)} chars/s) — listen and check.`);
          }
          fmtLocal = fmtLocal || inf;
          parts.push({ idx, pcm: pcmOf(w, inf), durationSec: inf.durationSec });
        }
        const gap = silencePcm(SPLIT_GAP_SEC, fmtLocal);
        const pcmAll = [];
        const starts = [];
        let t = 0;
        parts.forEach((p, k) => {
          if (k > 0) { pcmAll.push(gap); t += SPLIT_GAP_SEC; }
          starts.push(t);
          pcmAll.push(p.pcm);
          t += p.durationSec;
        });
        const pcm = Buffer.concat(pcmAll);
        wav = Buffer.concat([wavHeader(pcm.length, fmtLocal), pcm]);
        info = parseWav(wav);
        meta = { split: true, starts };
        c.split = true;
        warnings.push(`Chunk ${i + 1} (${label}) was regenerated section-by-section because the first take skipped text.`);
      } else if (c.retried && isSuspect(c.textChars, info.durationSec, refRate)) {
        warnings.push(`Section ${first} may have skipped text (${rateOf(c.textChars, info.durationSec).toFixed(1)} chars/s) — listen and check.`);
      }
      fs.writeFileSync(c.file, wav);
      if (meta) fs.writeFileSync(c.metaFile, JSON.stringify(meta)); else fs.rmSync(c.metaFile, { force: true });
    }

    if (!fmt) fmt = { sampleRate: info.sampleRate, channels: info.channels, bits: info.bits };
    if (info.sampleRate !== fmt.sampleRate || info.channels !== fmt.channels || info.bits !== fmt.bits)
      throw new Error('TTS chunks have different audio formats — clear the output folder and retry.');
    pcmParts.push(pcmOf(wav, info));
    c.durationSec = info.durationSec;
    if (!isSuspect(c.textChars, info.durationSec, refRate)) acceptedRates.push(rateOf(c.textChars, info.durationSec));

    const chars = c.sectionIdxs.map((idx) => sectionById[idx].speakText.length);
    let starts;
    if (meta && meta.split && Array.isArray(meta.starts) && meta.starts.length === c.sectionIdxs.length) {
      starts = meta.starts; // exact
    } else {
      const silences = c.sectionIdxs.length > 1 ? await detectSilences(c.file) : [];
      starts = assignBoundaries(chars, info.durationSec, silences);
    }
    c.sectionIdxs.forEach((idx, k) => {
      const end = k + 1 < starts.length ? starts[k + 1] : info.durationSec;
      timeline.push({ idx, startSec: cursor + starts[k], durationSec: end - starts[k], chars: chars[k] });
    });
    cursor += info.durationSec;
  }

  progress(chunks.length, 'Joining voiceover…');
  const pcm = Buffer.concat(pcmParts);
  const voiceoverWav = path.join(outDir, 'voiceover.wav');
  fs.writeFileSync(voiceoverWav, Buffer.concat([wavHeader(pcm.length, fmt), pcm]));
  const voiceoverMp3 = path.join(outDir, 'voiceover.mp3');
  progress(chunks.length + 1, 'Encoding MP3…');
  await runFfmpeg(['-i', voiceoverWav, '-codec:a', 'libmp3lame', '-q:a', '3', voiceoverMp3]);
  progress(total, 'Voiceover ready');

  return {
    sections: timeline,
    totalSec: cursor,
    voiceoverWav,
    voiceoverMp3,
    chunks: chunks.map((c) => ({
      hash: c.hash, file: path.basename(c.file), durationSec: c.durationSec, sectionIdxs: c.sectionIdxs,
      cached: !!c.cached, split: !!c.split, retried: !!c.retried,
    })),
    usedKeyIndex: keyIndex,
    tokenUsage,
    requests,
    warnings,
  };
}

module.exports = {
  synthesizeChapter, ttsRequest, chunkSections, assignBoundaries, detectSilences, parseWav, wavHeader, isSuspect,
  TTS_VOICES, SECTION_PAUSE, RATE_MAX,
};
