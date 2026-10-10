require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const store = require('./lib/store');
const { generateNarration, listModels } = require('./lib/gemini');
const { recordTokenUsage, getTokenStats } = require('./lib/store');
const jobs = require('./lib/jobs');
const { parseSections } = require('./lib/sections');
const { synthesizeChapter, TTS_VOICES } = require('./lib/tts');
const { renderChapterVideo, PRESETS } = require('./lib/video');
const { buildListing, writeManifest } = require('./lib/publish');

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
  res.render('project', { project });
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
  `For characters already in the roster, use the roster name. Add a new entry for any new character. If this chapter reveals a NEW relationship for an existing character, include that character with the updated relationships.\n` +
  `Then write "${SOURCE_MARKER}" alone on a new line, followed by one JSON object (ENGLISH): {"watermarks": ["every website name, URL, logo banner or scanlation-group credit visible anywhere in the images, e.g. example.net"], "notes": "one short line about the source if relevant, else empty"}. Use an empty array if no such text is visible.`;

// Commentary addon — policy layer (Settings → Script → commentary mode)
function getCommentaryAddon() {
  try {
    return fs.readFileSync(path.join(PROMPTS_DIR, 'commentary-addon.md'), 'utf8');
  } catch {
    return '';
  }
}

function parseJsonLoose(text, open, close) {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function splitNarrationAndCharacters(text) {
  const idx = text.indexOf(CHAR_MARKER);
  if (idx === -1) return { narration: text.trim(), detected: [], source: null };
  const narration = text.slice(0, idx).trim();
  let tail = text.slice(idx + CHAR_MARKER.length);
  let sourcePart = '';
  const sIdx = tail.indexOf(SOURCE_MARKER);
  if (sIdx !== -1) { sourcePart = tail.slice(sIdx + SOURCE_MARKER.length); tail = tail.slice(0, sIdx); }
  const clean = (s) => s.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const detected = parseJsonLoose(clean(tail), '[', ']') || [];
  const source = sourcePart ? parseJsonLoose(clean(sourcePart), '{', '}') : null;
  return { narration, detected: Array.isArray(detected) ? detected : [], source };
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
    const addon = settings.commentaryMode === 'on' ? getCommentaryAddon() : '';
    const finalPrompt = settings.prompt + addon + buildRosterBlock(roster) + EXTRACT_INSTRUCTION;
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
    const { narration, detected, source } = splitNarrationAndCharacters(result.text);
    const mergeResult = store.mergeDetectedCharacters(pid, detected);
    const flags = { ...(chapter.flags || {}) };
    if (source && Array.isArray(source.watermarks)) {
      flags.watermarks = source.watermarks.map((w) => String(w).trim().slice(0, 60)).filter(Boolean).slice(0, 8);
      if (source.notes) flags.sourceNotes = String(source.notes).slice(0, 200);
    }
    store.updateChapter(pid, cid, { narration, status: 'done', error: '', flags });
    res.json({
      ok: true,
      narration,
      characters: mergeResult,
      flags,
      tokenUsage: result.tokenUsage,
      keyInfo: {
        usedKeyIndex: result.usedKeyIndex,
        usedKeyLabel: result.usedKeyLabel,
        rotated: result.rotated,
        failures: result.failures,
      },
      quota: store.getQuotaSummary(),
      media: mediaStatus(pid, cid),
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
  res.json({ ok: true, media: mediaStatus(req.params.pid, req.params.cid) });
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
//  Voiceover (TTS) + Video assembly
// ======================================================================
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const mediaDir = (pid, cid) => path.join(OUTPUT_DIR, pid, cid);
const audioSig = (settings) => [settings.ttsModel, settings.ttsVoice, settings.ttsStyle, settings.ttsMaxChars].join('|');
const audioHashFor = (chapter, settings) => sha((chapter.narration || '') + '\u0001' + audioSig(settings));
const videoSig = (settings) =>
  [settings.videoPreset, settings.coveragePercent, settings.channelName, settings.trimFirstTop, settings.trimLastBottom,
   settings.holdSec, settings.videoFps, settings.videoQuality].join('|');
const videoHashFor = (audioHash, settings, project) =>
  sha(audioHash + '\u0001' + videoSig(settings) + '\u0001' + [project.name, project.platform, project.official_url, project.author].join('|'));

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Chapter ki media state — UI isi ko poll karti hai. */
function mediaStatus(pid, cid) {
  const project = store.getProject(pid);
  const chapter = store.getChapter(pid, cid);
  if (!project || !chapter) return null;
  const settings = store.getSettings();
  const media = store.getMedia(cid);
  const dir = mediaDir(pid, cid);
  const base = `/output/${pid}/${cid}`;
  const { sections, warnings } = parseSections(chapter.narration, chapter.images.length);
  const chars = sections.reduce((a, s) => a + s.chars, 0);

  const audioFile = path.join(dir, 'voiceover.mp3');
  const audioReady = !!(media && media.audio && fs.existsSync(audioFile));
  const curAudioHash = audioHashFor(chapter, settings);
  const audioStale = audioReady && media.audio_hash !== curAudioHash;
  const audio = audioReady
    ? {
        url: `${base}/voiceover.mp3?v=${encodeURIComponent(media.updatedAt)}`,
        totalSec: media.audio_sec,
        model: media.tts_model,
        voice: media.voice,
        chunks: (media.audio.chunks || []).length,
        sections: (media.audio.sections || []).length,
        stale: audioStale,
        updatedAt: media.updatedAt,
        warnings: media.audio.warnings || [],
        requests: media.audio.requests || null,
      }
    : null;

  const videoFile = path.join(dir, 'video.mp4');
  const videoReady = !!(media && media.has_video && fs.existsSync(videoFile));
  const manifest = videoReady ? readJsonSafe(path.join(dir, 'manifest.json')) : null;
  const video = videoReady
    ? {
        url: `${base}/video.mp4?v=${encodeURIComponent(media.updatedAt)}`,
        srtUrl: `${base}/captions.srt`,
        descriptionUrl: `${base}/description.txt`,
        manifestUrl: `${base}/manifest.json`,
        durationSec: media.video_sec,
        stale: audioStale || media.video_hash !== videoHashFor(media.audio_hash, settings, project),
        preset: manifest && manifest.video ? manifest.video.preset : settings.videoPreset,
        avgShownPercent: manifest && manifest.video ? manifest.video.avgShownPercent : null,
        coveragePercent: manifest && manifest.video ? manifest.video.coveragePercent : null,
      }
    : null;

  const listing = buildListing({ project, chapter, settings });
  return {
    script: { hasScript: !!(chapter.narration || '').trim(), sections: sections.length, chars, images: chapter.images.length, warnings,
              estMinutes: Math.round((chars / 13) / 60 * 10) / 10 },
    settings: {
      ttsModel: settings.ttsModel, ttsVoice: settings.ttsVoice, ttsMaxChars: settings.ttsMaxChars,
      videoPreset: settings.videoPreset, coveragePercent: settings.coveragePercent, commentaryMode: settings.commentaryMode,
      channelName: settings.channelName, hasKeys: settings.keys.length > 0,
      ttsQuota: store.getQuotaSummary().tts,
    },
    audio,
    video,
    jobs: { voiceover: jobs.publicView(jobs.get(cid, 'voiceover')), video: jobs.publicView(jobs.get(cid, 'video')) },
    listing,
    flags: chapter.flags || {},
    project: { author: project.author || '', platform: project.platform || '', official_url: project.official_url || '' },
  };
}

app.get('/projects/:pid/chapters/:cid/media', (req, res) => {
  const m = mediaStatus(req.params.pid, req.params.cid);
  if (!m) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  res.json({ ok: true, ...m });
});

// Start voiceover job
app.post('/projects/:pid/chapters/:cid/voiceover', (req, res) => {
  const { pid, cid } = req.params;
  const chapter = store.getChapter(pid, cid);
  if (!chapter) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  if (!(chapter.narration || '').trim()) return res.status(400).json({ ok: false, error: 'Generate (or paste) the script first.' });
  const settings = store.getSettings();
  if (!settings.keys.length) return res.status(400).json({ ok: false, error: 'No Google AI API key set — add keys in Settings.' });
  if (jobs.isRunning(cid, 'voiceover') || jobs.isRunning(cid, 'video'))
    return res.status(409).json({ ok: false, error: 'A job is already running for this chapter.' });
  const { sections } = parseSections(chapter.narration, chapter.images.length);
  if (!sections.length) return res.status(400).json({ ok: false, error: 'Script has no narration text.' });

  const outDir = mediaDir(pid, cid);
  fs.mkdirSync(outDir, { recursive: true });
  const hash = audioHashFor(chapter, settings);
  jobs.start(cid, 'voiceover', async (progress) => {
    const result = await synthesizeChapter({
      keys: settings.keys,
      activeKeyIndex: settings.activeKeyIndex,
      model: settings.ttsModel,
      voice: settings.ttsVoice,
      style: settings.ttsStyle,
      maxChars: settings.ttsMaxChars,
      sections,
      outDir,
      onProgress: progress,
      onAttempt: (idx, label) => store.recordKeyRequest(label, settings.ttsModel),
    });
    store.saveSettings({ activeKeyIndex: String(result.usedKeyIndex) });
    if (result.requests) recordTokenUsage(pid, cid, result.tokenUsage, settings.ttsModel);
    store.saveMedia(pid, cid, {
      audio: {
        sections: result.sections, chunks: result.chunks, totalSec: result.totalSec,
        model: settings.ttsModel, voice: settings.ttsVoice, style: settings.ttsStyle,
        sectionCount: sections.length, createdAt: new Date().toISOString(),
        warnings: result.warnings || [], requests: result.requests,
      },
      audio_hash: hash,
      audio_sec: result.totalSec,
      tts_model: settings.ttsModel,
      voice: settings.ttsVoice,
    });
    return { totalSec: result.totalSec, requests: result.requests, chunks: result.chunks.length };
  });
  res.json({ ok: true, media: mediaStatus(pid, cid) });
});

// Start video render job
app.post('/projects/:pid/chapters/:cid/video', (req, res) => {
  const { pid, cid } = req.params;
  const project = store.getProject(pid);
  const chapter = store.getChapter(pid, cid);
  if (!project || !chapter) return res.status(404).json({ ok: false, error: 'Chapter not found' });
  if (!chapter.images.length) return res.status(400).json({ ok: false, error: 'No images in this chapter.' });
  const settings = store.getSettings();
  const media = store.getMedia(cid);
  const outDir = mediaDir(pid, cid);
  if (!media || !media.audio || !fs.existsSync(path.join(outDir, 'voiceover.wav')))
    return res.status(400).json({ ok: false, error: 'Generate the voiceover first.' });
  if (media.audio_hash !== audioHashFor(chapter, settings))
    return res.status(400).json({ ok: false, error: 'The script (or voice settings) changed after the voiceover was made — regenerate the voiceover first.' });
  if (jobs.isRunning(cid, 'voiceover') || jobs.isRunning(cid, 'video'))
    return res.status(409).json({ ok: false, error: 'A job is already running for this chapter.' });

  const { sections } = parseSections(chapter.narration, chapter.images.length);
  const timeline = media.audio.sections || [];
  if (sections.length !== timeline.length)
    return res.status(400).json({ ok: false, error: 'Section count changed — regenerate the voiceover first.' });
  const timed = sections.map((s) => ({ ...s, ...timeline.find((t) => t.idx === s.idx) }));
  const imagePaths = chapter.images.map((img) => path.join(UPLOADS_DIR, pid, cid, img.file));

  jobs.start(cid, 'video', async (progress) => {
    const render = await renderChapterVideo({
      imagePaths,
      sections: timed,
      voiceoverWav: path.join(outDir, 'voiceover.wav'),
      outDir,
      settings,
      credits: { title: `${project.name} — ${chapter.title}`, platform: project.platform, url: project.official_url, author: project.author },
      onProgress: progress,
    });
    const listing = buildListing({ project, chapter, settings, render });
    fs.writeFileSync(
      path.join(outDir, 'description.txt'),
      `TITLE:\n${listing.title}\n\nDESCRIPTION:\n${listing.description}\n\nTAGS:\n${listing.tags.join(', ')}\n` +
        (listing.warnings.length ? `\nWARNINGS:\n- ${listing.warnings.join('\n- ')}\n` : '')
    );
    writeManifest({ outDir, project, chapter, settings, audio: media.audio, render, listing, sections });
    store.saveMedia(pid, cid, { has_video: 1, video_hash: videoHashFor(media.audio_hash, settings, project), video_sec: render.durationSec });
    return { durationSec: render.durationSec, avgShownPercent: render.avgShownPercent };
  });
  res.json({ ok: true, media: mediaStatus(pid, cid) });
});

// Downloads with nice file names
app.get('/projects/:pid/chapters/:cid/download/:what', (req, res) => {
  const project = store.getProject(req.params.pid);
  const chapter = store.getChapter(req.params.pid, req.params.cid);
  if (!project || !chapter) return res.status(404).send('Not found');
  const files = {
    mp3: 'voiceover.mp3', wav: 'voiceover.wav', mp4: 'video.mp4', srt: 'captions.srt', description: 'description.txt', manifest: 'manifest.json',
  };
  const file = files[req.params.what];
  if (!file) return res.status(404).send('Unknown download');
  const abs = path.join(mediaDir(req.params.pid, req.params.cid), file);
  if (!fs.existsSync(abs)) return res.status(404).send('File not ready yet');
  const base = `${project.name} - ${chapter.title}`.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'chapter';
  res.download(abs, `${base}${path.extname(file)}`);
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
    voices: TTS_VOICES,
    presets: Object.keys(PRESETS),
  });
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
    ttsVoice: str(b.ttsVoice, 'Charon') || 'Charon',
    ttsStyle: str(b.ttsStyle),
    ttsMaxChars: str(b.ttsMaxChars, '2000'),
    ttsDailyLimit: str(b.ttsDailyLimit, '10'),
    videoPreset: b.videoPreset === 'portrait' ? 'portrait' : 'landscape',
    videoFps: str(b.videoFps, '30'),
    videoQuality: str(b.videoQuality, '22'),
    coveragePercent: str(b.coveragePercent, '50'),
    holdSec: str(b.holdSec, '0.4'),
    channelName: str(b.channelName).slice(0, 60),
    trimFirstTop: str(b.trimFirstTop, '0'),
    trimLastBottom: str(b.trimLastBottom, '0'),
  });
  res.redirect('/settings?saved=1');
});

app.listen(PORT, () => {
  const APP_VERSION = require('./package.json').version;
  console.log(`\n  Manhwa Narrator v${APP_VERSION} running --> http://localhost:${PORT}\n`);
});
