// Voiceover — Gemini TTS (Interactions API, REST). Har image (script section) ki APNI alag MP3 file.
//  * Ek image = ek TTS request → har clip ka text exact wahi hai jo us image ka hai, koi cutting/guessing nahi.
//  * Har image ki apni voice ho sakti hai (section.voice) — warna Settings wali default voice.
//  * Style alag field (speech_metadata.style) mein jaata hai, isliye awaaz mein nahi padha jaata.
//  * Har clip cache hoti hai (hash of model+voice+style+temperature+language+text): ek image ka text ya voice badlo,
//    sirf wahi clip dobara banti hai. Quota beech mein khatam ho jaye toh bani hui clips saved rehti hain —
//    agle din "Generate" sirf baqi images banata hai. Sirf MP3 rakhi jaati hai (WAV encode ke baad delete).
//  * SKIP GUARD: LLM-TTS kabhi kabhi text chhod deta hai. Bolne ki raftaar (chars/sec) bohot tez ho toh
//    clip ek baar dobara banti hai (lambi wali rakhi jaati hai), phir bhi short ho toh warning.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { withKeys } = require('./keyring');

const TTS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const RATE_MAX = 24;  // chars/sec — Roman Urdu narration ~14-20; isse tez = kuch chhoda gaya
const RATE_MIN = 5;   // isse dheema = ajeeb output (lambi khamoshi)
const GUARD_MIN_CHARS = 120; // chhote text mein shuru/aakhir ki khamoshi rate bigaad deti hai — guard sirf lambe text par

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

// ---------- Gemini TTS request ----------
async function ttsRequest({ key, model, voice, style, text, temperature, language }) {
  const content = { type: 'text', text };
  if (style && style.trim()) content.annotations = [{ type: 'speech_metadata', style: style.trim() }];
  const speaker = { voice };
  if (language && String(language).trim()) speaker.language = String(language).trim(); // e.g. en-US, en-IN, hi-IN ('' = auto-detect)
  const generation_config = { speech_config: [speaker] };
  const temp = Number(temperature);
  if (temperature !== undefined && temperature !== null && temperature !== '' && Number.isFinite(temp)) generation_config.temperature = temp;
  const body = {
    model,
    input: [{ type: 'user_input', content: [content] }],
    response_format: { type: 'audio', mime_type: 'audio/wav' },
    generation_config,
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

// ---------- Skip guard ----------
const rateOf = (chars, sec) => (sec > 0 ? chars / sec : Infinity);
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
/** true = audio text ke hisaab se bohot chhota (ya ajeeb lamba) hai */
function isSuspect(chars, sec, refRate) {
  if (chars < GUARD_MIN_CHARS) return false;
  const r = rateOf(chars, sec);
  if (r > RATE_MAX || r < RATE_MIN) return true;
  if (refRate && r > refRate * 1.3) return true;
  return false;
}

// ---------- Clip files ----------
const pad2 = (n) => String(n).padStart(2, '0');
/** image-03.mp3, ya section do images ka ho toh image-03-04.mp3 */
const clipName = (s) => (s.from === s.to ? `image-${pad2(s.from)}` : `image-${pad2(s.from)}-${pad2(s.to)}`);

function clipHash({ model, voice, style, temperature, language, text }) {
  return crypto.createHash('sha1')
    .update([model, voice, style || '', String(temperature ?? ''), language || '', text].join('\u0001'))
    .digest('hex').slice(0, 16);
}

const clipsDir = (outDir) => path.join(outDir, 'clips');
function clipPaths(outDir, hash) {
  const dir = clipsDir(outDir);
  return { wav: path.join(dir, `${hash}.wav`), mp3: path.join(dir, `${hash}.mp3`), meta: path.join(dir, `${hash}.json`) };
}

/** Clip bani hui hai toh uska meta ({durationSec, chars, voice, retried, warning, createdAt}), warna null. */
function readClip(outDir, hash) {
  const p = clipPaths(outDir, hash);
  if (!fs.existsSync(p.mp3)) return null;
  try { return JSON.parse(fs.readFileSync(p.meta, 'utf8')); } catch { return null; }
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

// ---------- Main ----------
/**
 * Har section (image) ki alag clip. Bani hui clips cache se aati hain; `force` wale idx dobara bante hain.
 * @param {object} o
 * @param {{idx,from,to,speakText,chars,voice?}[]} o.sections  jin ki voice banani hai (section.voice = is image ki apni voice, warna o.voice)
 * @param {number[]} [o.force]  in sections ki nayi take (cache ignore)
 * @returns {Promise<{ clips: {idx,name,hash,durationSec,cached,retried,warning}[], usedKeyIndex, tokenUsage, requests, warnings }>}
 *   Quota beech mein khatam ho toh error throw hota hai jis par `err.partial = { usedKeyIndex, tokenUsage, requests }` hota hai.
 */
async function synthesizeImages({ keys, activeKeyIndex, model, voice, style, temperature, language, sections, outDir, force = [], onProgress, onAttempt }) {
  if (!sections.length) throw new Error('Nothing to narrate — script has no sections.');
  fs.mkdirSync(clipsDir(outDir), { recursive: true });
  const total = sections.length;
  const progress = (i, msg) => onProgress && onProgress(i, total, msg);
  const voiceOf = (s) => s.voice || voice;
  const settingsFor = (s) => ({ model, voice: voiceOf(s), style, temperature, language, text: s.speakText });

  let keyIndex = activeKeyIndex;
  let requests = 0;
  const tokenUsage = { promptTokens: 0, candidateTokens: 0, totalTokens: 0 };
  const warnings = [];
  const clips = [];

  // Pehle se bani clips ki raftaar = reference (skip guard ke liye)
  const acceptedRates = [];
  for (const s of sections) {
    const meta = readClip(outDir, clipHash(settingsFor(s)));
    if (meta && !meta.warning && meta.durationSec) acceptedRates.push(rateOf(s.chars, meta.durationSec));
  }

  const requestWav = async (text, clipVoice) => {
    const { result, usedKeyIndex } = await withKeys(
      { keys, activeKeyIndex: keyIndex, onAttempt: (idx, label) => { requests++; if (onAttempt) onAttempt(idx, label); }, what: 'voiceover' },
      (key) => ttsRequest({ key, model, voice: clipVoice, style, text, temperature, language })
    );
    keyIndex = usedKeyIndex;
    for (const k of Object.keys(tokenUsage)) tokenUsage[k] += result.usage[k] || 0;
    return result.wav;
  };

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const name = clipName(s);
    const clipVoice = voiceOf(s);
    const hash = clipHash(settingsFor(s));
    const p = clipPaths(outDir, hash);
    const cachedMeta = force.includes(s.idx) ? null : readClip(outDir, hash);
    if (cachedMeta) {
      progress(i + 1, `${name} (already done)`);
      clips.push({ idx: s.idx, name, hash, voice: clipVoice, durationSec: cachedMeta.durationSec, cached: true, retried: !!cachedMeta.retried, warning: cachedMeta.warning || '' });
      continue;
    }

    progress(i, `Voice ${i + 1}/${total} — ${name}`);
    const refRate = median(acceptedRates);
    let wav, info, retried = false, warning = '';
    try {
      wav = await requestWav(s.speakText, clipVoice);
      info = parseWav(wav);
      if (isSuspect(s.chars, info.durationSec, refRate)) {
        const r1 = rateOf(s.chars, info.durationSec).toFixed(1);
        progress(i, `${name} sounds too short (${r1} chars/s) — TTS may have skipped text, retrying…`);
        console.log(`  ⚠️ voiceover: ${name} suspect (${r1} chars/s) — retrying`);
        const wav2 = await requestWav(s.speakText, clipVoice);
        const info2 = parseWav(wav2);
        if (info2.durationSec > info.durationSec) { wav = wav2; info = info2; }
        retried = true;
        if (isSuspect(s.chars, info.durationSec, refRate))
          warning = `${name} may have skipped text (${rateOf(s.chars, info.durationSec).toFixed(1)} chars/s) — listen and regenerate it if needed.`;
      }
    } catch (err) {
      const done = clips.length;
      err.message = `${done}/${total} voices done (saved). Stopped at ${name}: ${err.message}` +
        (/quota|exhaust|429|per day|daily/i.test(err.message) ? ' — click Generate again after the daily reset (midnight Pacific) to finish the rest.' : '');
      err.partial = { usedKeyIndex: keyIndex, tokenUsage, requests };
      throw err;
    }

    fs.writeFileSync(p.wav, wav);
    await runFfmpeg(['-i', p.wav, '-codec:a', 'libmp3lame', '-q:a', '3', p.mp3]);
    fs.rmSync(p.wav, { force: true }); // sirf MP3 rakhni hai
    fs.writeFileSync(p.meta, JSON.stringify({ idx: s.idx, name, chars: s.chars, durationSec: info.durationSec, retried, warning, voice: clipVoice, model, createdAt: new Date().toISOString() }));
    if (warning) warnings.push(warning);
    else acceptedRates.push(rateOf(s.chars, info.durationSec));
    clips.push({ idx: s.idx, name, hash, voice: clipVoice, durationSec: info.durationSec, cached: false, retried, warning });
    progress(i + 1, `Voice ${i + 1}/${total} ready — ${name}`);
  }

  return { clips, usedKeyIndex: keyIndex, tokenUsage, requests, warnings };
}

/** Purani clips (jin ka text/voice ab badal chuka) delete — sirf `keepHashes` bachti hain. */
function pruneClips(outDir, keepHashes) {
  const dir = clipsDir(outDir);
  if (!fs.existsSync(dir)) return 0;
  const keep = new Set(keepHashes);
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!keep.has(f.replace(/\.(wav|mp3|json)$/, ''))) { fs.rmSync(path.join(dir, f), { force: true }); removed++; }
  }
  return removed;
}

module.exports = {
  synthesizeImages, pruneClips, readClip, clipHash, clipName, clipPaths, ttsRequest, parseWav, isSuspect, RATE_MAX,
};
