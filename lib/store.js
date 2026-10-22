// SQLite store (Node ka built-in node:sqlite — koi native compile nahi, koi Visual Studio nahi)
const fs = require('fs');
const path = require('path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('\n  ❌ This app needs Node.js v22.13 or newer (Node 24 recommended).');
  console.error('  Check your version: node --version\n');
  process.exit(1);
}

// MANHWA_DATA_DIR env = alag data folder (tests ke liye scratch DB — asli data/app.db ko haath na lage)
const DATA_DIR = process.env.MANHWA_DATA_DIR ? path.resolve(process.env.MANHWA_DATA_DIR) : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const OLD_JSON = path.join(DATA_DIR, 'db.json');
const OLD_SETTINGS = path.join(DATA_DIR, 'settings.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');

// node:sqlite mein better-sqlite3 jaisa transaction helper nahi hota — apna bana lo.
// Reentrant: runTx ke andar runTx (merge → updateCharacter) sirf outer transaction mein shaamil ho jaata hai.
let txDepth = 0;
function runTx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN');
  txDepth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'manhwa',
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    images TEXT NOT NULL DEFAULT '[]',
    narration TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'empty',
    error TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );
  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '',
    look TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    relationships TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    candidate_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS key_usage (
    day TEXT NOT NULL,
    key_id TEXT NOT NULL,
    model TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key_id, model)
  );
  CREATE TABLE IF NOT EXISTS chapter_media (
    chapter_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    audio_json TEXT NOT NULL DEFAULT '',
    audio_hash TEXT NOT NULL DEFAULT '',
    audio_sec REAL NOT NULL DEFAULT 0,
    video_hash TEXT NOT NULL DEFAULT '',
    video_sec REAL NOT NULL DEFAULT 0,
    has_video INTEGER NOT NULL DEFAULT 0,
    tts_model TEXT NOT NULL DEFAULT '',
    voice TEXT NOT NULL DEFAULT '',
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id);
  CREATE INDEX IF NOT EXISTS idx_characters_project ON characters(project_id);
  CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage(createdAt);
`);

// Chapters: flags (JSON) — e.g. Gemini ne images mein site watermark dekha
try { db.exec("ALTER TABLE chapters ADD COLUMN flags TEXT NOT NULL DEFAULT ''"); } catch {}

// Projects: source info (author, official platform, URL) — credits/description ke liye
for (const col of ['author', 'platform', 'official_url']) {
  try { db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`); } catch {}
}

function updateProjectInfo(pid, { name, author, platform, official_url }) {
  const cur = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
  if (!cur) return null;
  db.prepare('UPDATE projects SET name = ?, author = ?, platform = ?, official_url = ? WHERE id = ?').run(
    ((name || '').trim() || cur.name), (author || '').trim(), (platform || '').trim(), (official_url || '').trim(), pid
  );
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
}

// Purani DB (v17 se pehle) mein relationships column nahi hai — safe migration
try {
  db.exec("ALTER TABLE characters ADD COLUMN relationships TEXT NOT NULL DEFAULT ''");
} catch {} // column pehle se hai — theek hai
// v1.21: kapde alag column mein — `look` sirf permanent hulia (chehra/baal/nishaan), `outfits` har chapter ke kapde
try {
  db.exec("ALTER TABLE characters ADD COLUMN outfits TEXT NOT NULL DEFAULT ''");
} catch {}
// v1.22: character audit ke baad —
//  status (alive/dead/missing/unknown), notes ("kaise pehchanein / kis se farq"), pronounce ("say as" TTS ke liye),
//  look_source ('ai' | 'user' — user ka likha look AI kabhi overwrite nahi karta), first_seen / source_chapter_id (provenance:
//  chapter delete → us chapter ke auto-added, un-edited characters bhi jaate hain), pending (0/1 — unnamed/guess, roster block mein naam ke taur par nahi),
//  edited (user ne haath lagaya), updatedAt
for (const col of ['status', 'notes', 'pronounce', 'look_source', 'first_seen', 'source_chapter_id', 'updatedAt']) {
  try { db.exec(`ALTER TABLE characters ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`); } catch {}
}
for (const col of ['pending', 'edited']) {
  try { db.exec(`ALTER TABLE characters ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`); } catch {}
}
// Tombstones: user ne jo character/alias delete kiya, agla Generate use dobara add na kare
db.exec(`CREATE TABLE IF NOT EXISTS character_ignores (
  project_id TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  PRIMARY KEY (project_id, name_norm)
)`);
// Chapters: notes (sirf is chapter ke liye hidayaat), narration_images (script kin images par likhi gayi — baad mein images badlein toh warning),
// prev_narration (Regenerate se pehle wali script — "Restore previous" ke liye)
for (const col of ['notes', 'narration_images', 'prev_narration']) {
  try { db.exec(`ALTER TABLE chapters ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`); } catch {}
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- One-time migration from old JSON files ----------
(function migrateFromJson() {
  try {
    const count = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
    if (count === 0 && fs.existsSync(OLD_JSON)) {
      const old = JSON.parse(fs.readFileSync(OLD_JSON, 'utf8'));
      const insP = db.prepare(
        'INSERT INTO projects (id, name, type, createdAt) VALUES (?, ?, ?, ?)'
      );
      const insC = db.prepare(
        `INSERT INTO chapters (id, project_id, number, title, images, narration, status, error, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      runTx(() => {
        for (const p of old.projects || []) {
          insP.run(p.id, p.name, p.type || 'manhwa', p.createdAt || new Date().toISOString());
          (p.chapters || []).forEach((c, i) => {
            insC.run(
              c.id, p.id, c.number || i + 1, c.title || `Chapter ${i + 1}`,
              JSON.stringify(c.images || []), c.narration || '',
              c.status || 'empty', c.error || '', c.createdAt || new Date().toISOString()
            );
          });
        }
      });
      fs.renameSync(OLD_JSON, OLD_JSON + '.migrated');
      console.log('  Old db.json migrated to SQLite ✅');
    }
    if (fs.existsSync(OLD_SETTINGS)) {
      const s = JSON.parse(fs.readFileSync(OLD_SETTINGS, 'utf8'));
      const set = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
      for (const [k, v] of Object.entries(s)) if (typeof v === 'string') set.run(k, v);
      fs.renameSync(OLD_SETTINGS, OLD_SETTINGS + '.migrated');
    }
  } catch (err) {
    console.error('Migration warning:', err.message);
  }
})();

// ---------- Helpers ----------
function rowToChapter(row) {
  if (!row) return null;
  let flags = {};
  try { flags = row.flags ? JSON.parse(row.flags) : {}; } catch { flags = {}; }
  let narrationImages = null; // null = purani script (pata nahi kin images par likhi thi)
  try { narrationImages = row.narration_images ? JSON.parse(row.narration_images) : null; } catch { narrationImages = null; }
  return { ...row, images: JSON.parse(row.images || '[]'), flags, notes: row.notes || '', narrationImages, prevNarration: row.prev_narration || '' };
}

// ---------- Projects ----------
function listProjects() {
  const projects = db.prepare('SELECT * FROM projects ORDER BY createdAt DESC').all();
  const chCount = db.prepare(
    'SELECT COUNT(*) AS n FROM chapters WHERE project_id = ?'
  );
  return projects.map((p) => ({ ...p, chapters: { length: chCount.get(p.id).n } }));
}

function createProject({ name, type }) {
  const project = {
    id: newId(),
    name: name.trim(),
    type: type || 'manhwa',
    createdAt: new Date().toISOString(),
  };
  db.prepare('INSERT INTO projects (id, name, type, createdAt) VALUES (?, ?, ?, ?)').run(
    project.id, project.name, project.type, project.createdAt
  );
  return project;
}

function getProject(pid) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
  if (!p) return null;
  const chapters = db
    .prepare('SELECT * FROM chapters WHERE project_id = ? ORDER BY number ASC')
    .all(pid)
    .map(rowToChapter);
  const characters = listCharacters(pid);
  return { ...p, chapters, characters };
}

function deleteProject(pid) {
  runTx(() => {
    db.prepare('DELETE FROM chapters WHERE project_id = ?').run(pid);
    db.prepare('DELETE FROM characters WHERE project_id = ?').run(pid);
    db.prepare('DELETE FROM character_ignores WHERE project_id = ?').run(pid);
    db.prepare('DELETE FROM chapter_media WHERE project_id = ?').run(pid);
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
  });
}

// ---------- Chapters ----------
function createChapter(pid, { title }) {
  const p = db.prepare('SELECT id FROM projects WHERE id = ?').get(pid);
  if (!p) return null;
  const number =
    db.prepare('SELECT COALESCE(MAX(number), 0) AS m FROM chapters WHERE project_id = ?').get(pid).m + 1;
  const chapter = {
    id: newId(),
    project_id: pid,
    number,
    title: (title || '').trim() || `Chapter ${number}`,
    images: [],
    narration: '',
    status: 'empty',
    error: '',
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO chapters (id, project_id, number, title, images, narration, status, error, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    chapter.id, pid, chapter.number, chapter.title, '[]',
    '', chapter.status, '', chapter.createdAt
  );
  return chapter;
}

function getChapter(pid, cid) {
  return rowToChapter(
    db.prepare('SELECT * FROM chapters WHERE id = ? AND project_id = ?').get(cid, pid)
  );
}

function updateChapter(pid, cid, patch) {
  const current = getChapter(pid, cid);
  if (!current) return null;
  const next = { ...current, ...patch };
  db.prepare(
    `UPDATE chapters SET title = ?, images = ?, narration = ?, status = ?, error = ?, flags = ?, notes = ?, narration_images = ?, prev_narration = ?
     WHERE id = ? AND project_id = ?`
  ).run(
    next.title, JSON.stringify(next.images || []), next.narration || '',
    next.status || 'empty', next.error || '', JSON.stringify(next.flags || {}),
    next.notes || '', next.narrationImages ? JSON.stringify(next.narrationImages) : '', next.prevNarration || '',
    cid, pid
  );
  return next;
}

function deleteChapter(pid, cid) {
  const ch = getChapter(pid, cid);
  runTx(() => {
    db.prepare('DELETE FROM chapters WHERE id = ? AND project_id = ?').run(cid, pid);
    if (ch) forgetChapterCharacters(pid, ch); // is chapter ke auto-added (un-edited) characters aur tagged clauses bhi jaayein
  });
}

// ---------- Characters ----------
// Naam ka saara "dimaag" (normalise, romanization folding, ambiguity-guarded matcher, generic detection, clause merge) lib/names.js mein hai.
const N = require('./names');
const CHAR_COLS = ['name', 'aliases', 'look', 'role', 'relationships', 'outfits', 'status', 'notes', 'pronounce', 'look_source', 'first_seen', 'source_chapter_id'];
const splitAliases = (s) => String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
function joinAliases(list) {
  const out = [], seen = new Set();
  for (const a of list) { const k = N.normName(a); if (k && !seen.has(k)) { seen.add(k); out.push(a.trim()); } }
  return out.slice(0, 12).join(', ');
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function listCharacters(pid) {
  return db
    .prepare('SELECT * FROM characters WHERE project_id = ? ORDER BY createdAt ASC')
    .all(pid);
}
const getCharacter = (pid, chid) => db.prepare('SELECT * FROM characters WHERE id = ? AND project_id = ?').get(chid, pid) || null;

// Tombstones (user ne delete kiya → dobara auto-add nahi)
function isIgnored(pid, name) {
  const n = N.normName(name);
  return !!(n && db.prepare('SELECT 1 FROM character_ignores WHERE project_id = ? AND name_norm = ?').get(pid, n));
}
function forgetIgnore(pid, name) {
  const n = N.normName(name);
  if (n) db.prepare('DELETE FROM character_ignores WHERE project_id = ? AND name_norm = ?').run(pid, n);
}

/**
 * @param {object} fields name, aliases, look, role, relationships, outfits, status, notes, pronounce, first_seen, source_chapter_id, pending
 * @param {object} [opts] manual=true (user ne add kiya → edited, look_source 'user', tombstone hat jaata hai), source 'ai'|'user'
 * Same naam pehle se ho toh wahi row wapas (duplicate row kabhi nahi banti).
 */
function addCharacter(pid, fields, opts = {}) {
  const name = String(fields.name || '').trim();
  if (!name) return null;
  const dup = listCharacters(pid).find((c) => N.normName(c.name) === N.normName(name));
  if (dup) return dup;
  if (opts.manual) forgetIgnore(pid, name);
  const now = new Date().toISOString();
  const character = {
    id: newId(), project_id: pid, name,
    aliases: joinAliases(splitAliases(fields.aliases).filter((a) => N.normName(a) !== N.normName(name))),
    look: String(fields.look || '').trim(), role: String(fields.role || '').trim(),
    relationships: String(fields.relationships || '').trim(), outfits: String(fields.outfits || '').trim(),
    status: String(fields.status || 'alive').trim(), notes: String(fields.notes || '').trim(), pronounce: String(fields.pronounce || '').trim(),
    look_source: opts.manual ? 'user' : (opts.source || 'ai'),
    first_seen: String(fields.first_seen || '').trim(), source_chapter_id: String(fields.source_chapter_id || '').trim(),
    pending: fields.pending ? 1 : 0, edited: opts.manual ? 1 : 0, updatedAt: now, createdAt: now,
  };
  db.prepare(
    `INSERT INTO characters (id, project_id, ${CHAR_COLS.join(', ')}, pending, edited, updatedAt, createdAt)
     VALUES (?, ?, ${CHAR_COLS.map(() => '?').join(', ')}, ?, ?, ?, ?)`
  ).run(character.id, pid, ...CHAR_COLS.map((k) => character[k]), character.pending, character.edited, now, now);
  return character;
}

/**
 * Field-level PATCH (sirf diye gaye keys badalte hain — purane form ka save doosre fields nahi udaata).
 * Naam badla → purana naam alias ban jaata hai aur doosre characters ke rishton mein bhi naya naam (cascade).
 * opts.manual=true → edited=1, look badla toh look_source='user'.
 */
function updateCharacter(pid, chid, patch, opts = {}) {
  const cur = getCharacter(pid, chid);
  if (!cur) return null;
  const next = { ...cur };
  for (const k of CHAR_COLS) if (patch[k] !== undefined && patch[k] !== null) next[k] = String(patch[k]).trim();
  if (patch.pending !== undefined) next.pending = patch.pending ? 1 : 0;
  if (!next.name) return null; // khaali naam reject
  const renamed = N.normName(next.name) !== N.normName(cur.name);
  let aliases = splitAliases(next.aliases);
  if (renamed) aliases.push(cur.name);
  const others = listCharacters(pid).filter((c) => c.id !== chid);
  aliases = aliases.filter((a) => N.normName(a) !== N.normName(next.name) && !others.some((o) => N.normName(o.name) === N.normName(a))); // alias ≠ apna/kisi aur ka naam
  next.aliases = joinAliases(aliases);
  if (opts.manual) { next.edited = 1; if (patch.look !== undefined && String(patch.look).trim() !== cur.look) next.look_source = 'user'; }
  next.updatedAt = new Date().toISOString();
  runTx(() => {
    db.prepare(
      `UPDATE characters SET ${CHAR_COLS.map((k) => `${k} = ?`).join(', ')}, pending = ?, edited = ?, updatedAt = ? WHERE id = ? AND project_id = ?`
    ).run(...CHAR_COLS.map((k) => next[k]), next.pending ? 1 : 0, next.edited ? 1 : 0, next.updatedAt, chid, pid);
    if (renamed) cascadeRename(pid, cur.name, next.name, chid);
  });
  return next;
}

/** Doosre characters ke relationships/notes mein purana naam → naya naam */
function cascadeRename(pid, oldName, newName, exceptId) {
  if (!oldName || !newName || N.normName(oldName) === N.normName(newName)) return;
  const re = new RegExp(`(^|[^\\p{L}])${escapeRe(oldName)}(?=$|[^\\p{L}])`, 'giu');
  for (const c of listCharacters(pid)) {
    if (c.id === exceptId) continue;
    const rel = (c.relationships || '').replace(re, `$1${newName}`), notes = (c.notes || '').replace(re, `$1${newName}`);
    if (rel !== c.relationships || notes !== c.notes) db.prepare('UPDATE characters SET relationships = ?, notes = ? WHERE id = ?').run(rel, notes, c.id);
  }
}

/** Delete + tombstone (naam aur aliases) — agla Generate ise dobara add nahi karega. forget=false → sirf delete. */
function deleteCharacter(pid, chid, { forget = true } = {}) {
  const cur = getCharacter(pid, chid);
  if (!cur) return;
  runTx(() => {
    db.prepare('DELETE FROM characters WHERE id = ? AND project_id = ?').run(chid, pid);
    if (forget) {
      const ins = db.prepare('INSERT OR IGNORE INTO character_ignores (project_id, name_norm) VALUES (?, ?)');
      for (const nm of [cur.name, ...splitAliases(cur.aliases)]) { const n = N.normName(nm); if (n) ins.run(pid, n); }
    }
  });
}

/** Do rows ek: keep mein drop ka naam+aliases, rishte, outfits; drop delete; doosre rows mein drop ka naam → keep ka naam. */
function mergeCharacters(pid, keepId, dropId) {
  const keep = getCharacter(pid, keepId), drop = getCharacter(pid, dropId);
  if (!keep || !drop || keepId === dropId) return null;
  const roster = listCharacters(pid).filter((c) => c.id !== dropId);
  const canon = (s) => N.canonicalizeNamesInText(s, roster, { expandShort: true });
  let outfits = keep.outfits || '';
  for (const o of N.splitClauses(drop.outfits)) outfits = addOutfit(outfits, o);
  const patch = {
    aliases: joinAliases([...splitAliases(keep.aliases), drop.name, ...splitAliases(drop.aliases)]),
    look: keep.look || drop.look, role: keep.role || drop.role, pronounce: keep.pronounce || drop.pronounce,
    status: keep.status && keep.status !== 'alive' ? keep.status : (drop.status || keep.status),
    notes: [keep.notes, drop.notes].filter(Boolean).join('; '),
    relationships: N.mergeClauses(keep.relationships, drop.relationships, { max: 400, canon }),
    outfits, pending: 0,
  };
  let out = null;
  runTx(() => {
    db.prepare('DELETE FROM characters WHERE id = ? AND project_id = ?').run(dropId, pid);
    out = updateCharacter(pid, keepId, patch, { manual: true });
    cascadeRename(pid, drop.name, keep.name, keepId);
  });
  return out;
}

/** Chapter delete → us chapter ke auto-added (kabhi edit na hue) characters hat jaate hain, aur "Title: …" tagged clauses bhi. */
function forgetChapterCharacters(pid, chapter) {
  const title = chapter.title || '';
  for (const c of listCharacters(pid)) {
    if (c.source_chapter_id && c.source_chapter_id === chapter.id && !c.edited) {
      db.prepare('DELETE FROM characters WHERE id = ?').run(c.id);
      continue;
    }
    if (!title) continue;
    const strip = (s) => N.splitClauses(s).filter((cl) => N.splitTag(cl).tag !== title).join('; ');
    const rel = strip(c.relationships), outf = strip(c.outfits);
    if (rel !== c.relationships || outf !== c.outfits) db.prepare('UPDATE characters SET relationships = ?, outfits = ? WHERE id = ?').run(rel, outf, c.id);
  }
}

/** Sequel/season 2 ke liye: doosre project ka roster copy (jo naam pehle se match karte hain wo skip). */
function copyCharacters(fromPid, toPid) {
  const src = listCharacters(fromPid).filter((c) => !c.pending);
  let copied = 0;
  runTx(() => {
    for (const c of src) {
      if (N.matchCharacter(listCharacters(toPid), c.name)) continue;
      const row = addCharacter(toPid, { ...c, first_seen: '', source_chapter_id: '' }, { manual: true, source: c.look_source || 'ai' });
      if (row) copied++;
    }
  });
  return copied;
}

// Outfits: "Chapter 3: red armour; Chapter 5: black cloak" — wahi kapde dobara na likho, purane giren (naya kabhi nahi kat-ta)
function addOutfit(cur, entry) {
  const list = N.splitClauses(cur);
  const bare = (e) => N.normName(N.splitTag(e).text);
  if (!entry || list.some((x) => bare(x) === bare(entry))) return list.join('; ');
  list.push(entry);
  while (list.length > 6 || list.join('; ').length > 500) { if (list.length <= 1) break; list.shift(); }
  return list.join('; ');
}

const asText = (v) => (typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean).join(', ') : typeof v === 'boolean' || typeof v === 'number' ? String(v) : '');
/** Gemini ke JSON entry ko saaf shape mein (keys lowercase, arrays → text, synonyms) */
function normaliseEntry(raw) {
  const o = {};
  let nameExtra = [];
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (key === 'name' && Array.isArray(v)) { const list = v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean); o.name = list[0] || ''; nameExtra = list.slice(1); continue; } // ["Ha Hyeon","Hyeon"] → naam + aliases
    o[key] = asText(v);
  }
  const role = (o.role || '').toLowerCase();
  return {
    name: (o.name || o.charactername || '').slice(0, 80),
    look: (o.look || o.appearance || '').slice(0, 300),
    outfit: (o.outfit || o.outfits || o.clothes || o.clothing || '').slice(0, 120),
    role: /hero|protagonist|mc\b|main/.test(role) ? 'hero' : /villain|antagonist|enemy/.test(role) ? 'villain' : role ? 'side' : '',
    relationships: (o.relationships || o.relationship || o.relations || o.ties || '').slice(0, 300),
    titles: [...nameExtra, ...splitAliases(o.titles || o.epithets || o.nicknames || o.aliases || '')],
    sameAs: (o.sameas || o.rostername || '').slice(0, 80),
    unnamed: /^(true|yes|1)$/i.test(o.unnamed || ''),
    guess: /guess|low|unsure|maybe|uncertain|probab/i.test(o.confidence || ''),
    mentioned: /mention/i.test(o.seen || ''),
    status: /dead|died|deceased|killed/.test((o.status || '').toLowerCase()) ? 'dead' : /alive|living/.test((o.status || '').toLowerCase()) ? 'alive' : '',
  };
}
const tokenJaccard = (a, b) => {
  const A = new Set(N.normName(a).split(/\W+/).filter((w) => w.length > 2)), B = new Set(N.normName(b).split(/\W+/).filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
};

/**
 * Gemini ke per-chapter JSON ko roster mein merge karo — transaction mein, kabhi crash par aadha nahi.
 *  - naam resolve: lib/names matcher (exact → alias → folded spelling → short form → typo), ambiguous = koi match nahi, add bhi nahi (report)
 *  - generic/unnamed/guess ("Masked Man", "Hyeon ki ammi", confidence:guess) → roster mein NAHI, `pending` list mein (UI dikhaati hai)
 *  - look: khaali ya placeholder ("not yet shown") ho toh bharta hai; user ka likha kabhi nahi badalta; bada farq → conflicts
 *  - relationships: clause merge (paraphrase dedupe, naya rishta purane ko replace, chapter tag), naam canonicalise
 *  - alias sirf asal variant spellings/titles (short forms nahi), doosre character ke naam se takraaye toh nahi
 *  - 1-lafz AI-created row ("Hyeon") + detected poora naam ("Ha Hyeon") → row ka naam promote
 * @param {{id?:string,title?:string}|string} chapter
 */
function mergeDetectedCharacters(pid, detected, chapter = {}) {
  const chapterTitle = typeof chapter === 'string' ? chapter : (chapter.title || '');
  const chapterId = typeof chapter === 'string' ? '' : (chapter.id || '');
  const result = { added: 0, updated: 0, pending: [], ambiguous: [], conflicts: [], skipped: [], learned: [] };
  if (!Array.isArray(detected)) return result;
  runTx(() => {
    const existing = listCharacters(pid);
    const roster = () => existing.filter((c) => !c.pending);
    const canon = (s) => N.canonicalizeNamesInText(s, roster(), { expandShort: true });
    for (const raw of detected) {
      if (!raw || typeof raw !== 'object') continue;
      const d = normaliseEntry(raw);
      const name = d.name;
      if (!name) continue;
      const look = N.sanitiseLook(d.look);
      const outfitEntry = d.outfit ? (chapterTitle ? `${chapterTitle}: ${d.outfit}` : d.outfit) : '';
      if (isIgnored(pid, name)) { result.skipped.push({ name, reason: 'deleted by you earlier' }); continue; }

      let r = d.sameAs ? N.matchCharacterDetailed(roster(), d.sameAs) : { match: null, kind: null, ambiguous: [], generic: false };
      if (!r.match) r = N.matchCharacterDetailed(roster(), name);
      if (!r.match && r.ambiguous.length) { result.ambiguous.push({ name, candidates: r.ambiguous }); continue; }
      const isGuess = d.unnamed || d.guess || r.generic || N.isGenericName(name);

      let match = r.match;
      if (!match) {
        if (isGuess) { result.pending.push({ name, look, outfit: d.outfit, relationships: d.relationships, reason: d.unnamed ? 'unnamed' : d.guess ? 'guess' : 'descriptive name' }); continue; }
        // Roster mein sirf "Hyeon" (AI ne banaya) aur ab "Ha Hyeon" aaya → wahi character, poora naam promote
        const fuller = roster().filter((c) => !c.edited && N.nameTokens(N.normName(c.name)).length === 1 && N.isContiguousSubset(N.nameTokens(N.normName(c.name)), N.nameTokens(N.normName(name))));
        if (fuller.length === 1) {
          const promoted = updateCharacter(pid, fuller[0].id, { name }, { source: 'ai' });
          if (promoted) { Object.assign(fuller[0], promoted); match = fuller[0]; result.learned.push({ alias: fuller[0].aliases, roster: name }); }
        }
      }
      if (!match) {
        const created = addCharacter(pid, {
          name, look, role: d.role, outfits: outfitEntry, aliases: d.titles.map((t) => N.cleanAlias(t, name)).filter(Boolean),
          relationships: d.relationships ? N.mergeClauses('', d.relationships, { max: 400, canon, tag: chapterTitle }) : '',
          status: d.status || 'alive', first_seen: chapterTitle, source_chapter_id: chapterId,
        }, { source: 'ai' });
        if (created && !existing.some((c) => c.id === created.id)) { existing.push(created); result.added++; }
        continue;
      }
      if (isGuess || d.mentioned) {
        // Jaana-pehchaana character lekin pehchaan pakki nahi / sirf zikr — roster ko haath nahi, suggestion dikhao
        result.pending.push({ name, suggestedRoster: match.name, look, outfit: d.outfit, relationships: d.relationships, reason: d.mentioned ? 'mentioned only' : 'guess' });
        continue;
      }
      const patch = {};
      if (look && (!match.look || (match.look_source !== 'user' && N.PLACEHOLDER_LOOK_RE.test(match.look)))) patch.look = look;
      else if (look && match.look && tokenJaccard(look, match.look) < 0.25) result.conflicts.push({ name: match.name, stored: match.look, detected: look, chapter: chapterTitle });
      if (d.role && !match.role) patch.role = d.role;
      if (d.status === 'dead' && match.status !== 'dead' && !match.edited) patch.status = 'dead';
      if (d.relationships) { const rel = N.mergeClauses(match.relationships, d.relationships, { max: 400, canon, tag: chapterTitle }); if (rel !== match.relationships) patch.relationships = rel; }
      if (outfitEntry) { const outf = addOutfit(match.outfits, outfitEntry); if (outf !== match.outfits) patch.outfits = outf; }
      const learn = [name, ...d.titles].map((t) => N.cleanAlias(t, match.name)).filter(Boolean);
      if (learn.length) {
        const aliases = joinAliases([...splitAliases(match.aliases), ...learn]);
        if (aliases !== match.aliases) { patch.aliases = aliases; result.learned.push({ alias: learn.join(', '), roster: match.name }); }
      }
      if (match.pending) patch.pending = 0;
      if (Object.keys(patch).length) {
        const next = updateCharacter(pid, match.id, patch, { source: 'ai' });
        if (next) { Object.assign(match, next); result.updated++; }
      }
    }
  });
  return result;
}
const matchCharacter = N.matchCharacter;

// ---------- Chapter media (purani v1.20 voiceover/video rows — sirf chapter delete par saaf hoti hain) ----------
function deleteMedia(cid) {
  db.prepare('DELETE FROM chapter_media WHERE chapter_id = ?').run(cid);
}

// ---------- Token Usage ----------
function recordTokenUsage(pid, cid, { promptTokens, candidateTokens, totalTokens }, model) {
  db.prepare(
    `INSERT INTO token_usage (id, project_id, chapter_id, prompt_tokens, candidate_tokens, total_tokens, model, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId(), pid, cid, promptTokens, candidateTokens, totalTokens, model || '', new Date().toISOString());
}

function getTokenStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayStr = todayStart.toISOString();

  const today = db.prepare(
    `SELECT COALESCE(SUM(total_tokens),0) AS tokens, COUNT(*) AS requests
     FROM token_usage WHERE createdAt >= ?`
  ).get(todayStr);

  const allTime = db.prepare(
    `SELECT COALESCE(SUM(total_tokens),0) AS tokens, COUNT(*) AS requests FROM token_usage`
  ).get();

  const recent = db.prepare(
    `SELECT t.total_tokens, t.prompt_tokens, t.candidate_tokens, t.model, t.createdAt,
            c.title AS chapter_title, p.name AS project_name
     FROM token_usage t
     LEFT JOIN chapters c ON c.id = t.chapter_id
     LEFT JOIN projects p ON p.id = t.project_id
     ORDER BY t.createdAt DESC LIMIT 5`
  ).all();

  return {
    today: { tokens: today.tokens, requests: today.requests },
    allTime: { tokens: allTime.tokens, requests: allTime.requests },
    recent,
  };
}

// ---------- Prompt (file-based) ----------
// Prompt ek proper file mein rehta hai aur HAR generate par fresh read hota hai,
// taake tum file ko kisi bhi editor mein badal sako — restart ki zaroorat nahi.
const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const PROMPT_FILE = path.join(PROMPTS_DIR, 'narration-prompt.md');
const DEFAULT_PROMPT_FILE = path.join(PROMPTS_DIR, 'default-prompt.md');
const PROMPT_FILE_LABEL = 'prompts/narration-prompt.md';

const FALLBACK_PROMPT =
  'Convert the attached manhwa chapter images (in order) into a continuous high-energy Roman Urdu YouTube voiceover script. Retell everything in your own words. Use [NARRATION] blocks and ### [CHARACTER / DIALOGUE] headings.';

function getDefaultPrompt() {
  try {
    const t = fs.readFileSync(DEFAULT_PROMPT_FILE, 'utf8');
    if (t.trim()) return t;
  } catch {}
  return FALLBACK_PROMPT;
}

// Pehli baar: active prompt file banao (purane DB prompt ko migrate karo agar tha)
(function ensurePromptFile() {
  try {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
    if (!fs.existsSync(PROMPT_FILE)) {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'prompt'").get();
      const seed = row && row.value && row.value.trim() ? row.value : getDefaultPrompt();
      fs.writeFileSync(PROMPT_FILE, seed);
      if (row) db.prepare("DELETE FROM settings WHERE key = 'prompt'").run();
    }
  } catch (err) {
    console.error('Prompt file warning:', err.message);
  }
})();

function getPrompt() {
  try {
    const t = fs.readFileSync(PROMPT_FILE, 'utf8');
    if (t.trim()) return t;
  } catch {}
  return getDefaultPrompt();
}

function savePrompt(text) {
  const content = (text || '').trim() ? text : getDefaultPrompt();
  fs.writeFileSync(PROMPT_FILE, content);
}

// ---------- Settings ----------
const DEFAULT_TTS_STYLE = "Energetic male Hindi YouTube manhwa recap narrator. Fast but clear pace, confident tone, extra excitement on fight scenes, short pauses between sentences. Natural Indian Hindi accent, casual and conversational, not like a news reader.";

function clampFloat(v, min, max, dflt) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}


function parseKeys(raw) {
  return (raw || '')
    .split(/\r?\n|,/)
    .map((k) => k.trim())
    .filter((k) => k.length >= 10);
}

function maskKey(key) {
  return '…' + key.slice(-6);
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  // Back-compat: purani single apiKey ya env var bhi list mein aa jaye
  let keys = parseKeys(s.apiKeys);
  if (!keys.length && s.apiKey) keys = parseKeys(s.apiKey);
  if (!keys.length && process.env.GEMINI_API_KEY) keys = parseKeys(process.env.GEMINI_API_KEY);
  let activeKeyIndex = parseInt(s.activeKeyIndex || '0', 10);
  if (!Number.isInteger(activeKeyIndex) || activeKeyIndex < 0 || activeKeyIndex >= keys.length) {
    activeKeyIndex = 0;
  }
  return {
    apiKeys: s.apiKeys || s.apiKey || '',
    keys,
    activeKeyIndex,
    dailyLimit: Math.max(1, parseInt(s.dailyLimit || '250', 10) || 250),
    model: migrateModel(s.model) || 'gemini-3.8-flash',
    prompt: getPrompt(), // har call par file se fresh read
    // ---- Script policy ----
    commentaryMode: s.commentaryMode === 'off' ? 'off' : 'on',
    // ---- Voiceover (TTS) ----
    ttsModel: s.ttsModel || 'gemini-3.8-flash-tts',
    ttsVoice: s.ttsVoice || 'en-us-zeno', // Zeno — Google ki nayi en-US character voice (male, cool/confident)
    ttsStyle: s.ttsStyle !== undefined ? s.ttsStyle : DEFAULT_TTS_STYLE,
    ttsTemperature: clampFloat(s.ttsTemperature, 0, 2, 1.1),
    ttsLanguage: s.ttsLanguage !== undefined ? s.ttsLanguage.trim() : 'en-US', // '' = auto-detect
    ttsDailyLimit: clampInt(s.ttsDailyLimit, 1, 100000, 10), // free tier: 10 TTS requests/day/key (Google ka 429 message, Oct 2026) — 1 request = 1 image
    // ---- Image Voices card (chapter page) — default chhupi; Settings mein switch, har baar secret number ----
    showVoicesCard: s.showVoicesCard === 'on' ? 'on' : 'off',
    hasVoicesPin: !!s.voicesPinHash,
  };
}

// ---------- Secret number (PIN) — Image Voices switch ke liye. Sirf salted scrypt hash save hota hai, PIN kabhi nahi ----------
const cryptoMod = require('crypto');
const hashPin = (pin, salt) => cryptoMod.scryptSync(String(pin), salt, 32).toString('hex');
function setVoicesPin(pin) {
  const salt = cryptoMod.randomBytes(8).toString('hex');
  saveSettings({ voicesPinHash: `${salt}:${hashPin(pin, salt)}` });
}
function verifyVoicesPin(pin) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'voicesPinHash'").get();
  if (!row || !row.value || !row.value.includes(':')) return false;
  const [salt, hash] = row.value.split(':');
  const got = Buffer.from(hashPin(pin || '', salt), 'hex'), want = Buffer.from(hash, 'hex');
  return got.length === want.length && cryptoMod.timingSafeEqual(got, want);
}

// Google ne gemini-2.5-pro naye users ke liye band kar diya (404 NOT_FOUND),
// aur pro-preview models free keys par chalte hi nahi (429) —
// purana saved model automatically free-friendly flash par map ho jaata hai.
const LEGACY_MODELS = {
  'gemini-2.5-pro': 'gemini-3.8-flash',
  'gemini-1.5-pro': 'gemini-3.8-flash',
  'gemini-1.5-flash': 'gemini-3.8-flash',
};
function migrateModel(model) {
  if (model && LEGACY_MODELS[model]) {
    const next = LEGACY_MODELS[model];
    try {
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(next);
      console.log(`  ⚠️ Model '${model}' was retired by Google — updated to '${next}'.`);
    } catch {}
    return next;
  }
  return model;
}

// ---------- Per-key daily request quota (Google ka free tier RESET: raat 12 baje Pacific time) ----------
function pacificDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function recordKeyRequest(keyId, model) {
  const day = pacificDay();
  db.prepare(
    `INSERT INTO key_usage (day, key_id, model, requests) VALUES (?, ?, ?, 1)
     ON CONFLICT(day, key_id, model) DO UPDATE SET requests = requests + 1`
  ).run(day, keyId, model || '');
  const row = db
    .prepare('SELECT requests FROM key_usage WHERE day = ? AND key_id = ? AND model = ?')
    .get(day, keyId, model || '');
  console.log(`  📈 Quota: ${keyId} → ${row ? row.requests : '?'} requests today (${model})`);
}

function getQuotaSummary() {
  const settings = getSettings();
  const day = pacificDay();
  const rows = db
    .prepare('SELECT key_id, SUM(requests) AS used FROM key_usage WHERE day = ? AND model = ? GROUP BY key_id')
    .all(day, settings.model);
  const usedMap = Object.fromEntries(rows.map((r) => [r.key_id, Number(r.used)]));
  // Aaj doosre models par bhi requests hui hon toh unka total (quota per-model hota hai)
  const otherRow = db
    .prepare('SELECT COALESCE(SUM(requests), 0) AS n FROM key_usage WHERE day = ? AND model != ?')
    .get(day, settings.model);
  const otherModelsToday = Number(otherRow.n);
  const keys = settings.keys.map((k, i) => {
    const id = maskKey(k);
    const used = usedMap[id] || 0;
    return {
      index: i,
      label: id,
      used,
      limit: settings.dailyLimit,
      remaining: Math.max(0, settings.dailyLimit - used),
      active: i === settings.activeKeyIndex,
    };
  });
  // TTS model ka alag quota (per-model limits)
  const ttsRows = db
    .prepare('SELECT key_id, SUM(requests) AS used FROM key_usage WHERE day = ? AND model = ? GROUP BY key_id')
    .all(day, settings.ttsModel);
  const ttsUsed = Object.fromEntries(ttsRows.map((r) => [r.key_id, Number(r.used)]));
  const ttsKeys = settings.keys.map((k, i) => {
    const id = maskKey(k);
    const used = ttsUsed[id] || 0;
    return { index: i, label: id, used, limit: settings.ttsDailyLimit, remaining: Math.max(0, settings.ttsDailyLimit - used) };
  });
  return {
    model: settings.model,
    dailyLimit: settings.dailyLimit,
    keys,
    totalRemaining: keys.reduce((sum, k) => sum + k.remaining, 0),
    tts: { model: settings.ttsModel, dailyLimit: settings.ttsDailyLimit, keys: ttsKeys, totalRemaining: ttsKeys.reduce((a, k) => a + k.remaining, 0) },
    otherModelsToday,
    note: 'Local estimate — exact limits are shown in the AI Studio dashboard. Resets at midnight Pacific time.',
  };
}

function saveSettings(patch) {
  const up = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  runTx(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === 'string') up.run(k, v);
      else if (typeof v === 'number') up.run(k, String(v));
    }
  });
}

module.exports = {
  listProjects,
  createProject,
  getProject,
  deleteProject,
  createChapter,
  getChapter,
  updateChapter,
  deleteChapter,
  listCharacters,
  addCharacter,
  updateCharacter,
  deleteCharacter,
  mergeDetectedCharacters,
  mergeCharacters,
  copyCharacters,
  getCharacter,
  matchCharacter,
  splitAliases,
  updateProjectInfo,
  deleteMedia,
  getSettings,
  saveSettings,
  setVoicesPin,
  verifyVoicesPin,
  getPrompt,
  savePrompt,
  getDefaultPrompt,
  PROMPT_FILE_LABEL,
  recordTokenUsage,
  getTokenStats,
  recordKeyRequest,
  getQuotaSummary,
  maskKey,
};
