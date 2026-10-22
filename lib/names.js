// Character naam ka poora "dimaag" — pure functions, koi DB nahi (tests aasaan).
//  * normName / romKey: spelling, hyphen, case, diacritics aur Korean romanization ke farq mita deta hai
//    (Hyeon/Hyun/Hyon, Sin/Shin, Ji-hyeok/Jihyuk/Ji Hyeok → ek hi key).
//  * matchCharacterDetailed: layered matcher — exact → alias → folded → asymmetric subset → edit distance,
//    har layer par AMBIGUITY GUARD (do candidates = koi match nahi, bajaye ghalat merge ke).
//  * isGenericName: "Masked Man", "Hyeon ki ammi", "Mother of X", "???" — ye log roster mein character nahi bante.
//  * mergeClauses: rishton ki list — paraphrase dedupe, naya rishta purane ko replace kare, clause-wise truncate.
//  * canonicalizeNamesInText / auditNames: script/rishton ke text mein variant spellings → roster naam; audit = warnings.
'use strict';

// ---------- normalisation ----------
const DASHES = /[‐-―−⁃﹘﹣－]/g;
const APOS = /[‘’‚‛′´`]/g;
const QUOTES = /[“”„‟″«»]/g;

/** Lowercase, diacritics/fancy punctuation hatao, hedges ("?", "(possibly …)") hatao, whitespace collapse. */
function normName(s) {
  let t = (s === undefined || s === null ? '' : String(s))
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(DASHES, '-').replace(APOS, "'").replace(QUOTES, '"')
    .replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ')         // (possibly Hyeon), [sic]
    .replace(/[\s"']*\?+[\s"']*$/g, '')                   // "Sin Ji-hyeok?" → hedge
    .replace(/^[\s"'“”‘’(\[{]+|[\s"'“”‘’)\]}.,;:!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  t = t.replace(/^the\s+/, '');
  return t;
}

// Titles / honorifics jo naam ka hissa NAHI hain (shuru ya aakhir se hatane ke liye)
const TITLE_WORDS = new Set([
  'the', 'young', 'master', 'young master', 'elder', 'lord', 'lady', 'madam', 'madame', 'miss', 'mr', 'mrs', 'ms', 'sir', 'mister',
  'saint', 'sword saint', 'senior', 'junior', 'hyung', 'hyeong', 'nuna', 'noona', 'oppa', 'unni', 'eonni', 'sunbae', 'seonbae', 'hoobae',
  'sajang', 'gaju', 'gajoo', 'sohyeop', 'sojeo', 'daehyeop', 'gongja', 'nim', 'ssi', 'gun', 'yang', 'sama', 'san', 'kun', 'chan', 'dono',
  'chhota', 'chhoti', 'chota', 'choti', 'bada', 'badi', 'boodha', 'boodhi', 'budha', 'budhi', 'nanha', 'nanhi', 'little', 'old', 'kid', 'child',
  'boy', 'girl', 'grandpa', 'grandma', 'uncle', 'aunt', 'general', 'commander', 'captain', 'prince', 'princess', 'king', 'queen', 'emperor',
  'empress', 'duke', 'count', 'knight', 'sect leader', 'clan head', 'patriarch', 'matriarch', 'great', 'grand', 'sage', 'doctor', 'teacher',
  'instructor', 'disciple', 'young lord', 'young lady', 'crown prince', 'heavenly demon', 'demon', 'dark', 'evil', 'awakened', 'adult', 'teen', 'teenage',
]);
const HONORIFIC_SUFFIX = /-(nim|ssi|ah|ya|gun|yang|san|sama|kun|chan|dono)$/;

/** "sword saint namgung muryong" → { core: "namgung muryong", titles: ["sword saint"] } */
function splitTitles(norm) {
  let words = norm.split(' ').filter(Boolean).map((w) => w.replace(HONORIFIC_SUFFIX, ''));
  const titles = [];
  const take = (fromStart) => {
    for (let len = 2; len >= 1; len--) {
      if (words.length - len < 1) continue; // kam az kam ek lafz naam ka bache
      const slice = fromStart ? words.slice(0, len) : words.slice(-len);
      if (TITLE_WORDS.has(slice.join(' '))) {
        titles.push(slice.join(' '));
        words = fromStart ? words.slice(len) : words.slice(0, -len);
        return true;
      }
    }
    return false;
  };
  while (take(true)) {}
  while (take(false)) {}
  return { core: words.join(' '), titles };
}

/** Naam ke tokens (space/hyphen par) — 1-letter tokens bhi rakhte hain ("Baek I" ≠ "Baek Il"). */
function nameTokens(norm) {
  return norm.split(/[\s-]+/).map((w) => w.replace(/[^\p{L}\p{N}']/gu, '')).filter(Boolean);
}

/**
 * Korean romanization folding: alag spelling systems ek key par.
 * Sin/Shin → sin · Hyeon/Hyun/Hyon → hyon · Yeongryeong/Young-ryung → yonglyong · Baek/Paek → pek · Ji-hyeok/Jihyuk → cihyok
 */
function romKey(token) {
  let k = String(token).toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
  if (!k) return '';
  k = k.replace(/ck/g, 'k').replace(/ph/g, 'p').replace(/sh/g, 's').replace(/ch/g, 'c').replace(/th/g, 't').replace(/[lr]h/g, 'l');
  k = k.replace(/yeo|yo|yu|yoo/g, 'yo').replace(/ae|ai/g, 'e').replace(/ee|ui|yi/g, 'i').replace(/eo|eu|oo|ou|uh|u/g, 'o').replace(/oe|we/g, 'we');
  k = k.replace(/g/g, 'k').replace(/b/g, 'p').replace(/d/g, 't').replace(/r/g, 'l').replace(/j/g, 'c').replace(/z/g, 's');
  k = k.replace(/(.)\1+/g, '$1');
  return k;
}
const fusedKey = (norm) => nameTokens(norm).map(romKey).join('');

// ---------- generic / unnamed detection ----------
const GENERIC_WORDS = new Set([
  'of', 'mother', 'father', 'son', 'daughter', 'wife', 'husband', 'brother', 'sister', 'grandfather', 'grandmother', 'grandson', 'granddaughter',
  'uncle', 'aunt', 'nephew', 'niece', 'cousin', 'parent', 'parents', 'servant', 'maid', 'guard', 'guards', 'soldier', 'soldiers', 'assassin', 'assassins',
  'man', 'men', 'woman', 'women', 'boy', 'boys', 'girl', 'girls', 'figure', 'figures', 'stranger', 'person', 'people', 'villager', 'villagers', 'bandit',
  'bandits', 'thug', 'thugs', 'cultist', 'cultists', 'disciples', 'leader', 'head', 'member', 'members', 'unknown', 'unnamed', 'unidentified', 'mysterious',
  'masked', 'hooded', 'veiled', 'cloaked', 'shadow', 'shadowy', 'silhouette', 'someone', 'nobody', 'narrator', 'writer', 'author', 'reader', 'viewer',
  'old', 'young', 'elderly', 'child', 'kid', 'baby', 'merchant', 'innkeeper', 'official', 'minister', 'messenger', 'attacker', 'attackers', 'enemy', 'enemies',
  'killer', 'pursuer', 'pursuers', 'subordinate', 'subordinates', 'henchman', 'henchmen', 'warrior', 'warriors', 'martial', 'artist', 'artists',
  'clan', 'sect', 'family', 'group', 'tribe', 'guild', 'order', 'court', 'army', 'squad', 'troops', 'elders', 'disciple',
  // Roman Urdu
  'ammi', 'abbu', 'amma', 'baba', 'nana', 'nani', 'dada', 'dadi', 'beta', 'beti', 'bhai', 'behen', 'behan', 'chacha', 'chachi', 'mama', 'mami', 'khala',
  'phuppo', 'kaatil', 'qaatil', 'naqaab', 'naqaab-posh', 'naqaabposh', 'aadmi', 'aurat', 'ladka', 'ladki', 'log', 'sipahi', 'fauji', 'malik', 'maalik',
  'sardar', 'ustad', 'guru', 'shagird', 'dushman', 'dost', 'budha', 'boodha', 'budhi', 'boodhi', 'bacha', 'baccha', 'bachi', 'wala', 'wali', 'wale',
]);
const HEDGE_RE = /\b(possibly|maybe|probably|likely|perhaps|unclear|unidentified|unknown|unnamed|unseen|mystery|mysterious|placeholder|tbd|n\/a)\b|\?|^\.+$|^-+$|^…$/i;

/** true = ye koi asal naam nahi (rishta/hulia/placeholder) — roster mein character nahi banana. */
function isGenericName(name) {
  const raw = String(name || '').trim();
  if (!raw || raw.length < 2) return true;
  if (HEDGE_RE.test(raw)) return true;
  if (/'s\b/i.test(raw) || /\bof\b/i.test(raw)) return true;        // "Hyeon's mother", "Mother of Hyeon"
  const norm = normName(raw);
  const { core } = splitTitles(norm);
  // Hyphen wale Korean naam ek unit ("Mu-gang", "Ji-hyeok") — warna "gang"/"man" jaise syllables generic lag sakte hain
  const toks = (core || norm).split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, '')).filter(Boolean);
  if (!toks.length) return true;
  if (toks.every((t) => GENERIC_WORDS.has(t) || TITLE_WORDS.has(t) || /^\d+$/.test(t))) return true; // "Masked Man", "Assassin 2", "Elder"
  // Titles (shuru/aakhir) hatane ke baad bhi koi GENERIC lafz bacha → ye hulia/rishta hai, naam nahi
  // ("Namgung clan elder" → core "namgung clan"; "Hooded Ji"; "Sin family guard") — lekin "Elder Baek" → core "baek" → naam.
  if (toks.length >= 2 && toks.some((t) => GENERIC_WORDS.has(t) && !TITLE_WORDS.has(t))) return true;
  return false;
}

// ---------- matcher ----------
function charKeys(c) {
  const norm = normName(c.name);
  const { core } = splitTitles(norm);
  const aliases = String(c.aliases || '').split(',').map(normName).filter(Boolean);
  return {
    c, norm, core: core || norm,
    aliases,
    aliasCores: aliases.map((a) => splitTitles(a).core || a),
    tokens: nameTokens(core || norm),
    fused: fusedKey(core || norm),
    aliasFused: aliases.map((a) => fusedKey(splitTitles(a).core || a)),
  };
}

function damerauLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}

/** detected tokens (romKey) roster tokens mein contiguous, order-preserving subsequence hain? (strict subset) */
function isContiguousSubset(detTokens, rosterTokens) {
  if (!detTokens.length || rosterTokens.length < 2) return false;
  const a = detTokens.map(romKey), b = rosterTokens.map(romKey);
  if (a.length < b.length) {
    for (let i = 0; i + a.length <= b.length; i++) {
      let ok = true;
      for (let k = 0; k < a.length; k++) if (a[k] !== b[i + k]) { ok = false; break; }
      if (ok) return true;
    }
  }
  // Token boundaries alag ho sakti hain ("Young-ryung" = 2 tokens vs roster "Yeongryeong" = 1) — fused windows compare karo (poora naam chhod kar)
  const fa = a.join('');
  if (fa.length < 3) return false;
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j <= b.length; j++) {
    if (j - i === b.length) continue; // strict subset
    if (b.slice(i, j).join('') === fa) return true;
  }
  return false;
}

const unique = (arr) => [...new Set(arr)];

/**
 * @returns {{ match: object|null, kind: 'exact'|'alias'|'fold'|'subset'|'distance'|null, ambiguous: string[], generic: boolean }}
 *  match = roster character object (jaisa diya gaya), kind = kis layer par mila, ambiguous = jab >1 candidates the (koi match nahi diya).
 */
function matchCharacterDetailed(existing, name) {
  const norm = normName(name);
  const res = { match: null, kind: null, ambiguous: [], generic: false };
  if (!norm) return res;
  const keys = (existing || []).filter((c) => c && c.name).map(charKeys);
  const pick = (cands, kind) => {
    const list = unique(cands);
    if (list.length === 1) { res.match = list[0].c; res.kind = kind; return true; }
    if (list.length > 1) { res.ambiguous = list.map((k) => k.c.name); return true; }
    return false;
  };

  // 1. exact naam (ya titles hata kar barabar)
  const { core } = splitTitles(norm);
  const coreN = core || norm;
  if (pick(keys.filter((k) => k.norm === norm || k.core === norm || (coreN !== norm && k.core === coreN)), 'exact')) return res;

  // 2. exact alias — sirf jab kisi DOOSRE character ke naam ka lafz na ho (S10: "Hyeon" alias vs naya "Hyeon-woo"?)
  const aliasHits = keys.filter((k) => k.aliases.includes(norm) || k.aliasCores.includes(coreN));
  if (aliasHits.length) {
    const detToks = nameTokens(coreN);
    const nameWordClash = keys.filter((k) => !aliasHits.includes(k) && (isContiguousSubset(detToks, k.tokens) || k.fused === fusedKey(coreN)));
    if (aliasHits.length === 1 && !nameWordClash.length) { res.match = aliasHits[0].c; res.kind = 'alias'; return res; }
    res.ambiguous = unique([...aliasHits, ...nameWordClash]).map((k) => k.c.name);
    return res;
  }

  // generic/relation naam yahan ruk jaate hain — fuzzy layers unhe kisi par chipka sakti hain
  res.generic = isGenericName(name);
  if (res.generic) return res;

  // 3. romanization folding (poora naam, ya alias)
  const f = fusedKey(coreN);
  if (f.length >= 3 && pick(keys.filter((k) => k.fused === f || k.aliasFused.includes(f)), 'fold')) return res;

  // 4. asymmetric subset: detected ⊂ roster (contiguous, order-preserving). "Hyeon" → "Ha Hyeon"; kabhi roster ⊂ detected nahi.
  const detTokens = nameTokens(coreN);
  const letters = detTokens.join('').length;
  if (letters >= 3) {
    let cands = keys.filter((k) => isContiguousSubset(detTokens, k.tokens) || k.aliases.some((a) => nameTokens(a).length >= 2 && isContiguousSubset(detTokens, nameTokens(a))));
    if (cands.length > 1) {
      // tie-breaks: (a) jis ke aliases mein ye lafz pehle se hai; (b) bogus bare-token rows (jo kisi aur candidate ka subset hain) hatao
      const byAlias = cands.filter((k) => k.aliases.includes(norm));
      if (byAlias.length === 1) cands = byAlias;
      else {
        const notBogus = cands.filter((k) => !cands.some((o) => o !== k && isContiguousSubset(k.tokens, o.tokens)));
        if (notBogus.length === 1) cands = notBogus;
      }
    }
    if (pick(cands, 'subset')) return res;
  }

  // 5. edit distance on folded keys (typos: "Yeongreong" vs "Yeongryeong") — sirf utne hi naam-parts wale ("Ha Hyeon-woo" ≠ "Ha Hyeon")
  if (f.length >= 5) {
    const thr = Math.max(1, Math.floor(f.length / 6));
    const near = keys.filter((k) => k.fused.length >= 5 && k.tokens.length === detTokens.length && damerauLevenshtein(f, k.fused) <= thr);
    if (pick(near, 'distance')) return res;
  }
  return res;
}

/** Backwards-compatible: sirf character ya null. */
function matchCharacter(existing, name) {
  return matchCharacterDetailed(existing, name).match;
}

/** Alias store karne se pehle saaf karo; '' = alias mat seekho. */
function cleanAlias(detectedName, rosterName) {
  const norm = normName(detectedName);
  if (!norm || isGenericName(detectedName)) return '';
  const { core } = splitTitles(norm);
  const coreN = core || norm;
  const rNorm = normName(rosterName);
  if (coreN === rNorm || norm === rNorm) return '';
  // strict subset of roster name (bare given name / surname) → matcher already handles it; alias sirf capture karta (S10)
  if (isContiguousSubset(nameTokens(coreN), nameTokens(rNorm))) return '';
  // Original casing rakho (titles hata kar)
  const rawWords = String(detectedName).replace(DASHES, '-').replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ').replace(/[\s"']*\?+[\s"']*$/g, '').trim().split(/\s+/);
  const lowered = rawWords.map((w) => normName(w));
  let start = 0, end = rawWords.length;
  while (start < end - 1 && TITLE_WORDS.has(lowered[start])) start++;
  while (end - 1 > start && TITLE_WORDS.has(lowered[end - 1])) end--;
  const out = rawWords.slice(start, end).map((w) => w.replace(/[.,;:!?]+$/, '').replace(HONORIFIC_SUFFIX, '')).join(' ').trim();
  return out.length >= 2 && out.length <= 60 ? out : '';
}

// ---------- relationship clauses ----------
const CLAUSE_STOP = new Set(['the', 'a', 'an', 'of', 'who', 'whom', 'within', 'inside', 'that', 'which', 'is', 'was', 'are', 'were', 'has', 'have', 'had',
  'to', 'in', 'at', 'by', 'for', 'with', 'and', 'her', 'his', 'their', 'its', 'she', 'he', 'they', 'from', 'now', 'later', 'secretly', 'unknown', 'mysterious', 'secret']);
const REL_GROUPS = [
  ['mother', 'father', 'parent', 'son', 'daughter', 'child', 'grandfather', 'grandmother', 'grandson', 'granddaughter', 'uncle', 'aunt', 'nephew', 'niece', 'cousin', 'brother', 'sister', 'sibling', 'twin'],
  ['wife', 'husband', 'spouse', 'fiance', 'fiancee', 'lover', 'betrothed', 'widow', 'widower'],
  ['master', 'disciple', 'teacher', 'student', 'mentor', 'apprentice'],
  ['murderer', 'killer', 'killed', 'murdered', 'assassinated', 'slayer'],
  ['servant', 'subordinate', 'bodyguard', 'guard', 'retainer', 'lord', 'leader', 'head', 'commander'],
  ['enemy', 'rival', 'ally', 'friend', 'traitor', 'betrayed', 'betrayer'],
];
const NEGATION_RE = /\b(not|never|didn'?t|wasn'?t|isn'?t|weren'?t|no longer|framed|falsely|actually|in fact|turns out|revealed to be|retract(?:ed|ion)?)\b/i;

const splitClauses = (s) => String(s || '').split(';').map((x) => x.trim()).filter(Boolean);
/** "Chapter 3: mother of X" → { tag: "Chapter 3", text: "mother of X" } */
function splitTag(clause) {
  const m = clause.match(/^([^:]{1,40}):\s*(.+)$/);
  return m && !/^(mother|father|son|daughter|wife|husband|lord|master|head|leader)\b/i.test(m[1]) ? { tag: m[1].trim(), text: m[2].trim() } : { tag: '', text: clause };
}
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s|ly)$/, '') : w);
const clauseTokens = (text) => new Set(normName(text).replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/[\s-]+/).filter((w) => w && !CLAUSE_STOP.has(w)).map((w) => romKey(stem(w))));
const EXCLUSIVE_GROUPS = 4; // groups 0-3 (kinship, spouse, master/disciple, murderer) — ek target ke saath ek hi rishta sach ho sakta hai
const REL_WORDS = new Set(REL_GROUPS.flat());
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
const isSubset = (a, b) => [...a].every((x) => b.has(x));
function relGroupOf(text) {
  const toks = normName(text).split(/[\s-]+/);
  for (let g = 0; g < REL_GROUPS.length; g++) if (toks.some((t) => REL_GROUPS[g].includes(t))) return g;
  return -1;
}
const capRuns = (text) => (String(text).match(/\b[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)*/gu) || []);

/**
 * Rishton ki list merge: naye clauses jodo, paraphrase dedupe, same-group+same-target → naya purane ko replace kare,
 * negation purana hata de, limit par PURANE clauses giren (mid-word cut kabhi nahi).
 * opts.canon(text) = clause ke andar naam canonicalise karne ka callback; opts.tag = "Chapter 3" prefix naye clauses par.
 */
function mergeClauses(cur, extra, { max = 400, canon = (s) => s, tag = '' } = {}) {
  const list = splitClauses(cur).map((c) => ({ raw: c, ...splitTag(c) }));
  for (const rawNew of splitClauses(extra)) {
    const t0 = splitTag(rawNew);
    const text = canon(t0.text).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (/^(her|his|their|its|she|he|they)\b/i.test(text) && !capRuns(text).length) continue; // "her father" — kis ki? skip
    const toks = clauseTokens(text);
    const grp = relGroupOf(text);
    // target = clause mein aaya hua NAAM (rishte/generic lafz nahi: "Traitor", "Mother")
    const targetsOf = (t) => capRuns(t).filter((r) => { const n = normName(r); return n && !REL_WORDS.has(n) && !GENERIC_WORDS.has(n) && !CLAUSE_STOP.has(n); }).map((r) => fusedKey(normName(r))).filter(Boolean);
    const targets = targetsOf(text);
    let dup = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const old = list[i];
      const oToks = clauseTokens(old.text);
      const j = jaccard(toks, oToks);
      if (j >= 0.8 || isSubset(toks, oToks)) { dup = true; break; }           // paraphrase / chhota version pehle se hai
      if (isSubset(oToks, toks)) { list.splice(i, 1); continue; }           // purana chhota tha, naya zyada bata raha hai
      const oGrp = relGroupOf(old.text);
      const sameTarget = targets.length && targetsOf(old.text).some((t) => targets.includes(t));
      // Kinship/spouse/master/murderer: ek hi target ke saath naya reveal purane ko replace karta hai (negation bhi: "not the murderer of X")
      if (grp >= 0 && grp < EXCLUSIVE_GROUPS && grp === oGrp && sameTarget) list.splice(i, 1);
    }
    if (dup) continue;
    const tagged = (t0.tag || tag) ? `${t0.tag || tag}: ${text}` : text;
    list.push({ raw: tagged, tag: t0.tag || tag, text });
  }
  // clause-wise truncate — sab se purana pehle jaye
  const render = () => list.map((c) => (c.tag ? `${c.tag}: ${c.text}` : c.text)).join('; ');
  while (render().length > max && list.length > 1) list.shift();
  let out = render();
  if (out.length > max) out = out.slice(0, max).replace(/\s+\S*$/, '');
  return out;
}

/** "Chapter 3: text" clauses → sirf wo jin ka chapter order ≤ upto (untagged legacy sab) ; prefixes hata kar. */
function clausesUpTo(cur, upToOrder, orderOf) {
  return splitClauses(cur).filter((c) => {
    const { tag } = splitTag(c);
    if (!tag) return true;
    const o = orderOf(tag);
    return o === null || o === undefined || o <= upToOrder;
  }).map((c) => splitTag(c).text).join('; ');
}

// ---------- text helpers: canonicalise & audit ----------
const SENTENCE_STARTERS = new Set(['lekin', 'phir', 'ye', 'yeh', 'wo', 'woh', 'ab', 'aur', 'jab', 'tab', 'agar', 'kya', 'kyun', 'kyon', 'toh', 'to', 'dosto', 'doston',
  'writer', 'haan', 'nahi', 'arey', 'are', 'bilkul', 'main', 'mera', 'meri', 'mere', 'uska', 'uski', 'uske', 'unka', 'unki', 'unke', 'hum', 'tum', 'aap', 'is', 'us', 'yahan',
  'wahan', 'itna', 'kitna', 'bas', 'sirf', 'ek', 'do', 'teen', 'kuch', 'sab', 'har', 'jo', 'jis', 'jin', 'tak', 'din', 'raat', 'subah', 'shaam', 'haha', 'hahaha', 'boom',
  'dhamaaka', 'achanak', 'tabhi', 'usi', 'isi', 'waqt', 'saamne', 'peeche', 'upar', 'neeche', 'baarish', 'saath', 'sath', 'matlab', 'yaani', 'kaash', 'shayad', 'zaroor',
  'chhota', 'chhoti', 'bada', 'badi', 'kaatil', 'kaatilon', 'ji', 'j-ji', 'l-lekin', 'y-ye', 'a-aap', 'ammi', 'abbu', 'nana', 'beta', 'beti', 'bhai', 'image', 'images',
  'ha', 'na', 'oh', 'ohh', 'uff', 'hmm', 'khair', 'waise', 'dekho', 'suno', 'chalo', 'ruko', 'bhaago', 'nikal', 'jaldi', 'theek', 'sach', 'jhoot', 'kal', 'aaj']);

/** Roster se seekhe gaye variant spellings ko roster naam par le aao. expandShort=false → "Hyeon" jaisa short form nahi badalta. */
/** Roster naam ke words ka wo tukda jo run se (folded) barabar ho — "Young-ryung" → "Yeongryeong", "Hyun" → "Hyeon". null = literal hi hai / nahi mila. */
function rosterWindowFor(run, rosterName) {
  const words = String(rosterName).trim().split(/\s+/);
  const target = fusedKey(normName(run));
  for (let i = 0; i < words.length; i++) for (let j = i + 1; j <= words.length; j++) {
    const win = words.slice(i, j).join(' ');
    if (fusedKey(normName(win)) === target) return normName(win) === normName(run) ? null : win;
  }
  return null;
}

function canonicalizeNamesInText(text, roster, { expandShort = false } = {}) {
  if (!text || !roster || !roster.length) return text || '';
  const isTitleWord = (w) => TITLE_WORDS.has(normName(w));
  // Ek run (ya uska tukda) ko theek karo — titles ("Chhota", "Young Master") jaise hain waise rehte hain. null = koi match nahi.
  const shouting = (s) => s === s.toUpperCase() && s !== s.toLowerCase(); // "HA HYEON" — TTS letter-by-letter padh sakta hai
  const storedAlias = (c, n) => String(c.aliases || '').split(/[,;]/).map((a) => a.trim()).find((a) => normName(a) === n) || '';
  const fixCore = (core) => {
    const r = matchCharacterDetailed(roster, core);
    if (!r.match) return null;
    const n = normName(core), rn = normName(r.match.name);
    if (r.kind === 'exact') return shouting(core) && n === rn ? r.match.name : core; // same naam — jaisa likha hai (ALL-CAPS → roster casing)
    if (r.kind === 'subset') {
      if (expandShort) return r.match.name;
      const win = rosterWindowFor(core, r.match.name); // short form rehne do, sirf spelling/casing theek
      if (win) return win;
      return shouting(core) ? core.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, p, ch) => p + ch.toUpperCase()) : core;
    }
    if (r.kind === 'alias') {
      if (expandShort && !isContiguousSubset(nameTokens(n), nameTokens(rn))) return r.match.name;
      return shouting(core) ? (storedAlias(r.match, n) || core) : core; // alias jaisa likha hai (ALL-CAPS → stored casing)
    }
    return r.match.name; // fold / distance = ghalat spelling → roster naam
  };
  const fixRun = (run) => {
    const words = run.split(/\s+/);
    let a = 0, b = words.length;
    while (a < b - 1 && isTitleWord(words[a])) a++;
    while (b - 1 > a && isTitleWord(words[b - 1])) b--;
    const core = words.slice(a, b).join(' ');
    const fixed = fixCore(core);
    if (fixed === null) return null;
    return [...words.slice(0, a), fixed, ...words.slice(b)].join(' ');
  };
  return String(text).replace(/\b[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)*/gu, (run) => {
    const direct = fixRun(run);
    if (direct !== null) return direct;
    // Lamba run ("Beautiful Poisonous Heart Namgung Young-ryung", "Tabhi Shin Jihyuk") — sab se lamba andar ka tukda dhoondo jo badalta ho
    const words = run.split(/\s+/);
    for (let len = words.length - 1; len >= 1; len--) {
      for (let i = 0; i + len <= words.length; i++) {
        const win = words.slice(i, i + len).join(' ');
        const f = fixRun(win);
        if (f !== null && f !== win) return [...words.slice(0, i), f, ...words.slice(i + len)].join(' ');
      }
    }
    return run;
  });
}

/**
 * Script ka naam-audit: speaker labels + prose ke capitalised runs vs roster (+ is chapter ka detected JSON).
 * @returns {{ unknown: {name,count,inLabel}[], nearMatches: {found,roster,count,kind}[], jsonOnly: string[] }}
 */
function auditNames(narration, roster, detected = []) {
  const text = String(narration || '').replace(/\r/g, '');
  const rosterList = (roster || []).filter((c) => c && c.name);
  // LITERAL known tokens (roster naam/alias ke exact tokens + detected JSON ke naam) — folded variants yahan NAHI, wo nearMatches mein jaate hain
  const known = new Set();
  const addKnown = (s) => { const n = normName(s); if (!n) return; known.add(n); for (const t of nameTokens(n)) if (t.length >= 3) known.add(t); };
  for (const c of rosterList) { addKnown(c.name); for (const a of String(c.aliases || '').split(',')) addKnown(a); }
  for (const d of detected || []) if (d && d.name) addKnown(d.name);
  const isKnownRun = (run) => {
    const n = normName(run);
    if (known.has(n)) return true;
    const toks = nameTokens(splitTitles(n).core || n);
    const sig = toks.filter((t) => !GENERIC_WORDS.has(t) && !TITLE_WORDS.has(t) && !SENTENCE_STARTERS.has(t));
    return sig.length > 0 && sig.every((t) => known.has(t));
  };

  const counts = new Map(); // norm → { name, count, inLabel }
  const bump = (run, inLabel) => {
    const n = normName(run);
    if (!n) return;
    const cur = counts.get(n) || { name: run.trim(), count: 0, inLabel: false };
    cur.count++; if (inLabel) cur.inLabel = true;
    counts.set(n, cur);
  };
  // "Tabhi Shin Jihyuk" → sentence-start lafz run se alag karo
  const trimRun = (run) => {
    let words = run.trim().split(/\s+/);
    while (words.length > 1 && SENTENCE_STARTERS.has(normName(words[0]))) words = words.slice(1);
    return words.join(' ');
  };
  const scanProse = (prose) => {
    for (const raw of capRuns(prose)) {
      const run = trimRun(raw);
      const toks = nameTokens(normName(run));
      if (!toks.length) continue;
      if (toks.length === 1 && (SENTENCE_STARTERS.has(toks[0]) || GENERIC_WORDS.has(toks[0]) || TITLE_WORDS.has(toks[0]))) continue;
      const idx = prose.indexOf(raw);
      const before = prose.slice(0, idx).trim();
      const sentenceStart = !before || /[.!?:"…]$/.test(before);
      if (toks.length === 1 && !/-/.test(run) && sentenceStart && run === raw) continue; // sentence ke shuru ka aam lafz
      bump(run, false);
    }
  };
  for (const line of text.split('\n')) {
    if (/^\s*-{2,}\s*\[/.test(line)) continue; // image marker
    const lm = line.match(/^\s*"([^"\n]{3,160})"\s*:\s*(.*)$/);
    if (lm) {
      const lead = (lm[1].match(/^[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)*/u) || [''])[0];
      if (lead) {
        const toks = nameTokens(normName(lead));
        const core = toks.filter((t) => !TITLE_WORDS.has(t) && !SENTENCE_STARTERS.has(t) && !GENERIC_WORDS.has(t));
        if (core.length) bump(lead, true);
      }
      scanProse(lm[2]); // bolne wali baat ke andar bhi naam hote hain
      continue;
    }
    scanProse(line);
  }

  const unknown = [], nearMatches = [];
  for (const [n, info] of counts) {
    if (isKnownRun(info.name)) continue;
    const toks = nameTokens(splitTitles(n).core || n);
    const units = (splitTitles(n).core || n).split(/\s+/).filter(Boolean); // hyphen wala lafz ek unit ("Be-dam", "Young-ryung")
    // Stutter: "J-ji", "L-lekin", "Y-ye"
    if (units.length === 1 && /^([a-z]{1,2})-\1/.test(units[0])) continue;
    // Ek baar aaya hua single word (label mein bhi — merge ke baad labels "Apne…", "Be-dam…" se shuru hote hain) — shor
    if (units.length < 2 && info.count < 2) continue;
    // "Turtle Breathing Technique", "Heavenly Demon Art" — English lafz wali technique/khitaab, character nahi (speaker label ho toh phir bhi dekho)
    if (!info.inLabel && toks.some((t) => /(ing|tion|sion|ique|ness|ful|ous|ly|ment|ity|ance|ence)$/.test(t) && t.length >= 5)) continue;
    if (toks.length > 4) continue;
    const r = matchCharacterDetailed(rosterList, info.name);
    if (r.match && r.kind !== 'exact') nearMatches.push({ found: info.name, roster: r.match.name, count: info.count, kind: r.kind });
    else if (!r.generic) unknown.push({ name: info.name, count: info.count, inLabel: info.inLabel });
  }
  // JSON mein hai lekin script ka koi run is naam par resolve nahi hota (exact/alias/fold/subset) → shayad ghalat pehchaan ya skip
  const runs = [...counts.values()].map((v) => v.name);
  const jsonOnly = (detected || []).filter((d) => d && d.name && !isGenericName(d.name)).map((d) => d.name)
    .filter((nm) => !runs.some((run) => matchCharacterDetailed([{ name: nm, aliases: '' }], run).match));
  unknown.sort((a, b) => b.count - a.count);
  nearMatches.sort((a, b) => b.count - a.count);
  return { unknown, nearMatches, jsonOnly };
}

// Roster mein placeholder look ("not yet shown", "hooded") — baad ki asli detection isse overwrite kar sakti hai
const PLACEHOLDER_LOOK_RE = /\b(not (yet )?(shown|seen|revealed)|unclear|unknown|hooded|masked|face hidden|silhouette|shadowy|shadow only|only mentioned|mentioned only|off-?screen|no clear look|not visible)\b/i;

/** look se kapde/jewellery/moods/temporary states hatao — sirf permanent hulia bache. */
const LOOK_DROP_RE = /\b(wearing|wears|dressed|robe|robes|hanbok|cloak|armou?r|uniform|outfit|clothes|clothing|garment|dress|tunic|coat|jacket|hat|helmet|mask|hairpin|earring|earrings|necklace|bracelet|ring|sword|blade|spear|bow|dagger|weapon|carrying|holding|smug|sly|angry|crying|smiling|smirk|smirking|expression|mood|wounded|bleeding|blood|bloody|muddy|mud|wet|soaked|tears|bandage|bandaged|glowing|torn|dirty|bruised)\b/i;
function sanitiseLook(look) {
  const parts = String(look || '').split(/[,;]+|\band\b|\bwith\b/i).map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => !LOOK_DROP_RE.test(p));
  return kept.join(', ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

module.exports = {
  normName, splitTitles, nameTokens, romKey, fusedKey, isGenericName, isContiguousSubset,
  matchCharacter, matchCharacterDetailed, cleanAlias, damerauLevenshtein,
  mergeClauses, clausesUpTo, splitClauses, splitTag,
  canonicalizeNamesInText, auditNames, sanitiseLook, PLACEHOLDER_LOOK_RE,
  TITLE_WORDS, GENERIC_WORDS,
};
