// Multi-key runner — gemini.js wali rotation logic ko reusable banaya (TTS waghera ke liye).
//  - 503/overload → ruk kar wahi key dobara
//  - 429 (rate limit) → pehle thoda ruk kar wahi key (RPM ho sakta hai), phir agli key
//  - invalid/suspended key → seedha agli key
//  - non-key error (network etc.) → turant throw
const { isKeyRotatableError, isTransientError, sleep } = require('./gemini');

const TRANSIENT_DELAYS = [4000, 10000];
const RATE_LIMIT_DELAYS = [12000, 30000];

function maskKey(key) { return '…' + key.slice(-6); }

function isRateLimit(err) {
  const status = err && (err.status || err.code);
  const msg = ((err && err.message) || '').toLowerCase();
  return status === 429 || msg.includes('resource_exhausted') || msg.includes('too many requests') || msg.includes('rate limit');
}

/**
 * @param {object} o
 * @param {string[]} o.keys
 * @param {number} o.activeKeyIndex
 * @param {(idx:number, label:string)=>void} [o.onAttempt]  har API try par (quota count)
 * @param {string} [o.what]  error messages ke liye naam
 * @param {(key:string, idx:number)=>Promise<any>} fn
 */
async function withKeys({ keys, activeKeyIndex = 0, onAttempt, what = 'request' }, fn) {
  if (!keys || !keys.length) throw new Error('No Google AI API key set — add your key(s) on the Settings page.');
  const failures = [];
  let sawTransient = false;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx = (activeKeyIndex + attempt) % keys.length;
    const key = keys[idx];
    const label = maskKey(key);
    let transientTries = 0, rateTries = 0;
    for (;;) {
      try {
        if (onAttempt) onAttempt(idx, label);
        const result = await fn(key, idx);
        return { result, usedKeyIndex: idx, usedKeyLabel: label, rotated: idx !== activeKeyIndex, failures };
      } catch (err) {
        const reason = ((err && err.message) || 'unknown error').slice(0, 200);
        if (isTransientError(err) && transientTries < TRANSIENT_DELAYS.length) {
          sawTransient = true;
          const wait = TRANSIENT_DELAYS[transientTries++];
          console.log(`  ⏳ ${what}: model busy — retrying in ${wait / 1000}s (Key #${idx + 1})`);
          await sleep(wait);
          continue;
        }
        if (isRateLimit(err) && rateTries < RATE_LIMIT_DELAYS.length && !/per day|daily|RPD/i.test(reason)) {
          const wait = RATE_LIMIT_DELAYS[rateTries++];
          console.log(`  ⏳ ${what}: rate-limited — waiting ${wait / 1000}s before retrying Key #${idx + 1}`);
          await sleep(wait);
          continue;
        }
        failures.push({ index: idx, key: label, reason });
        if (isTransientError(err) || isKeyRotatableError(err)) {
          console.log(`  ⚠️ ${what}: Key #${idx + 1} (${label}) failed — trying next key: ${reason}`);
          break;
        }
        throw err;
      }
    }
  }
  const list = failures.map((f) => `Key #${f.index + 1} (${f.key}): ${f.reason}`).join(' | ');
  if (sawTransient && failures.every((f) => /unavailable|high demand|overloaded|503|try again/i.test(f.reason))) {
    throw new Error("🕐 Google's model is under HIGH DEMAND right now (503) — not a key/quota problem. The app already retried with waits on every key. Try again in 1-2 minutes.");
  }
  throw new Error(`All ${keys.length} API key(s) failed or out of quota for ${what}. ${list}`);
}

module.exports = { withKeys, maskKey };
