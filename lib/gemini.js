// Gemini narration generation — resizes/slices tall webtoon images then calls Google GenAI
const { GoogleGenAI } = require('@google/genai');
const sharp = require('sharp');

const TARGET_WIDTH = 720; // resize width for upload
const MAX_SLICE_RATIO = 2.2; // slice image if height > width * ratio
const JPEG_QUALITY = 62;

/**
 * Webtoon strips are very tall; Gemini downscales huge images and text becomes
 * unreadable. So: resize to a sane width, and slice tall images into vertical
 * segments so every panel stays legible.
 */
async function prepareImageParts(imagePath) {
  const base = sharp(imagePath).rotate();
  const meta = await base.metadata();
  if (!meta.width || !meta.height) throw new Error('Could not read image: ' + imagePath);

  const scale = Math.min(1, TARGET_WIDTH / meta.width);
  const width = Math.round(meta.width * scale);
  const height = Math.round(meta.height * scale);

  const resizedBuf = await base
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  const maxSliceHeight = Math.round(width * MAX_SLICE_RATIO);
  // layout: Gemini ke face boxes (per part, 0-1000) ko wapas source pixels mein map karne ke liye
  const layout = { srcWidth: meta.width, srcHeight: meta.height, scale, width, height, slices: [] };
  if (height <= maxSliceHeight) {
    layout.slices.push({ top: 0, height });
    return { parts: [toInlinePart(resizedBuf)], layout };
  }

  // Slice tall strip into segments
  const parts = [];
  const sliceCount = Math.ceil(height / maxSliceHeight);
  for (let i = 0; i < sliceCount; i++) {
    const top = i * maxSliceHeight;
    const sliceHeight = Math.min(maxSliceHeight, height - top);
    if (sliceHeight < 24) continue; // skip tiny leftover strip
    const buf = await sharp(resizedBuf)
      .extract({ left: 0, top, width, height: sliceHeight })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    parts.push(toInlinePart(buf));
    layout.slices.push({ top, height: sliceHeight });
  }
  return { parts, layout };
}

function toInlinePart(buf) {
  return { inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') } };
}

/**
 * Kya ye error aisa hai ke agli key try karni chahiye?
 * - 429 / RESOURCE_EXHAUSTED / quota / rate limit → key ki limit khatam
 * - invalid/expired/suspended key, permission denied → key kharab, agli try karo
 */
function isKeyRotatableError(err) {
  const status = err && (err.status || err.code);
  if (status === 429 || status === 403 || status === 401) return true;
  const msg = ((err && err.message) || '').toLowerCase();
  return (
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('rate-limit') ||
    msg.includes('too many requests') ||
    msg.includes('api key not valid') ||
    msg.includes('api_key_invalid') ||
    msg.includes('api key expired') ||
    msg.includes('permission_denied') ||
    msg.includes('permission denied') ||
    msg.includes('suspended')
  );
}

/**
 * Kya ye Google ki taraf ka TEMPORARY masla hai? (key/quota ka nahi)
 * 503 UNAVAILABLE "high demand", 500 internal, timeout — thodi der ruk kar
 * wahi request dobara chalane se aksar chal jaati hai.
 */
function isTransientError(err) {
  const status = err && (err.status || err.code);
  if (status === 503 || status === 500 || status === 504) return true;
  const msg = ((err && err.message) || '').toLowerCase();
  return (
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('try again later') ||
    msg.includes('internal error') ||
    msg.includes('deadline exceeded')
  );
}

const TRANSIENT_RETRY_DELAYS = [4000, 10000]; // 503 par: 4s ruk kar retry, phir 10s ruk kar

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Multi-key generation with auto-rotation + auto-retry:
 * - Images sirf EK baar prepare hoti hain, phir active key se try hota hai.
 * - 503/overload (Google ka temporary rush) → app khud 4s / 10s ruk kar WAHI request
 *   dobara chalati hai; phir bhi na chale toh agli key try hoti hai.
 * - Key ki limit khatam / key kharab → agli key par WAHI request dobara chalti hai
 *   (kaam wahin se resume — kuch dobara upload nahi karna padta).
 * - Jo key chali, uska index yaad rakha jaata hai taake agla chapter usi se shuru ho.
 * - onAttempt(index, keyId) har API try par call hota hai (quota counting ke liye).
 */
async function generateNarration({ keys, activeKeyIndex = 0, model, prompt, imagePaths, onAttempt, reminder = '', temperature, seed, refParts = [] }) {
  if (!keys || !keys.length)
    throw new Error('No Google AI API key set — add your key(s) on the Settings page.');
  if (!imagePaths.length) throw new Error('This chapter has no images.');

  // Images ek hi baar prepare — key switch par dobara kaam nahi.
  // Har image se pehle sirf uska NUMBER label ke taur par jaata hai (file ka naam nahi — "ha-hyun-ch2.jpg" jaise
  // naam model ko ghalat spelling sikha dete hain), taake script mein [IMAGE n] markers sahi image par lagen.
  const parts = [{ text: prompt }];
  // Reference faces (roster characters ke chhote face crops, naam ke saath) — chapter images se PEHLE
  if (refParts && refParts.length) parts.push(...refParts);
  const imageLayouts = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const item = imagePaths[i];
    const filePath = typeof item === 'string' ? item : item.path;
    parts.push({ text: `\n===== IMAGE ${i + 1} =====` });
    const { parts: imageParts, layout } = await prepareImageParts(filePath);
    imageLayouts.push(layout);
    // Lambi strip ke tukde label ke saath jaate hain taake face box "part p of q" ke hisaab se wapas map ho sake
    imageParts.forEach((p, k) => { if (imageParts.length > 1) parts.push({ text: `(IMAGE ${i + 1} — part ${k + 1} of ${imageParts.length})` }); parts.push(p); });
  }
  // Saari images ke BAAD ek chhota reminder — lambi image list ke aakhir mein model hidayaat bhool jaata hai
  if (reminder) parts.push({ text: reminder });
  const config = {};
  if (Number.isFinite(temperature)) config.temperature = temperature; // kam temperature = har regenerate par naam/spelling zyada stable
  if (Number.isInteger(seed)) config.seed = seed;

  const failures = [];
  let sawTransient = false;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx = (activeKeyIndex + attempt) % keys.length;
    const key = keys[idx];
    const keyLabel = '…' + key.slice(-6);
    const ai = new GoogleGenAI({ apiKey: key });

    // Is key par: 1 try + 503/overload par TRANSIENT_RETRY_DELAYS ke saath extra tries
    for (let retry = 0; retry <= TRANSIENT_RETRY_DELAYS.length; retry++) {
      try {
        if (onAttempt) onAttempt(idx, keyLabel);
        const response = await ai.models.generateContent({
          model: model || 'gemini-3.8-flash',
          contents: [{ role: 'user', parts }],
          ...(Object.keys(config).length ? { config } : {}),
        });

        // Adhoora/blocked output "done" script na ban jaye — finishReason check
        const block = response.promptFeedback && response.promptFeedback.blockReason;
        if (block) throw new Error(`Gemini blocked this request (${block}) — try again, or remove the image it objects to.`);
        const cand = response.candidates && response.candidates[0];
        const finish = cand && cand.finishReason;
        const text = response.text;
        if (!text || !text.trim()) {
          throw new Error(`Gemini returned an empty response${finish ? ` (${finish})` : ''} — try again or switch the model.`);
        }
        if (finish && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(finish)) {
          if (finish === 'MAX_TOKENS')
            throw new Error(`The script was cut off by the model (MAX_TOKENS) after ~${text.length} characters — split this chapter into two smaller chapters (fewer images) and generate again.`);
          throw new Error(`Gemini stopped early (${finish}) — the script is incomplete. ${finish === 'RECITATION' ? 'It copied the source text too closely; generate again (own words).' : 'Try again or switch the model in Settings.'}`);
        }

        // Token usage extract karo
        const usage = response.usageMetadata || {};
        const tokenUsage = {
          promptTokens:     usage.promptTokenCount     || 0,
          candidateTokens:  usage.candidatesTokenCount || 0,
          totalTokens:      usage.totalTokenCount      || 0,
        };

        return {
          text: text.trim(),
          imageLayouts,
          tokenUsage,
          usedKeyIndex: idx,
          usedKeyLabel: keyLabel,
          rotated: idx !== activeKeyIndex,
          failures,
        };
      } catch (err) {
        const reason = (err && err.message ? err.message : 'unknown error').slice(0, 160);

        // Google ka temporary overload (503) → ruk kar WAHI request dobara
        if (isTransientError(err)) {
          sawTransient = true;
          if (retry < TRANSIENT_RETRY_DELAYS.length) {
            const wait = TRANSIENT_RETRY_DELAYS[retry];
            console.log(`  ⏳ Model busy (503) — retrying in ${wait / 1000}s (Key #${idx + 1}, try ${retry + 2})…`);
            await sleep(wait);
            continue; // same key, dobara try
          }
          failures.push({ index: idx, key: keyLabel, reason });
          console.log(`  ⚠️ Key #${idx + 1} (${keyLabel}) retries exhausted — trying next key.`);
          break; // is key ke retries khatam → agli key
        }

        failures.push({ index: idx, key: keyLabel, reason });
        if (isKeyRotatableError(err)) {
          console.log(`  ⚠️ Key #${idx + 1} (${keyLabel}) failed — switching to next key: ${reason}`);
          break; // agli key, wahi request
        }
        throw err; // non-key error (e.g. network) — rotation ka faida nahi
      }
    }
  }

  // Saari keys try ho gayin — ab wajah ke hisaab se saaf message
  const list = failures.map((f) => `Key #${f.index + 1} (${f.key}): ${f.reason}`).join(' | ');
  const allTransient = sawTransient && failures.every((f) => /unavailable|high demand|overloaded|503|try again/i.test(f.reason));
  if (allTransient) {
    throw new Error(
      `🕐 Google's model '${model}' is under HIGH DEMAND right now (503) — this is NOT a problem with your keys or quota, it's a temporary rush on Google's side. The app already retried with waits on every key. Try "Generate" again in 1-2 minutes. If it keeps happening, switch to another model (gemini-3.7-flash) in Settings.`
    );
  }
  let hint = '';
  const allQuota = failures.every((f) => f.reason.includes('429') || /quota|exceeded/i.test(f.reason));
  if (allQuota && /pro/i.test(model || '')) {
    hint = ` 💡 HINT: '${model}' is a pro model — pro models do NOT work on FREE keys (they require paid billing). Select a flash model in Settings (e.g. gemini-3.8-flash) or use "Load Models" to see what your key can access.`;
  }
  throw new Error(`All ${keys.length} API key(s) failed or out of quota. ${list}${hint}`);
}

/**
 * Google se live model list — jab bhi Google models badle, Settings mein
 * "Models Load Karo" dabao aur latest list mil jayegi.
 */
async function listModels(apiKey, { tts = false } = {}) {
  if (!apiKey) throw new Error('Save an API key first.');
  const ai = new GoogleGenAI({ apiKey });
  const pager = await ai.models.list({ config: { pageSize: 200 } });
  const names = [];
  const skip = tts ? ['embedding', 'image', 'imagen', 'veo', 'live', 'aqa', 'gemma'] : ['embedding', 'image', 'imagen', 'veo', 'tts', 'audio', 'live', 'aqa', 'gemma'];
  for await (const m of pager) {
    const name = (m.name || '').replace(/^models\//, '');
    if (!name.startsWith('gemini')) continue;
    if (tts && !name.includes('tts')) continue;
    if (skip.some((s) => name.includes(s))) continue;
    const actions = m.supportedActions || m.supportedGenerationMethods || [];
    if (actions.length && !actions.includes('generateContent')) continue;
    names.push(name);
  }
  // Pro pehle, phir flash, phir baqi — naye version upar
  return [...new Set(names)].sort((a, b) => {
    const rank = (n) => (n.includes('pro') ? 0 : n.includes('flash') ? 1 : 2);
    return rank(a) - rank(b) || b.localeCompare(a, undefined, { numeric: true });
  });
}

module.exports = { generateNarration, prepareImageParts, listModels, isKeyRotatableError, isTransientError, sleep };
