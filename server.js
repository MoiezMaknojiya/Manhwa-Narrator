require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const multer = require('multer');
const store = require('./lib/store');
const { generateNarration, listModels } = require('./lib/gemini');
const { recordTokenUsage, getTokenStats } = require('./lib/store');
const jobs = require('./lib/jobs');
const { parseSections, mergeLeadIns } = require('./lib/sections');
const { splitGeminiOutput } = require('./lib/extract');
const N = require('./lib/names');
const { synthesizeImages, pruneClips, readClip, clipHash, clipName, clipPaths } = require('./lib/tts');
const { zipStore } = require('./lib/zip');
// Voice catalog with gender/pitch/description — GET /v1beta/voices se nikala (lib/voices.json)
let VOICE_CATALOG;
try {
  VOICE_CATALOG = require('./lib/voices.json').voices;
} catch {
  VOICE_CATALOG = [];
}
const voiceLabel = (v) => (VOICE_CATALOG.find((x) => x.voice === v) || {}).name || v;
const { buildListing } = require('./lib/publish');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
const PROMPTS_DIR = path.join(__dirname, 'prompts');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/output', express.static(OUTPUT_DIR));
app.use('/faces', express.static(store.FACES_DIR)); // reference face crops (data/faces)

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
  fs.rmSync(path.join(OUTPUT_DIR, req.params.pid), { recursive: true, force: true });
  res.redirect('/');
});

// Source info (author / official platform / URL) — credits, end card, description
app.post('/projects/:pid/info', (req, res) => {
  store.updateProjectInfo(req.params.pid, req.body);
  res.redirect('/projects/' + req.params.pid + '#source');
});

// ---------- Project page: chapters ----------
app.get('/projects/:pid', (req, res) => {
  const project = store.getProject(req.params.pid);
  if (!project) return res.status(404).send('Project not found');
  res.render('project', {
    project,
    otherProjects: store.listProjects().filter((p) => p.id !== project.id), // roster copy ke liye (sequel/season 2)
    rosterMsg: req.query.msg || '',
    faces: store.facesByCharacter(project.id),
  });
});

app.post('/projects/:pid/chapters', (req, res) => {
  const chapter = store.createChapter(req.params.pid, { title: req.body.title });
  if (!chapter) return res.status(404).send('Project not found');
  res.redirect(`/projects/${req.params.pid}/chapters/${chapter.id}`);
});

app.post('/projects/:pid/chapters/:cid/delete', (req, res) => {
  store.deleteChapter(req.params.pid, req.params.cid);
  store.deleteMedia(req.params.cid);
  fs.rmSync(path.join(UPLOADS_DIR, req.params.pid, req.params.cid), { recursive: true, force: true });
  fs.rmSync(path.join(OUTPUT_DIR, req.params.pid, req.params.cid), { recursive: true, force: true });
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
    showVoices: settings.showVoicesCard === 'on', // Image Voices card — Settings mein PIN-protected switch
    model: settings.model,
    tokenStats,
    quota: store.getQuotaSummary(),
    media: mediaStatus(req.params.pid, req.params.cid),
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
const SOURCE_MARKER = '===SOURCE===';

/** Chapter title → project mein uska number (1-based). Roster ko chapter ke hisaab se scope karne ke liye. */
function chapterOrderMap(project) {
  const m = {};
  (project.chapters || []).forEach((c, i) => { m[c.title] = i + 1; });
  return m;
}

/** Series ka context + naming convention (manhwa/manhua/manga) + ye kaunsa chapter hai */
function buildProjectBlock(project, chapter, index, total) {
  const type = (project.type || 'manhwa').toLowerCase();
  const conv = type === 'manhua'
    ? 'Manhua (Chinese): names are pinyin, family name first (e.g. "Xiao Yan" = family Xiao, given Yan). Keep the roster spelling and syllable split ("Xiaoyan" and "Xiao Yan" are the same person). Diminutives and forms of address ("Yan\'er", "Brother Yan", "Young Master Xiao") refer to the roster character — use the roster name.'
    : type === 'manga'
      ? 'Manga (Japanese): translations swap family/given name order — the roster order is the correct one. Honorifics (-san, -kun, -sama, -senpai, -chan) are not part of the name.'
      : 'Manhwa (Korean): family name first (e.g. "Namgung Yeongryeong" = family Namgung, given Yeongryeong). Translations vary romanization (Hyeon/Hyun, Sin/Shin, Ji-hyeok/Jihyuk) — ALWAYS use the roster spelling. Honorifics (-nim, -ssi, hyung, nuna) and titles (Young Master, Elder, Lord) are not part of the name.';
  return `\n\nSERIES CONTEXT: "${project.name}"${project.author ? ` by ${project.author}` : ''}. You are writing CHAPTER "${chapter.title}" (chapter ${index} of ${total} in this project). NAMING CONVENTION — ${conv}`;
}

/**
 * Roster block — chapter-scoped: baad ke chapters mein pehli baar aaye characters, aur "Chapter N:" tagged rishte/kapde jo is chapter
 * ke baad reveal hue, is prompt mein NAHI jaate (purana chapter regenerate karo toh spoiler nahi). pending (unnamed/guess) rows bhi nahi.
 */
function buildRosterBlock(characters, { chapterOrder = Infinity, orderOf = () => null, withFaces = new Set() } = {}) {
  const roster = characters.filter((c) => !c.pending);
  const RULES =
    '\n\nCHARACTER ROSTER — use EXACTLY these names in the script (the bullet spelling is the correct one, even if this chapter\'s translation or a relationships note spells it differently).\n' +
    'HOW TO RECOGNISE: by PERMANENT features (face, hair colour/style, eye colour, scars, build, approximate age) PLUS story context (who they are with, how others address them, their relationships). Clothes, armour, weapons and accessories CHANGE between chapters — a known character in a new outfit is the SAME character; never invent a new name for them. Time skips, flashbacks (younger / greyscale), chibi or comedy panels, night or rain scenes: colours and apparent age are unreliable there — rely on context.\n' +
    'THE OPPOSITE MISTAKE IS WORSE: never give a roster name to someone who merely resembles one (same clan robes or uniform, same hairstyle, a relative, a twin, a masked or hooded figure). Use a roster name only when face AND context clearly match. If unsure, DESCRIBE the person ("Sin family ka ek guard", "naqaab-posh aadmi") and do not put them in the JSON as that character. Characters marked [DEAD] appear only in flashbacks/memories or when others talk about them. "not yet shown clearly" characters are never recognised by looks.\n' +
    'REVEAL TIMING: if a face is hidden, or the story has not yet named the person in THIS chapter\'s panels, do not use the roster name before the reveal — describe them, then switch to the name in the image where the story reveals it. Never reveal relationships, deaths or identities that belong to later chapters (spoilers).\n' +
    'If a roster character receives a new name or title in the story (adoption, fake identity, promotion), keep using the ROSTER name and mention the new one once in narration — never create a second character.\n' +
    'USE the relationships naturally ("[naam] ki ammi", "uska beta"). First mention of a character in an image-section = full roster name; afterwards a short form (given name) is fine, spelling always the roster\'s.\n';
  if (!roster.length) {
    return RULES + '(The roster is still empty — this is the first chapter. Use each name exactly as this chapter\'s text spells it and keep it consistent throughout. People who are never named: describe them, do not invent names.)';
  }
  const lines = roster.map((c) => {
    const firstSeen = c.first_seen ? orderOf(c.first_seen) : null;
    if (firstSeen !== null && firstSeen !== undefined && firstSeen > chapterOrder) return null; // baad ke chapter ka character
    let line = `- ${c.name}`;
    if (c.aliases) line += ` (also known as: ${c.aliases})`;
    if (c.role) line += ` [${c.role}]`;
    if (c.status && c.status !== 'alive') line += ` [${String(c.status).toUpperCase()}]`;
    if (c.look) line += ` — permanent appearance: ${c.look}`;
    else line += ' — appearance: not yet shown clearly (recognise only by name/context, never by looks)';
    if (c.notes) line += ` — how to tell apart: ${c.notes}`;
    if (withFaces.has(c.id)) line += ' — FACE REFERENCE images provided below (match the face against them)';
    const outfits = N.clausesUpTo(c.outfits, chapterOrder, orderOf);
    if (outfits) line += ` — clothes seen so far (NOT a recognition cue, they change): ${outfits}`;
    const rel = N.clausesUpTo(c.relationships, chapterOrder, orderOf);
    if (rel) line += ` — relationships (revealed up to this chapter): ${rel}`;
    return line;
  }).filter(Boolean);
  return RULES + lines.join('\n');
}

const EXTRACT_INSTRUCTION =
  `\n\nAPP INSTRUCTION (not part of the script): After the script is fully finished, write "${CHAR_MARKER}" alone on a new line, followed by a JSON array (ENGLISH only, no extra text) with EVERY person who is NAMED or speaks in the STORY panels of this chapter — minor named characters too, so their spelling is fixed for later chapters. EXCLUDE cover/title art, character cards, next-chapter previews, recap pages, credits / translator / scanlation pages, TL notes, mascots and advertisements: take no names or looks from those pages.\n` +
  `Each entry: {"name": "the exact ROSTER name if this is a roster character (even in a new outfit, older, or called by a nickname/title); otherwise the name exactly as this chapter spells it; for an UNNAMED person a short English descriptor like 'masked assassin' — never a kinship word alone ('mother'), never an invented name", "unnamed": true or false, "confidence": "sure" or "guess" (guess = face hidden or identity only inferred), "seen": "shown" or "mentioned" (mentioned = only talked about, not on panel), "sameAs": "roster name ONLY when a roster character is now called by a different name in the story (adoption, fake identity, new title), else empty", "titles": "epithets, titles or nicknames used for this person in this chapter, comma-separated (e.g. Sword Saint), else empty", "look": "PERMANENT features only — face, hair colour and style, eye colour, scars or marks, build, approximate age. NO clothes, jewellery, weapons, expressions, moods, blood, mud or tears", "outfit": "clothes, armour, accessories and weapon in THIS chapter (short)", "role": "hero / villain / side", "status": "alive or dead — only if this chapter shows it, else empty", "relationships": "ties revealed in THIS chapter, using FULL roster names only and no pronouns, e.g. mother of <full name>; wife of <full name>"}\n` +
  `Then write "${SOURCE_MARKER}" alone on a new line, followed by one JSON object (ENGLISH): {"watermarks": ["every website name, URL, logo banner or scanlation-group credit visible anywhere in the images, e.g. example.net"], "notes": "one short line about the source if relevant, else empty"}. Use an empty array if no such text is visible.`;

// Reference faces ka intro — roster ke baad, chapter images se pehle (lib/gemini.js refParts)
const FACE_REFS_INTRO =
  '\n\nFACE REFERENCES: the small images that follow are cropped faces of roster characters taken from earlier chapters, each labelled with the name. ' +
  'When a face in this chapter\'s panels matches a reference (face shape, eyes, hair, marks) AND the story context fits, use that roster name — even if the clothes, angle, lighting, age-styling or expression differ. ' +
  'A reference is a strong hint, not proof: if the face clearly differs or the context contradicts it, describe the person instead. The reference images are NOT chapter panels — never narrate them and never count them as an IMAGE.';

const GEMINI_REMINDER =
  '\n\nREMINDER (you have now seen every image): use EXACTLY the roster names from the top; never put a roster name on a hidden or uncertain face; cover every image with its own --- [IMAGE n] --- marker; then append the ===CHARACTERS=== and ===SOURCE=== blocks.';

const SCRIPT_TEMPERATURE = 0.6; // kam temperature + fixed seed = har regenerate par naam/spelling zyada stable
const seedFor = (s) => parseInt(crypto.createHash('sha1').update(s).digest('hex').slice(0, 8), 16) % 2147483647;

// Commentary addon — policy layer (Settings → Script → commentary mode)
function getCommentaryAddon() {
  try {
    return fs.readFileSync(path.join(PROMPTS_DIR, 'commentary-addon.md'), 'utf8');
  } catch {
    return '';
  }
}

/** Script ka naam-audit (roster vs script) — flags.nameAudit ki shakal mein */
function nameAuditFor(pid, narration, detected = []) {
  const roster = store.listCharacters(pid).filter((c) => !c.pending);
  const a = N.auditNames(narration, roster, detected);
  return { unknown: a.unknown.slice(0, 12), nearMatches: a.nearMatches.slice(0, 12), jsonOnly: a.jsonOnly.slice(0, 12) };
}

// Generate narration (AJAX). Ek chapter par ek waqt mein ek hi generation; ek project ke chapters BAARI BAARI chalte hain
// (chapter 8 ka prompt chapter 7 ke roster merge ke BAAD banta hai).
const generating = new Set();
const projectQueue = new Map();
app.post('/projects/:pid/chapters/:cid/generate', async (req, res) => {
  const { pid, cid } = req.params;
  const chapter0 = store.getChapter(pid, cid);
  if (!chapter0) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  if (!chapter0.images.length) return res.status(400).json({ ok: false, error: 'Upload images first.' });
  if (generating.has(cid)) return res.status(409).json({ ok: false, error: 'Script generation is already running for this chapter — wait for it to finish.' });
  const settings = store.getSettings();
  if (!settings.keys.length) return res.status(400).json({ ok: false, error: 'No Google AI API key set — add keys in Settings.' });
  generating.add(cid);
  store.updateChapter(pid, cid, { status: 'generating', error: '' });

  const run = async () => {
    const chapter = store.getChapter(pid, cid); // fresh — intezaar ke dauran roster/notes badle ho sakte hain
    const project = store.getProject(pid);
    const orderMap = chapterOrderMap(project);
    const chapterIndex = orderMap[chapter.title] || (project.chapters.findIndex((c) => c.id === cid) + 1) || 1;
    const orderOf = (title) => (orderMap[title] !== undefined ? orderMap[title] : null);
    const roster = store.listCharacters(pid);
    // Face references: sirf un roster characters ke jo is chapter tak reveal ho chuke (spoiler guard roster block jaisa)
    const facesMap = store.facesByCharacter(pid);
    const refParts = [], refNames = [], withFaces = new Set();
    for (const c of roster) {
      const list = facesMap[c.id] || [];
      if (c.pending || !list.length) continue;
      const fs0 = c.first_seen ? orderOf(c.first_seen) : null;
      if (fs0 !== null && fs0 !== undefined && fs0 > chapterIndex) continue;
      const imgs = [];
      for (const f of list) { try { imgs.push(fs.readFileSync(store.faceFile(f)).toString('base64')); } catch {} }
      if (!imgs.length) continue;
      withFaces.add(c.id); refNames.push(`${c.name} (${imgs.length})`);
      imgs.forEach((data, k) => { refParts.push({ text: `\nREFERENCE FACE ${k + 1} of ${imgs.length} — this is ${c.name}:` }); refParts.push({ inlineData: { mimeType: 'image/jpeg', data } }); });
    }
    if (refParts.length) refParts.unshift({ text: FACE_REFS_INTRO });
    const addon = settings.commentaryMode === 'on' ? getCommentaryAddon() : '';
    const notesBlock = (chapter.notes || '').trim()
      ? `\n\nEDITOR NOTES FOR THIS CHAPTER ONLY (apply here, not a permanent rule): ${chapter.notes.trim().slice(0, 1500)}`
      : '';
    const finalPrompt = settings.prompt + addon + buildProjectBlock(project, chapter, chapterIndex, project.chapters.length) +
      buildRosterBlock(roster, { chapterOrder: chapterIndex, orderOf, withFaces }) + notesBlock + EXTRACT_INSTRUCTION;
    const imagePaths = chapter.images.map((img) => path.join(UPLOADS_DIR, pid, cid, img.file)); // file ke naam model ko nahi jaate
    const result = await generateNarration({
      keys: settings.keys,
      activeKeyIndex: settings.activeKeyIndex,
      model: settings.model,
      prompt: finalPrompt,
      imagePaths,
      reminder: GEMINI_REMINDER,
      refParts,
      temperature: SCRIPT_TEMPERATURE,
      seed: seedFor(pid + cid),
      // Har API try quota mein count hoti hai (fail bhi Google ke haan count hoti hai)
      onAttempt: (idx, keyLabel) => store.recordKeyRequest(keyLabel, settings.model),
    });
    // Jo key chali, wahi agli baar pehle try hogi
    store.saveSettings({ activeKeyIndex: String(result.usedKeyIndex) });
    recordTokenUsage(pid, cid, result.tokenUsage, settings.model);

    const parsed = splitGeminiOutput(result.text);
    const warnings = [...parsed.warnings];
    // Naam-audit RAW text par (labels abhi speaker se shuru hote hain): variant spelling → roster spelling, alias seekho
    const audit = nameAuditFor(pid, parsed.narration, parsed.detected);
    const fixed = [];
    for (const nm of audit.nearMatches) {
      const c = roster.find((x) => x.name === nm.roster);
      const alias = c ? N.cleanAlias(nm.found, c.name) : '';
      if (c && alias) store.updateCharacter(pid, c.id, { aliases: [c.aliases, alias].filter(Boolean).join(', ') }, { source: 'ai' });
      fixed.push(`"${nm.found}" ×${nm.count} → ${nm.roster}`);
    }
    let narration = parsed.narration;
    if (audit.nearMatches.length) narration = N.canonicalizeNamesInText(narration, roster.filter((c) => !c.pending));
    narration = mergeLeadIns(narration).trim(); // 'X kehti hai:' + '"X kehti hai": baat' → ek hi attribution

    const flags = { ...(chapter.flags || {}) };
    if (parsed.source && Array.isArray(parsed.source.watermarks)) {
      flags.watermarks = parsed.source.watermarks.map((w) => String(w).trim().slice(0, 60)).filter(Boolean).slice(0, 8);
      if (parsed.source.notes) flags.sourceNotes = String(parsed.source.notes).slice(0, 200);
    }
    flags.parseWarnings = parsed.warnings;
    flags.nameAudit = { unknown: audit.unknown, fixed, jsonOnly: audit.jsonOnly };
    flags.faceRefs = { count: refParts.filter((p) => p.inlineData).length, names: refNames };
    // PEHLE script save (Gemini ka output kabhi zaya na ho), PHIR roster merge
    store.updateChapter(pid, cid, {
      narration, status: 'done', error: '', flags,
      prevNarration: chapter.narration || '',
      narrationImages: chapter.images.map((i) => i.file),
    });
    let mergeResult;
    try {
      mergeResult = store.mergeDetectedCharacters(pid, parsed.detected, { id: cid, title: chapter.title });
    } catch (err) {
      console.error('  ❌ roster merge failed (script is saved):', err.message);
      mergeResult = { added: 0, updated: 0, pending: [], ambiguous: [], conflicts: [], skipped: [], learned: [], error: err.message };
      warnings.push('Roster update failed: ' + err.message);
    }
    flags.roster = { pending: mergeResult.pending, ambiguous: mergeResult.ambiguous, conflicts: mergeResult.conflicts, skipped: mergeResult.skipped, learned: mergeResult.learned };
    store.updateChapter(pid, cid, { flags });
    return {
      ok: true,
      narration,
      characters: mergeResult,
      flags,
      warnings,
      tokenUsage: result.tokenUsage,
      keyInfo: { usedKeyIndex: result.usedKeyIndex, usedKeyLabel: result.usedKeyLabel, rotated: result.rotated, failures: result.failures },
      quota: store.getQuotaSummary(),
      media: mediaStatus(pid, cid),
    };
  };

  const prev = projectQueue.get(pid) || Promise.resolve();
  const job = prev.then(run, run);
  projectQueue.set(pid, job.catch(() => {}));
  try {
    res.json(await job);
  } catch (err) {
    const message = err && err.message ? err.message : 'Kuch ghalat ho gaya.';
    store.updateChapter(pid, cid, { status: 'error', error: message });
    res.status(500).json({ ok: false, error: message, quota: store.getQuotaSummary() });
  } finally {
    generating.delete(cid);
  }
});

// ---------- Face references (per character 1-3 face crops → Gemini ko pehchaan ke liye) ----------
app.get('/projects/:pid/characters/:chid/faces', async (req, res) => {
  const { pid, chid } = req.params;
  const project = store.getProject(pid);
  const character = project && store.getCharacter(pid, chid);
  if (!project || !character) return res.status(404).send('Character not found');
  const chapters = project.chapters;
  const chapter = chapters.find((c) => c.id === req.query.chapter) || chapters.find((c) => c.images.length) || null;
  const images = [];
  if (chapter) {
    for (let i = 0; i < chapter.images.length; i++) {
      const img = chapter.images[i];
      try {
        const m = await crops.imageMeta(path.join(UPLOADS_DIR, pid, chapter.id, img.file));
        images.push({ index: i + 1, file: img.file, url: `/uploads/${pid}/${chapter.id}/${img.file}`, width: m.width, height: m.height });
      } catch {}
    }
  }
  res.render('faces', { project, character, chapters, chapter, images, faces: store.listFaces(pid, chid), maxFaces: store.MAX_FACES });
});
app.post('/projects/:pid/characters/:chid/faces', async (req, res) => {
  const { pid, chid } = req.params;
  const { chapterId, file, rect } = req.body || {};
  const chapter = chapterId ? store.getChapter(pid, String(chapterId)) : null;
  const img = chapter && chapter.images.find((i) => i.file === file);
  if (!img) return res.status(400).json({ ok: false, error: 'Image not found.' });
  try {
    const { rect: sq, buffer } = await crops.renderSquare(path.join(UPLOADS_DIR, pid, chapter.id, img.file), rect || {}, 256);
    const out = store.addFace(pid, chid, buffer, { chapterId: chapter.id, file: img.file, rect: sq });
    if (out.error) return res.status(400).json({ ok: false, error: out.error });
    res.json({ ok: true, face: { id: out.face.id, url: `/faces/${pid}/${chid}/${out.face.id}.jpg` }, count: store.listFaces(pid, chid).length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/projects/:pid/characters/:chid/faces/:fid/delete', (req, res) => {
  const { pid, chid, fid } = req.params;
  const ok = store.deleteFace(pid, fid);
  res.json({ ok, count: store.listFaces(pid, chid).length });
});

// ---------- Characters CRUD ----------
const backToRoster = (res, pid, msg) => res.redirect('/projects/' + pid + (msg ? '?msg=' + encodeURIComponent(msg) : '') + '#characters');

app.post('/projects/:pid/characters', (req, res) => {
  const c = store.addCharacter(req.params.pid, req.body, { manual: true });
  backToRoster(res, req.params.pid, c ? '' : 'Name is required.');
});

app.post('/projects/:pid/characters/:chid/update', (req, res) => {
  const out = store.updateCharacter(req.params.pid, req.params.chid, req.body, { manual: true });
  backToRoster(res, req.params.pid, out ? '' : 'Name cannot be empty.');
});

// Delete + remember: agla Generate is naam ko dobara add nahi karega (manual add se tombstone hat jaata hai)
app.post('/projects/:pid/characters/:chid/delete', (req, res) => {
  store.deleteCharacter(req.params.pid, req.params.chid, { forget: req.body.forget !== '0' });
  backToRoster(res, req.params.pid);
});

// Do rows ek — duplicate ko asal character mein milao (aliases/rishte/kapde saath)
app.post('/projects/:pid/characters/:chid/merge-into', (req, res) => {
  const target = (req.body.target || '').trim();
  const out = target ? store.mergeCharacters(req.params.pid, target, req.params.chid) : null;
  backToRoster(res, req.params.pid, out ? `Merged into ${out.name}.` : 'Pick a character to merge into.');
});

// Sequel / season 2: doosre project ka roster copy
app.post('/projects/:pid/characters/copy-from', (req, res) => {
  const src = (req.body.sourcePid || '').trim();
  const n = src && src !== req.params.pid ? store.copyCharacters(src, req.params.pid) : 0;
  backToRoster(res, req.params.pid, `Copied ${n} character${n === 1 ? '' : 's'}.`);
});

// Pending suggestion (unnamed/guess) ko roster mein alias ke taur par jodna
app.post('/projects/:pid/characters/:chid/alias', (req, res) => {
  const c = store.getCharacter(req.params.pid, req.params.chid);
  const alias = (req.body.alias || '').trim();
  if (c && alias) store.updateCharacter(req.params.pid, c.id, { aliases: [c.aliases, alias].filter(Boolean).join(', ') }, { manual: true });
  res.json({ ok: !!(c && alias) });
});

// Save edited narration (+ naam audit dobara)
app.post('/projects/:pid/chapters/:cid/narration', (req, res) => {
  const { pid, cid } = req.params;
  const chapter = store.getChapter(pid, cid);
  if (!chapter) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  const narration = req.body.narration || '';
  const flags = { ...(chapter.flags || {}) };
  if (narration.trim()) flags.nameAudit = { ...nameAuditFor(pid, narration), fixed: [] };
  store.updateChapter(pid, cid, { narration, status: narration.trim() ? 'done' : chapter.status, flags });
  res.json({ ok: true, media: mediaStatus(pid, cid) });
});

// Regenerate se pehle wali script wapas
app.post('/projects/:pid/chapters/:cid/narration/restore', (req, res) => {
  const { pid, cid } = req.params;
  const chapter = store.getChapter(pid, cid);
  if (!chapter) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  if (!(chapter.prevNarration || '').trim()) return res.status(400).json({ ok: false, error: 'No previous script saved for this chapter.' });
  const flags = { ...(chapter.flags || {}), nameAudit: { ...nameAuditFor(pid, chapter.prevNarration), fixed: [] } };
  store.updateChapter(pid, cid, { narration: chapter.prevNarration, prevNarration: chapter.narration, status: 'done', flags });
  res.json({ ok: true, narration: chapter.prevNarration, media: mediaStatus(pid, cid) });
});

// Sirf is chapter ke liye hidayaat (prompt mein "EDITOR NOTES FOR THIS CHAPTER ONLY")
app.post('/projects/:pid/chapters/:cid/notes', (req, res) => {
  const chapter = store.getChapter(req.params.pid, req.params.cid);
  if (!chapter) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  store.updateChapter(req.params.pid, req.params.cid, { notes: String(req.body.notes || '').slice(0, 1500) });
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

// ======================================================================
//  Crop panels — webtoon strip se chhote crops (CapCut ke liye), copyright budget ke saath
// ======================================================================
const crops = require('./lib/crops');
const safeName = (s) => String(s || '').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'chapter';
const cropsState = (chapter) => {
  const c = (chapter.flags && chapter.flags.crops) || {};
  return { budgetPercent: Math.min(100, Math.max(10, parseInt(c.budgetPercent, 10) || 40)), byFile: c.byFile || {}, folder: c.folder || '' };
};
const defaultCropFolder = (project, chapter) =>
  path.join(require('os').homedir(), 'Desktop', 'CR', 'StoryArcRewind', safeName(project.name), safeName(chapter.title), 'images-cropped');

async function chapterImagesWithMeta(pid, cid, chapter) {
  const out = [];
  for (let i = 0; i < chapter.images.length; i++) {
    const img = chapter.images[i];
    const file = path.join(UPLOADS_DIR, pid, cid, img.file);
    if (!fs.existsSync(file)) continue;
    const m = await crops.imageMeta(file);
    out.push({ index: i + 1, file: img.file, original: img.original, width: m.width, height: m.height, url: `/uploads/${pid}/${cid}/${img.file}`, path: file });
  }
  return out;
}

app.get('/projects/:pid/chapters/:cid/crops', async (req, res) => {
  const { pid, cid } = req.params;
  const project = store.getProject(pid);
  const chapter = store.getChapter(pid, cid);
  if (!project || !chapter) return res.status(404).send('Chapter not found');
  const images = await chapterImagesWithMeta(pid, cid, chapter);
  const state = cropsState(chapter);
  res.render('crops', {
    project, chapter,
    images: images.map((im) => ({ ...im, path: undefined, crops: crops.normaliseCrops(state.byFile[im.file], im) })),
    budgetPercent: state.budgetPercent,
    folder: state.folder || defaultCropFolder(project, chapter),
  });
});

// Panel suggestions (gutter detection)
app.get('/projects/:pid/chapters/:cid/crops/panels', async (req, res) => {
  const { pid, cid } = req.params;
  const chapter = store.getChapter(pid, cid);
  const img = chapter && chapter.images.find((i) => i.file === req.query.file);
  if (!img) return res.status(404).json({ ok: false, error: 'Image not found' });
  try {
    const panels = await crops.detectPanels(path.join(UPLOADS_DIR, pid, cid, img.file));
    res.json({ ok: true, panels });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Save crops (autosave) — body { byFile: { file: [{x,y,w,h}] }, budgetPercent, folder }
app.post('/projects/:pid/chapters/:cid/crops', async (req, res) => {
  const { pid, cid } = req.params;
  const chapter = store.getChapter(pid, cid);
  if (!chapter) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  const b = req.body || {};
  const prev = cropsState(chapter);
  const byFile = {};
  const valid = new Set(chapter.images.map((i) => i.file));
  for (const [file, list] of Object.entries(b.byFile || {})) {
    if (!valid.has(file) || !Array.isArray(list)) continue;
    const m = await crops.imageMeta(path.join(UPLOADS_DIR, pid, cid, file)).catch(() => null);
    if (!m) continue;
    const norm = crops.normaliseCrops(list, m);
    if (norm.length) byFile[file] = norm;
  }
  const next = {
    budgetPercent: Math.min(100, Math.max(10, parseInt(b.budgetPercent, 10) || prev.budgetPercent)),
    byFile: b.byFile ? byFile : prev.byFile,
    folder: b.folder !== undefined ? String(b.folder).slice(0, 400) : prev.folder,
  };
  store.updateChapter(pid, cid, { flags: { ...(chapter.flags || {}), crops: next } });
  res.json({ ok: true, total: Object.values(next.byFile).reduce((a, l) => a + l.length, 0) });
});

/** Saved crops of this chapter as [{ name, file, index, k, rect, path }] (y-order, selected images only) */
function listSavedCrops(pid, cid, chapter, onlyIndexes) {
  const state = cropsState(chapter);
  const out = [];
  chapter.images.forEach((img, i) => {
    const index = i + 1;
    if (onlyIndexes && !onlyIndexes.has(index)) return;
    const list = (state.byFile[img.file] || []).slice().sort((a, b) => a.y - b.y);
    list.forEach((rect, k) => out.push({ name: crops.cropName(index, k), file: img.file, index, k, rect, path: path.join(UPLOADS_DIR, pid, cid, img.file) }));
  });
  return out;
}
const parseIndexes = (q) => (q ? new Set(String(q).split(',').map((n) => parseInt(n, 10)).filter(Number.isInteger)) : null);

// One crop as JPEG — preview ya download (?download=1)
app.get('/projects/:pid/chapters/:cid/crops/one/:index/:k.jpg', async (req, res) => {
  const { pid, cid } = req.params;
  const chapter = store.getChapter(pid, cid);
  if (!chapter) return res.status(404).send('Not found');
  const index = parseInt(req.params.index, 10), k = parseInt(req.params.k, 10);
  const item = listSavedCrops(pid, cid, chapter).find((c) => c.index === index && c.k === k);
  if (!item) return res.status(404).send('Crop not saved yet');
  try {
    const buf = await crops.renderCrop(item.path, item.rect);
    res.setHeader('Content-Type', 'image/jpeg');
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${item.name}.jpg"`);
    res.send(buf);
  } catch (err) { res.status(500).send(err.message); }
});

// Write crops straight into a folder on this PC (CapCut import ke liye) — body { folder, images: "1,2,3" }
app.post('/projects/:pid/chapters/:cid/crops/export', async (req, res) => {
  const { pid, cid } = req.params;
  const project = store.getProject(pid);
  const chapter = store.getChapter(pid, cid);
  if (!project || !chapter) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  const folder = String((req.body && req.body.folder) || '').trim() || defaultCropFolder(project, chapter);
  if (!path.isAbsolute(folder)) return res.status(400).json({ ok: false, error: 'Give a full folder path (e.g. C:\\Users\\you\\Desktop\\crops).' });
  const items = listSavedCrops(pid, cid, chapter, parseIndexes(req.body && req.body.images));
  if (!items.length) return res.status(400).json({ ok: false, error: 'No crops saved for the selected images.' });
  try {
    fs.mkdirSync(folder, { recursive: true });
    const written = [];
    for (const it of items) { fs.writeFileSync(path.join(folder, `${it.name}.jpg`), await crops.renderCrop(it.path, it.rect)); written.push(`${it.name}.jpg`); }
    store.updateChapter(pid, cid, { flags: { ...(chapter.flags || {}), crops: { ...cropsState(chapter), folder } } });
    res.json({ ok: true, folder, written });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ======================================================================
//  Local PC helpers — folder picker (native Windows dialog) + open folder in Explorer
// ======================================================================
let folderPickerBusy = false;
// Body { start, title } → { ok, folder } | { ok, cancelled } — dialog is PC par khulta hai jahan server chal raha hai
app.post('/api/pick-folder', (req, res) => {
  if (process.platform !== 'win32') return res.status(501).json({ ok: false, error: 'The folder window only works on Windows — type the folder path instead.' });
  if (folderPickerBusy) return res.status(409).json({ ok: false, error: 'A folder window is already open — finish that one first.' });
  folderPickerBusy = true;
  const start = String((req.body && req.body.start) || '').trim().slice(0, 500);
  const title = String((req.body && req.body.title) || 'Choose a folder').replace(/[\r\n"]/g, ' ').slice(0, 120);
  const script = path.join(__dirname, 'lib', 'pick-folder.ps1');
  const args = ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', script, '-Start', start, '-Title', title];
  execFile('powershell.exe', args, { timeout: 10 * 60 * 1000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    folderPickerBusy = false;
    if (err && err.killed) return res.status(408).json({ ok: false, error: 'The folder window timed out.' });
    if (err) return res.status(500).json({ ok: false, error: 'Could not open the folder window: ' + String(stderr || err.message).trim().slice(0, 300) });
    const folder = String(stdout || '').trim();
    if (!folder) return res.json({ ok: true, cancelled: true });
    res.json({ ok: true, folder });
  });
});

// Body { folder } → Explorer/Finder mein kholo (sirf existing folder)
app.post('/api/open-folder', (req, res) => {
  const folder = String((req.body && req.body.folder) || '').trim();
  let ok = false;
  try { ok = !!folder && path.isAbsolute(folder) && fs.statSync(folder).isDirectory(); } catch { ok = false; }
  if (!ok) return res.status(400).json({ ok: false, error: 'Folder not found on this PC.' });
  const cmd = process.platform === 'win32' ? ['explorer.exe', [folder]] : process.platform === 'darwin' ? ['open', [folder]] : ['xdg-open', [folder]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
  res.json({ ok: true });
});

// ======================================================================
//  Voiceover (TTS) — har image ki apni alag voice file
// ======================================================================
const mediaDir = (pid, cid) => path.join(OUTPUT_DIR, pid, cid);
// Sections + speak text — roster ke saath (naam ki spelling/pronounce har clip mein ek jaisi)
const sectionsFor = (pid, chapter) =>
  parseSections(chapter.narration, chapter.images.length, { roster: store.listCharacters(pid).filter((c) => !c.pending) });
const ttsOptions = (settings) => ({
  model: settings.ttsModel, voice: settings.ttsVoice, style: settings.ttsStyle,
  temperature: settings.ttsTemperature, language: settings.ttsLanguage,
});
const VOICE_IDS = new Set(VOICE_CATALOG.map((v) => v.voice));
// Har image ki apni voice: chapter.flags.clipVoices = { "<first image number>": "<voice id>" } — warna Settings wali default
const clipVoicesOf = (chapter) => (chapter.flags && chapter.flags.clipVoices) || {};
const voiceFor = (chapter, section, settings) => {
  const v = clipVoicesOf(chapter)[String(section.from)];
  return v && VOICE_IDS.has(v) ? v : settings.ttsVoice;
};
const sectionHash = (section, settings, voice) => clipHash({ ...ttsOptions(settings), voice: voice || settings.ttsVoice, text: section.speakText });
const fileBase = (project, chapter) => `${project.name} - ${chapter.title}`.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'chapter';

/** image-03, image-04… — do sections ek hi image par hon (replay) toh image-04-2 taake ZIP mein naam na takrayein. */
function uniqueClipNames(sections) {
  const seen = {};
  return sections.map((s) => {
    const n = clipName(s);
    seen[n] = (seen[n] || 0) + 1;
    return seen[n] > 1 ? `${n}-${seen[n]}` : n;
  });
}

/** Chapter ki voice state — UI isi ko poll karti hai. Sab disk se: clip file hai = us image ki voice bani hui hai. */
function mediaStatus(pid, cid) {
  const project = store.getProject(pid);
  const chapter = store.getChapter(pid, cid);
  if (!project || !chapter) return null;
  const settings = store.getSettings();
  const dir = mediaDir(pid, cid);
  const base = `/projects/${pid}/chapters/${cid}`;
  const { sections, warnings } = sectionsFor(pid, chapter);
  const chars = sections.reduce((a, s) => a + s.chars, 0);
  // Script likhne ke baad images badli? → [IMAGE n] sections ghalat tasveer par ja sakte hain
  if (chapter.narrationImages && (chapter.narration || '').trim()) {
    const now = chapter.images.map((i) => i.file);
    if (JSON.stringify(now) !== JSON.stringify(chapter.narrationImages))
      warnings.unshift(`Images were added or removed AFTER this script was written (${chapter.narrationImages.length} → ${now.length}). The [IMAGE n] sections may now sit on the wrong pictures — regenerate the script (or fix the markers) before making voices.`);
  }
  const names = uniqueClipNames(sections);

  const overrides = clipVoicesOf(chapter);
  const clips = sections.map((s, i) => {
    const voice = voiceFor(chapter, s, settings);
    const hash = sectionHash(s, settings, voice);
    const meta = readClip(dir, hash);
    const thumbs = chapter.images.slice(s.from - 1, s.to).map((img) => `/uploads/${pid}/${cid}/${img.file}`);
    return {
      idx: s.idx, name: names[i], from: s.from, to: s.to, chars: s.chars,
      text: s.speakText.length > 240 ? s.speakText.slice(0, 237) + '…' : s.speakText,
      thumbs,
      voice, voiceName: voiceLabel(voice), isDefaultVoice: !overrides[String(s.from)],
      ready: !!meta,
      durationSec: meta ? meta.durationSec : 0,
      warning: meta ? meta.warning || '' : '',
      url: meta ? `/output/${pid}/${cid}/clips/${hash}.mp3?t=${encodeURIComponent(meta.createdAt || '')}` : '',
      downloadUrl: `${base}/download/clip/${s.idx}`,
    };
  });
  const ready = clips.filter((c) => c.ready);

  return {
    script: { hasScript: !!(chapter.narration || '').trim(), sections: sections.length, chars, images: chapter.images.length, warnings,
              estMinutes: Math.round((chars / 13) / 60 * 10) / 10 },
    voice: {
      model: settings.ttsModel, voice: settings.ttsVoice, voiceName: voiceLabel(settings.ttsVoice), style: settings.ttsStyle,
      temperature: settings.ttsTemperature, language: settings.ttsLanguage,
      commentaryMode: settings.commentaryMode, hasKeys: settings.keys.length > 0, ttsQuota: store.getQuotaSummary().tts,
    },
    clips,
    voiceOptions: VOICE_CATALOG.map((v) => ({ voice: v.voice, name: v.name, gender: v.gender || '', kind: v.kind || 'classic', pitch: v.pitch || '' })),
    summary: { total: clips.length, ready: ready.length, missing: clips.length - ready.length, totalSec: ready.reduce((a, c) => a + c.durationSec, 0) },
    job: jobs.publicView(jobs.get(cid, 'voiceover')),
    listing: buildListing({ project, chapter }),
    flags: chapter.flags || {},
    project: { author: project.author || '', platform: project.platform || '', official_url: project.official_url || '' },
  };
}

app.get('/projects/:pid/chapters/:cid/media', (req, res) => {
  const m = mediaStatus(req.params.pid, req.params.cid);
  if (!m) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  res.json({ ok: true, ...m });
});

// Voice job: body { idx } = sirf us image ki nayi take; khaali body = jin images ki voice nahi bani (ya text/voice badla) wo sab
app.post('/projects/:pid/chapters/:cid/voiceover', (req, res) => {
  const { pid, cid } = req.params;
  const chapter = store.getChapter(pid, cid);
  if (!chapter) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  if (!(chapter.narration || '').trim()) return res.status(400).json({ ok: false, error: 'Generate (or paste) the script first.' });
  const settings = store.getSettings();
  if (!settings.keys.length) return res.status(400).json({ ok: false, error: 'No Google AI API key set — add keys in Settings.' });
  if (jobs.isRunning(cid, 'voiceover'))
    return res.status(409).json({ ok: false, error: 'A voice job is already running for this chapter.' });
  const { sections } = sectionsFor(pid, chapter);
  if (!sections.length) return res.status(400).json({ ok: false, error: 'Script has no narration text.' });
  const rawIdx = req.body && req.body.idx;
  const one = rawIdx === undefined || rawIdx === null || rawIdx === '' ? null : parseInt(rawIdx, 10);
  if (one !== null && !sections.some((s) => s.idx === one))
    return res.status(400).json({ ok: false, error: 'That image section no longer exists — reload the page.' });

  const outDir = mediaDir(pid, cid);
  fs.mkdirSync(outDir, { recursive: true });
  jobs.start(cid, 'voiceover', async (progress) => {
    const record = (r) => {
      store.saveSettings({ activeKeyIndex: String(r.usedKeyIndex) });
      if (r.requests) recordTokenUsage(pid, cid, r.tokenUsage, settings.ttsModel);
    };
    let result;
    try {
      result = await synthesizeImages({
        keys: settings.keys,
        activeKeyIndex: settings.activeKeyIndex,
        ...ttsOptions(settings),
        sections: (one === null ? sections : sections.filter((s) => s.idx === one)).map((s) => ({ ...s, voice: voiceFor(chapter, s, settings) })),
        force: one === null ? [] : [one],
        outDir,
        onProgress: progress,
        onAttempt: (idx, label) => store.recordKeyRequest(label, settings.ttsModel),
      });
    } catch (err) {
      if (err.partial) record(err.partial); // quota beech mein khatam — jo bana wo saved + count
      throw err;
    }
    record(result);
    // Poora chapter ban gaya — purani clips (badla hua text/voice) saaf
    if (one === null) pruneClips(outDir, sections.map((s) => sectionHash(s, settings, voiceFor(chapter, s, settings))));
    return { requests: result.requests, clips: result.clips.length };
  });
  res.json({ ok: true, media: mediaStatus(pid, cid) });
});

// Ek image ki apni voice set karo — body { from: <image number>, voice: '<voice id>' | '' (= default) }
app.post('/projects/:pid/chapters/:cid/clip-voice', (req, res) => {
  const { pid, cid } = req.params;
  const chapter = store.getChapter(pid, cid);
  if (!chapter) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  const from = parseInt(req.body && req.body.from, 10);
  const voice = String((req.body && req.body.voice) || '').trim();
  if (!Number.isInteger(from) || from < 1) return res.status(400).json({ ok: false, error: 'Bad image number.' });
  if (voice && !VOICE_IDS.has(voice)) return res.status(400).json({ ok: false, error: 'Unknown voice.' });
  if (jobs.isRunning(cid, 'voiceover')) return res.status(409).json({ ok: false, error: 'Wait for the running voice job to finish.' });
  const clipVoices = { ...clipVoicesOf(chapter) };
  if (voice) clipVoices[String(from)] = voice; else delete clipVoices[String(from)];
  store.updateChapter(pid, cid, { flags: { ...(chapter.flags || {}), clipVoices } });
  res.json({ ok: true, media: mediaStatus(pid, cid) });
});

// Ek image ki voice — image-03.mp3
app.get('/projects/:pid/chapters/:cid/download/clip/:idx', (req, res) => {
  const { pid, cid } = req.params;
  const chapter = store.getChapter(pid, cid);
  if (!chapter) return res.status(404).send('Not found');
  const settings = store.getSettings();
  const { sections } = sectionsFor(pid, chapter);
  const i = sections.findIndex((s) => s.idx === parseInt(req.params.idx, 10));
  if (i === -1) return res.status(404).send('Unknown image section');
  const file = clipPaths(mediaDir(pid, cid), sectionHash(sections[i], settings, voiceFor(chapter, sections[i], settings))).mp3;
  if (!fs.existsSync(file)) return res.status(404).send('Voice for this image is not generated yet');
  res.download(file, `${uniqueClipNames(sections)[i]}.mp3`);
});

// Saari image voices ek ZIP mein (image-01.mp3, image-02.mp3…)
app.get('/projects/:pid/chapters/:cid/download/voices.zip', (req, res) => {
  const { pid, cid } = req.params;
  const project = store.getProject(pid);
  const chapter = store.getChapter(pid, cid);
  if (!project || !chapter) return res.status(404).send('Not found');
  const settings = store.getSettings();
  const { sections } = sectionsFor(pid, chapter);
  const names = uniqueClipNames(sections);
  const entries = [];
  sections.forEach((s, i) => {
    const file = clipPaths(mediaDir(pid, cid), sectionHash(s, settings, voiceFor(chapter, s, settings))).mp3;
    if (fs.existsSync(file)) entries.push({ name: `${names[i]}.mp3`, data: fs.readFileSync(file) });
  });
  if (!entries.length) return res.status(404).send('No voices generated yet');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase(project, chapter)} - voices.zip"`);
  res.send(zipStore(entries));
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
    const tts = req.query.tts === '1';
    const models = await listModels(settings.keys[settings.activeKeyIndex] || settings.keys[0], { tts });
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
    voices: VOICE_CATALOG,
    voicesMsg: req.query.voicesMsg || '',
    voicesErr: req.query.voicesErr || '',
  });
});

// Image Voices card ka switch — HAR baar secret number (PIN). Pehli baar PIN banta hai; "changepin" se badalta hai.
app.post('/settings/voices-card', (req, res) => {
  const b = req.body || {};
  const settings = store.getSettings();
  const back = (err, msg) =>
    res.redirect('/settings?' + (err ? 'voicesErr=' + encodeURIComponent(err) : 'voicesMsg=' + encodeURIComponent(msg)) + '#voices-card');
  const pinOk = (p) => /^\d{4,8}$/.test(String(p || ''));
  const action = b.action === 'changepin' ? 'changepin' : 'toggle';
  if (!settings.hasVoicesPin) {
    if (!pinOk(b.newPin)) return back('The secret number must be 4-8 digits.');
    if (b.newPin !== b.newPin2) return back('The two secret numbers do not match.');
    store.setVoicesPin(b.newPin);
    if (action === 'changepin') return back(null, 'Secret number set.');
  } else {
    if (!store.verifyVoicesPin(b.pin)) return back('Wrong secret number — nothing changed.');
    if (action === 'changepin') {
      if (!pinOk(b.newPin)) return back('The new secret number must be 4-8 digits.');
      if (b.newPin !== b.newPin2) return back('The two new secret numbers do not match.');
      store.setVoicesPin(b.newPin);
      return back(null, 'Secret number changed.');
    }
  }
  const enabled = b.enabled === 'on' ? 'on' : 'off';
  store.saveSettings({ showVoicesCard: enabled });
  back(null, enabled === 'on' ? 'Image Voices card is now ON — it shows on every chapter page.' : 'Image Voices card is now OFF — hidden on every chapter page.');
});

app.post('/settings', (req, res) => {
  const b = req.body;
  const str = (v, d = '') => (v === undefined || v === null ? d : String(v)).trim();
  store.saveSettings({
    apiKeys: str(b.apiKeys),
    dailyLimit: String(Math.max(1, parseInt(b.dailyLimit, 10) || 100)),
    activeKeyIndex: '0', // nayi keys save hui — pehli key se shuru
    model: str(b.model, 'gemini-3.8-flash') || 'gemini-3.8-flash',
    commentaryMode: b.commentaryMode === 'on' ? 'on' : 'off',
    ttsModel: str(b.ttsModel, 'gemini-3.8-flash-tts') || 'gemini-3.8-flash-tts',
    ttsVoice: str(b.ttsVoice, 'en-us-zeno') || 'en-us-zeno',
    ttsStyle: str(b.ttsStyle),
    ttsTemperature: str(b.ttsTemperature, '1.1'),
    ttsLanguage: str(b.ttsLanguage), // '' = auto-detect
    ttsDailyLimit: str(b.ttsDailyLimit, '10'),
  });
  res.redirect('/settings?saved=1');
});

app.listen(PORT, () => {
  const APP_VERSION = require('./package.json').version;
  console.log(`\n  Manhwa Narrator v${APP_VERSION} running --> http://localhost:${PORT}\n`);
});
