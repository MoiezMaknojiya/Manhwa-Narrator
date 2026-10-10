require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const store = require('./lib/store');
const { generateNarration, listModels } = require('./lib/gemini');
const { recordTokenUsage, getTokenStats } = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Projects list + current path for the sidebar (every page)
app.use((req, res, next) => {
  res.locals.sidebarProjects = store.listProjects().slice(0, 25);
  res.locals.currentPath = req.path;
  res.locals.appVersion = require('./package.json').version;
  next();
});

// ---------- Multer (chapter image uploads) ----------
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOADS_DIR, req.params.pid, req.params.cid);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '-' + safe);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 60 },
  fileFilter(req, file, cb) {
    cb(null, /^image\//.test(file.mimetype));
  },
});

// Natural sort: 1.jpg, 2.jpg, 10.jpg
const naturalCompare = (a, b) =>
  a.original.localeCompare(b.original, undefined, { numeric: true, sensitivity: 'base' });

// ---------- Home: projects ----------
app.get('/', (req, res) => {
  res.render('index', { projects: store.listProjects(), settings: store.getSettings() });
});

app.post('/projects', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/');
  const project = store.createProject({ name, type: req.body.type });
  res.redirect('/projects/' + project.id);
});

app.post('/projects/:pid/delete', (req, res) => {
  store.deleteProject(req.params.pid);
  fs.rmSync(path.join(UPLOADS_DIR, req.params.pid), { recursive: true, force: true });
  res.redirect('/');
});

// ---------- Project page: chapters ----------
app.get('/projects/:pid', (req, res) => {
  const project = store.getProject(req.params.pid);
  if (!project) return res.status(404).send('Project not found');
  res.render('project', { project });
});

app.post('/projects/:pid/chapters', (req, res) => {
  const chapter = store.createChapter(req.params.pid, { title: req.body.title });
  if (!chapter) return res.status(404).send('Project not found');
  res.redirect(`/projects/${req.params.pid}/chapters/${chapter.id}`);
});

app.post('/projects/:pid/chapters/:cid/delete', (req, res) => {
  store.deleteChapter(req.params.pid, req.params.cid);
  fs.rmSync(path.join(UPLOADS_DIR, req.params.pid, req.params.cid), { recursive: true, force: true });
  res.redirect('/projects/' + req.params.pid);
});

// ---------- Chapter page ----------
app.get('/projects/:pid/chapters/:cid', (req, res) => {
  const project = store.getProject(req.params.pid);
  const chapter = store.getChapter(req.params.pid, req.params.cid);
  if (!project || !chapter) return res.status(404).send('Chapter not found');
  const settings = store.getSettings();
  const tokenStats = store.getTokenStats();
  res.render('chapter', {
    project,
    chapter,
    hasKey: settings.keys.length > 0,
    model: settings.model,
    tokenStats,
    quota: store.getQuotaSummary(),
  });
});

// Upload images
app.post('/projects/:pid/chapters/:cid/images', upload.array('images', 60), (req, res) => {
  const chapter = store.getChapter(req.params.pid, req.params.cid);
  if (!chapter) return res.status(404).send('Chapter not found');
  const added = (req.files || []).map((f) => ({ file: f.filename, original: f.originalname }));
  const images = [...chapter.images, ...added].sort(naturalCompare);
  store.updateChapter(req.params.pid, req.params.cid, {
    images,
    status: images.length ? (chapter.narration ? 'done' : 'ready') : 'empty',
  });
  res.redirect(`/projects/${req.params.pid}/chapters/${req.params.cid}`);
});

// Remove one image
app.post('/projects/:pid/chapters/:cid/images/remove', (req, res) => {
  const chapter = store.getChapter(req.params.pid, req.params.cid);
  if (!chapter) return res.status(404).send('Chapter not found');
  const file = req.body.file;
  const images = chapter.images.filter((img) => img.file !== file);
  fs.rmSync(path.join(UPLOADS_DIR, req.params.pid, req.params.cid, file), { force: true });
  store.updateChapter(req.params.pid, req.params.cid, {
    images,
    status: images.length ? chapter.status : 'empty',
  });
  res.redirect(`/projects/${req.params.pid}/chapters/${req.params.cid}`);
});

// Clear all images
app.post('/projects/:pid/chapters/:cid/images/clear', (req, res) => {
  fs.rmSync(path.join(UPLOADS_DIR, req.params.pid, req.params.cid), { recursive: true, force: true });
  store.updateChapter(req.params.pid, req.params.cid, { images: [], status: 'empty' });
  res.redirect(`/projects/${req.params.pid}/chapters/${req.params.cid}`);
});

// ---------- Character roster helpers ----------
const CHAR_MARKER = '===CHARACTERS===';

function buildRosterBlock(characters) {
  if (!characters.length) return '';
  const lines = characters.map((c) => {
    let line = `- ${c.name}`;
    if (c.aliases) line += ` (also known as: ${c.aliases})`;
    if (c.role) line += ` [${c.role}]`;
    if (c.look) line += ` — appearance: ${c.look}`;
    if (c.relationships) line += ` — relationships: ${c.relationships}`;
    return line;
  });
  return (
    '\n\nCHARACTER ROSTER (always use EXACTLY these names in the script, even if this chapter\'s translation spells them differently — identify each character by their appearance. USE the relationships naturally in the narration, e.g. "Hyeon ki ammi", "uska beta"):\n' +
    lines.join('\n')
  );
}

const EXTRACT_INSTRUCTION =
  `\n\nAPP INSTRUCTION (not part of the script): After the script is fully finished, write "${CHAR_MARKER}" alone on a new line, followed by a JSON array (in ENGLISH, no extra text) of the important characters seen in this chapter:\n` +
  `[{"name": "...", "look": "short visual description in English — hair, clothes, distinctive features", "role": "hero/villain/side", "relationships": "family/social ties revealed so far, e.g. Ha Hyeon's mother; wife of Sin Ji-hyeok"}]\n` +
  `For characters already in the roster, use the roster name. Add a new entry for any new character. If this chapter reveals a NEW relationship for an existing character, include that character with the updated relationships.`;

function splitNarrationAndCharacters(text) {
  const idx = text.indexOf(CHAR_MARKER);
  if (idx === -1) return { narration: text.trim(), detected: [] };
  const narration = text.slice(0, idx).trim();
  let jsonPart = text.slice(idx + CHAR_MARKER.length).trim();
  jsonPart = jsonPart.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let detected = [];
  try {
    const start = jsonPart.indexOf('[');
    const end = jsonPart.lastIndexOf(']');
    if (start !== -1 && end > start) detected = JSON.parse(jsonPart.slice(start, end + 1));
  } catch {
    detected = [];
  }
  return { narration, detected };
}

// Generate narration (AJAX)
app.post('/projects/:pid/chapters/:cid/generate', async (req, res) => {
  const { pid, cid } = req.params;
  const chapter = store.getChapter(pid, cid);
  if (!chapter) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  if (!chapter.images.length)
    return res.status(400).json({ ok: false, error: 'Upload images first.' });

  const settings = store.getSettings();
  store.updateChapter(pid, cid, { status: 'generating', error: '' });
  try {
    const roster = store.listCharacters(pid);
    const finalPrompt = settings.prompt + buildRosterBlock(roster) + EXTRACT_INSTRUCTION;
    const imagePaths = chapter.images.map((img) => ({
      path: path.join(UPLOADS_DIR, pid, cid, img.file),
      original: img.original,
    }));
    const result = await generateNarration({
      keys: settings.keys,
      activeKeyIndex: settings.activeKeyIndex,
      model: settings.model,
      prompt: finalPrompt,
      imagePaths,
      // Har API try quota mein count hoti hai (fail bhi Google ke haan count hoti hai)
      onAttempt: (idx, keyLabel) => store.recordKeyRequest(keyLabel, settings.model),
    });
    // Jo key chali, wahi agli baar pehle try hogi
    store.saveSettings({ activeKeyIndex: String(result.usedKeyIndex) });
    recordTokenUsage(pid, cid, result.tokenUsage, settings.model);
    const { narration, detected } = splitNarrationAndCharacters(result.text);
    const mergeResult = store.mergeDetectedCharacters(pid, detected);
    store.updateChapter(pid, cid, { narration, status: 'done', error: '' });
    res.json({
      ok: true,
      narration,
      characters: mergeResult,
      tokenUsage: result.tokenUsage,
      keyInfo: {
        usedKeyIndex: result.usedKeyIndex,
        usedKeyLabel: result.usedKeyLabel,
        rotated: result.rotated,
        failures: result.failures,
      },
      quota: store.getQuotaSummary(),
    });
  } catch (err) {
    const message = err && err.message ? err.message : 'Kuch ghalat ho gaya.';
    store.updateChapter(pid, cid, { status: 'error', error: message });
    res.status(500).json({ ok: false, error: message, quota: store.getQuotaSummary() });
  }
});

// ---------- Characters CRUD ----------
app.post('/projects/:pid/characters', (req, res) => {
  store.addCharacter(req.params.pid, req.body);
  res.redirect('/projects/' + req.params.pid + '#characters');
});

app.post('/projects/:pid/characters/:chid/update', (req, res) => {
  store.updateCharacter(req.params.pid, req.params.chid, req.body);
  res.redirect('/projects/' + req.params.pid + '#characters');
});

app.post('/projects/:pid/characters/:chid/delete', (req, res) => {
  store.deleteCharacter(req.params.pid, req.params.chid);
  res.redirect('/projects/' + req.params.pid + '#characters');
});

// Save edited narration
app.post('/projects/:pid/chapters/:cid/narration', (req, res) => {
  const chapter = store.getChapter(req.params.pid, req.params.cid);
  if (!chapter) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  store.updateChapter(req.params.pid, req.params.cid, {
    narration: req.body.narration || '',
    status: (req.body.narration || '').trim() ? 'done' : chapter.status,
  });
  res.json({ ok: true });
});

// Download narration as .txt
app.get('/projects/:pid/chapters/:cid/narration.txt', (req, res) => {
  const project = store.getProject(req.params.pid);
  const chapter = store.getChapter(req.params.pid, req.params.cid);
  if (!project || !chapter) return res.status(404).send('Not found');
  const name = `${project.name} - ${chapter.title}`.replace(/[^a-zA-Z0-9 _-]/g, '');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name || 'narration'}.txt"`);
  res.send(chapter.narration || '');
});

// ---------- Token Stats API ----------
app.get('/api/token-stats', (req, res) => {
  res.json(store.getTokenStats());
});

// ---------- Quota API (per-key daily requests) ----------
app.get('/api/quota', (req, res) => {
  res.json(store.getQuotaSummary());
});

// ---------- Live model list (Google se) ----------
app.get('/api/models', async (req, res) => {
  try {
    const settings = store.getSettings();
    if (!settings.keys.length)
      return res.status(400).json({ ok: false, error: 'Pehle API key save karo.' });
    const models = await listModels(settings.keys[settings.activeKeyIndex] || settings.keys[0]);
    res.json({ ok: true, models });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err.message || 'Models load nahi hue').slice(0, 200) });
  }
});

// ---------- Settings ----------
app.get('/settings', (req, res) => {
  res.render('settings', {
    settings: store.getSettings(),
    promptFile: store.PROMPT_FILE_LABEL,
    saved: req.query.saved === '1',
  });
});

app.post('/settings', (req, res) => {
  store.saveSettings({
    apiKeys: (req.body.apiKeys || '').trim(),
    dailyLimit: String(Math.max(1, parseInt(req.body.dailyLimit, 10) || 100)),
    activeKeyIndex: '0', // nayi keys save hui — pehli key se shuru
    model: (req.body.model || 'gemini-2.5-pro').trim(),
  });
  res.redirect('/settings?saved=1');
});

app.listen(PORT, () => {
  const APP_VERSION = require('./package.json').version;
  console.log(`\n  Manhwa Narrator v${APP_VERSION} running --> http://localhost:${PORT}\n`);
});
