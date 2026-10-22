// Gemini ke output se script + ===CHARACTERS=== JSON + ===SOURCE=== JSON alag karna — TOLERANT.
//  * Marker ki har shakal pakdi jaati hai: "=== CHARACTERS ===", "**===CHARACTERS===**", "## ===CHARACTERS===", code fences.
//  * Script ke andar marker ka zikr (echo) ignore — wo AAKHRI marker liya jaata hai jis ke baad '[' aata hai.
//  * Marker na ho toh bhi: aakhir mein ```json [ {...name...} ] ``` ya bare array → characters; trailing {"watermarks":…} → source.
//  * JSON bracket-depth se kaata jaata hai (lastIndexOf nahi), parse fail par lenient repair (trailing commas, smart quotes, // comments).
//  * warnings[] — UI ko batane ke liye ke kuch ajeeb hua (0 characters, JSON script mein reh gaya, parse error, truncation).
'use strict';

const markerRe = (word) => new RegExp(`^[ \\t]*(?:\\*\\*|#{1,6}[ \\t]*|\`{1,3}[a-z]*)?[ \\t]*={2,}[ \\t]*${word}[ \\t]*={2,}[ \\t]*(?:\\*\\*|\`{1,3})?[ \\t]*$`, 'gim');

function stripFences(s) {
  return String(s || '').replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
}

/** `open` se uske MATCHING close tak ka JSON text (strings ke andar brackets ignore). null = nahi mila. */
function sliceBalanced(text, open, close, from = 0) {
  const start = text.indexOf(open, from);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return { text: text.slice(start, i + 1), start, end: i + 1 }; }
  }
  return { text: text.slice(start), start, end: text.length, truncated: true };
}

function repairJson(s) {
  return s
    .replace(/[\u201C\u201D\u201E]/g, '"').replace(/[\u2018\u2019]/g, "'")
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([\]}])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":'); // unquoted keys
}

/** Kata hua JSON band karo: khuli string band, adhoora `, "key": "val` hatao, phir saare khule brackets ulte order mein band. */
function closeTruncated(src) {
  let inStr = false, esc = false;
  const stack = [];
  for (const ch of src) {
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = src;
  if (inStr) out += '"';
  out = out.replace(/,\s*("[^"]*"\s*:?\s*("[^"]*")?)?\s*$/, '').replace(/:\s*$/, ': ""');
  return out + stack.reverse().join('');
}

/** @returns {{ value: any, error: string }} */
function parseJsonLoose(text, open, close) {
  const sl = sliceBalanced(stripFences(text), open, close);
  if (!sl) return { value: null, error: 'no JSON found' };
  let src = sl.text;
  if (sl.truncated) src = closeTruncated(src); // kata hua array/object — band karne ki koshish
  try { return { value: JSON.parse(src), error: '' }; } catch {}
  try { return { value: JSON.parse(repairJson(src)), error: '' }; } catch (e) { return { value: null, error: (e && e.message) || 'JSON parse failed' }; }
}

/** Marker ke baad (fences/whitespace ke baad) kya pehla non-space char hai? */
function nextMeaningfulChar(text, from) {
  const rest = text.slice(from).replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/^\s+/, '');
  return rest[0] || '';
}

function findMarker(text, word, expectChar) {
  const re = markerRe(word);
  let m, best = null;
  while ((m = re.exec(text))) {
    const after = m.index + m[0].length;
    if (nextMeaningfulChar(text, after) === expectChar) best = { index: m.index, after }; // aakhri valid marker jeet-ta hai (echo skip)
  }
  return best;
}

/**
 * @returns {{ narration: string, detected: object[], source: object|null, warnings: string[] }}
 */
function splitGeminiOutput(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const warnings = [];
  let detected = [], source = null;
  let cut = raw.length;

  const cm = findMarker(raw, 'CHARACTERS', '[');
  const sm = findMarker(raw, 'SOURCE', '{');
  let charsText = '', sourceText = '';
  if (cm) { cut = Math.min(cut, cm.index); charsText = raw.slice(cm.after, sm && sm.index > cm.after ? sm.index : raw.length); }
  if (sm) { cut = Math.min(cut, sm.index); sourceText = raw.slice(sm.after, cm && cm.index > sm.after ? cm.index : raw.length); }

  if (!cm) {
    // Fallback: aakhir mein bare/fenced JSON array jis mein "name" ho
    const tail = raw.slice(Math.max(0, raw.length - 6000));
    const idx = tail.search(/```(?:json)?\s*\[\s*\{|\n\s*\[\s*\{\s*"name"/i);
    if (idx !== -1) {
      const abs = raw.length - tail.length + idx;
      const sl = sliceBalanced(stripFences(raw.slice(abs)), '[', ']');
      if (sl && /"name"\s*:/.test(sl.text)) { charsText = raw.slice(abs); cut = Math.min(cut, abs); warnings.push('Characters JSON found without the ===CHARACTERS=== marker — recovered it.'); }
    }
  }
  if (!sm && !source) {
    const wm = raw.lastIndexOf('"watermarks"');
    if (wm !== -1) {
      const objStart = raw.lastIndexOf('{', wm);
      if (objStart !== -1 && objStart >= cut - 2000) { sourceText = raw.slice(objStart); cut = Math.min(cut, objStart); }
    }
  }

  if (charsText) {
    const p = parseJsonLoose(charsText, '[', ']');
    if (Array.isArray(p.value)) detected = p.value.filter((d) => d && typeof d === 'object');
    else warnings.push('Could not read the characters JSON Gemini returned' + (p.error ? ` (${p.error})` : '') + ' — roster not updated this time.');
  }
  if (sourceText) {
    const p = parseJsonLoose(sourceText, '{', '}');
    if (p.value && typeof p.value === 'object') source = p.value;
    else warnings.push('Could not read the source/watermark JSON' + (p.error ? ` (${p.error})` : '') + '.');
  }

  let narration = raw.slice(0, cut).replace(/\s*```\s*$/, '').trim();
  // Script ke andar JSON reh gaya? (marker bilkul nahi mila lekin "name": dikh raha hai)
  if (/[\[{]\s*"name"\s*:/.test(narration)) warnings.push('Character JSON seems to have leaked into the script text — check the end of the script.');
  if (raw.trim() && narration.length < raw.trim().length * 0.3 && raw.trim().length > 2000) warnings.push('The script looks much shorter than Gemini\'s full output — part of it may have been cut as JSON.');
  if (!cm && !charsText) warnings.push('Gemini did not return the ===CHARACTERS=== block — roster not updated for this chapter.');
  return { narration, detected, source, warnings };
}

module.exports = { splitGeminiOutput, parseJsonLoose, sliceBalanced, repairJson, markerRe };
