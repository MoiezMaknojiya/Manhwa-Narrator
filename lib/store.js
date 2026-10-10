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

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const OLD_JSON = path.join(DATA_DIR, 'db.json');
const OLD_SETTINGS = path.join(DATA_DIR, 'settings.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');

// node:sqlite mein better-sqlite3 jaisa transaction helper nahi hota — apna bana lo
function runTx(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
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
  return { ...row, images: JSON.parse(row.images || '[]'), flags };
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
    `UPDATE chapters SET title = ?, images = ?, narration = ?, status = ?, error = ?, flags = ?
     WHERE id = ? AND project_id = ?`
  ).run(
    next.title, JSON.stringify(next.images || []), next.narration || '',
    next.status || 'empty', next.error || '', JSON.stringify(next.flags || {}), cid, pid
  );
  return next;
}

function deleteChapter(pid, cid) {
  db.prepare('DELETE FROM chapters WHERE id = ? AND project_id = ?').run(cid, pid);
}

// ---------- Characters ----------
function listCharacters(pid) {
  return db
    .prepare('SELECT * FROM characters WHERE project_id = ? ORDER BY createdAt ASC')
    .all(pid);
}

function addCharacter(pid, { name, aliases, look, role, relationships }) {
  const character = {
    id: newId(),
    project_id: pid,
    name: (name || '').trim(),
    aliases: (aliases || '').trim(),
    look: (look || '').trim(),
    role: (role || '').trim(),
    relationships: (relationships || '').trim(),
    createdAt: new Date().toISOString(),
  };
  if (!character.name) return null;
  db.prepare(
    'INSERT INTO characters (id, project_id, name, aliases, look, role, relationships, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    character.id, pid, character.name, character.aliases,
    character.look, character.role, character.relationships, character.createdAt
  );
  return character;
}

function updateCharacter(pid, chid, { name, aliases, look, role, relationships }) {
  db.prepare(
    'UPDATE characters SET name = ?, aliases = ?, look = ?, role = ?, relationships = ? WHERE id = ? AND project_id = ?'
  ).run(
    (name || '').trim(), (aliases || '').trim(), (look || '').trim(),
    (role || '').trim(), (relationships || '').trim(), chid, pid
  );
}

function deleteCharacter(pid, chid) {
  db.prepare('DELETE FROM characters WHERE id = ? AND project_id = ?').run(chid, pid);
}

/**
 * Merge characters that Gemini detected in a chapter into the project's roster.
 * Match by name OR alias (case-insensitive). New characters are added;
 * existing ones get their empty fields filled in (never overwriting user edits).
 */
function mergeDetectedCharacters(pid, detected) {
  if (!Array.isArray(detected)) return { added: 0, updated: 0 };
  const existing = listCharacters(pid);
  const norm = (s) => (s || '').trim().toLowerCase();
  const words = (s) => norm(s).split(/[\s-]+/).filter((w) => w.length >= 2);
  // "Hyeon" ⊂ "Ha Hyeon" — chhote naam ke saare words bade naam mein hon
  const isWordSubset = (a, b) => {
    const [shorter, longer] = words(a).length <= words(b).length ? [words(a), words(b)] : [words(b), words(a)];
    if (!shorter.length) return false;
    return shorter.every((w) => longer.includes(w));
  };
  const findMatch = (name) => {
    const n = norm(name);
    if (!n) return null;
    // 1. Exact naam ya alias match
    const exact = existing.find((c) => {
      if (norm(c.name) === n) return true;
      return c.aliases.split(',').map(norm).filter(Boolean).includes(n);
    });
    if (exact) return exact;
    // 2. Word-subset match (e.g. "Hyeon" -> "Ha Hyeon") — sirf jab EK hi candidate ho
    const candidates = existing.filter((c) => isWordSubset(name, c.name));
    return candidates.length === 1 ? candidates[0] : null;
  };

  let added = 0, updated = 0;
  for (const d of detected) {
    if (!d || typeof d !== 'object') continue;
    const name = (d.name || '').toString().trim();
    if (!name || name.length > 80) continue;
    const look = (d.look || '').toString().trim().slice(0, 300);
    const role = (d.role || '').toString().trim().slice(0, 60);
    const rel = (d.relationships || d.relationship || '').toString().trim().slice(0, 300);
    const match = findMatch(name);
    if (match) {
      const patch = {
        name: match.name, // roster ka naam hi rehta hai
        aliases: match.aliases,
        look: match.look || look,
        role: match.role || role,
        relationships: match.relationships || '',
      };
      // Rishte chapters ke saath grow karte hain — naya rishta append, duplicate skip
      if (rel) {
        if (!patch.relationships) {
          patch.relationships = rel;
        } else if (!patch.relationships.toLowerCase().includes(rel.toLowerCase())) {
          patch.relationships = (patch.relationships + '; ' + rel).slice(0, 400);
        }
      }
      // Agar detected naam roster naam se alag hai, alias mein add kar do
      if (norm(name) !== norm(match.name)) {
        const aliasList = match.aliases.split(',').map((a) => a.trim()).filter(Boolean);
        if (!aliasList.map(norm).includes(norm(name)) && aliasList.length < 8) {
          aliasList.push(name);
          patch.aliases = aliasList.join(', ');
        }
      }
      if (
        patch.look !== match.look || patch.role !== match.role ||
        patch.aliases !== match.aliases || patch.relationships !== (match.relationships || '')
      ) {
        updateCharacter(pid, match.id, patch);
        updated++;
      }
    } else {
      addCharacter(pid, { name, look, role, relationships: rel });
      existing.push({ name, aliases: '', look, role, relationships: rel });
      added++;
    }
  }
  return { added, updated };
}

// ---------- Chapter media (voiceover + video) ----------
function getMedia(cid) {
  const row = db.prepare('SELECT * FROM chapter_media WHERE chapter_id = ?').get(cid);
  if (!row) return null;
  let audio = null;
  try { audio = row.audio_json ? JSON.parse(row.audio_json) : null; } catch { audio = null; }
  return { ...row, audio, has_video: !!row.has_video };
}

function saveMedia(pid, cid, patch) {
  const cur = db.prepare('SELECT * FROM chapter_media WHERE chapter_id = ?').get(cid) || {
    chapter_id: cid, project_id: pid, audio_json: '', audio_hash: '', audio_sec: 0,
    video_hash: '', video_sec: 0, has_video: 0, tts_model: '', voice: '',
  };
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  if (patch.audio !== undefined) next.audio_json = patch.audio ? JSON.stringify(patch.audio) : '';
  db.prepare(
    `INSERT INTO chapter_media (chapter_id, project_id, audio_json, audio_hash, audio_sec, video_hash, video_sec, has_video, tts_model, voice, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chapter_id) DO UPDATE SET project_id = excluded.project_id, audio_json = excluded.audio_json, audio_hash = excluded.audio_hash,
       audio_sec = excluded.audio_sec, video_hash = excluded.video_hash, video_sec = excluded.video_sec, has_video = excluded.has_video,
       tts_model = excluded.tts_model, voice = excluded.voice, updatedAt = excluded.updatedAt`
  ).run(
    cid, pid, next.audio_json || '', next.audio_hash || '', Number(next.audio_sec) || 0,
    next.video_hash || '', Number(next.video_sec) || 0, next.has_video ? 1 : 0,
    next.tts_model || '', next.voice || '', next.updatedAt
  );
  return getMedia(cid);
}

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
    ttsVoice: s.ttsVoice || 'Charon',
    ttsStyle: s.ttsStyle !== undefined ? s.ttsStyle : 'Energetic, dramatic YouTube storyteller. Natural Urdu/Hindi pronunciation for this Roman Urdu script.',
    ttsMaxChars: clampInt(s.ttsMaxChars, 800, 6000, 2000),
    ttsDailyLimit: clampInt(s.ttsDailyLimit, 1, 100000, 10), // free tier: 10 TTS requests/day/key (Google ka 429 message, Oct 2026)
    // ---- Video ----
    videoPreset: s.videoPreset === 'portrait' ? 'portrait' : 'landscape',
    videoFps: clampInt(s.videoFps, 24, 60, 30),
    videoQuality: clampInt(s.videoQuality, 16, 30, 22), // x264 CRF — kam = behtar/bada
    channelName: s.channelName || '',
    trimFirstTop: clampInt(s.trimFirstTop, 0, 5000, 0),
    trimLastBottom: clampInt(s.trimLastBottom, 0, 5000, 0),
    holdSec: Math.min(2, Math.max(0, parseFloat(s.holdSec) || 0.4)),
    coveragePercent: clampInt(s.coveragePercent, 20, 100, 50), // strip ka kitna % screen par aaye (WEBTOON rule: ≤50%)
  };
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
  updateProjectInfo,
  getMedia,
  saveMedia,
  deleteMedia,
  getSettings,
  saveSettings,
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
