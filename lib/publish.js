// Upload helpers — YouTube title/description/tags, policy warnings, per-video manifest.
// Rules POLICY.md se aate hain (YPP inauthentic content, WEBTOON fan-video rules, copyright reality).
const fs = require('fs');
const path = require('path');

// Title/description/project name mein ye alfaaz strike/claim ka khatra badhate hain
const FORBIDDEN_PHRASES = ['full chapter', 'full episode', 'read free', 'free read', 'leaked', 'leak', 'raw chapter', 'spoiler raw', 'download'];
// Pirate aggregator / scanlation hosts — in ka naam, link ya watermark video/description/images mein nahi hona chahiye
const AGGREGATOR_HINTS = [
  'utoon', 'asura', 'asurascans', 'reaper', 'reaperscans', 'manhwaclan', 'toonily', 'mangakakalot', 'manganato', 'manganelo',
  'manhuaplus', 'flamecomics', 'flamescans', 'luminous', 'mangadex', 'manhwatop', 'manhwaz', 'manhwa18', 'kunmanga', 'mangabuddy',
  'batoto', 'bato.to', 'webtoonscan', 'manhwaread', 'mangaread', 'manhwafreak', 'freecomic', 'manhwax', 'zinmanga', 'kissmanga',
  'mangago', 'mangapark', 'manhuascan', 'rawkuma', 'newtoki', 'manatoki', 'comico', 'hiperdex', 'topmanhua', 'manhwalike', 'reset-scans',
];

function findForbidden(text) {
  const t = (text || '').toLowerCase();
  return FORBIDDEN_PHRASES.filter((p) => t.includes(p));
}

function findAggregators(text) {
  const t = (text || '').toLowerCase().replace(/[\s_-]/g, '');
  return AGGREGATOR_HINTS.filter((a) => t.includes(a.replace(/[.\s_-]/g, '')));
}

/**
 * @param {object} o
 * @param {object} o.project  { name, author, platform, official_url }
 * @param {object} o.chapter  { title, flags }
 * @param {object} o.settings { channelName }
 * @param {object} [o.render] { coveragePercent, avgShownPercent, durationSec }
 */
function buildListing({ project, chapter, settings, render }) {
  const series = project.name.trim();
  const chTitle = (chapter.title || '').trim();
  const title = `${series} ${chTitle} — Recap & Analysis (Roman Urdu)`.slice(0, 100);

  const lines = [];
  lines.push(`${series} — ${chTitle} ka recap aur analysis, Roman Urdu mein, apne alfaaz mein.`);
  lines.push('');
  lines.push('📖 Source credit:');
  lines.push(`Series: ${series}`);
  if (project.author) lines.push(`Author/Artist: ${project.author}`);
  if (project.platform) lines.push(`Read the full chapter officially on ${project.platform}${project.official_url ? ': ' + project.official_url : ''}`);
  else lines.push('Please support the official release.');
  lines.push('All panels belong to the original author/publisher and are used here for commentary and review.');
  lines.push('');
  lines.push('🎙️ Narration: original script (own words, no verbatim dialogue), voiced with AI text-to-speech.');
  lines.push('🎵 Music: none / YouTube Audio Library only.');
  if (settings.channelName) lines.push(`📺 ${settings.channelName}`);
  lines.push('');
  lines.push('#manhwa #manhwarecap #romanurdu #webtoon #manhwaexplained');
  const description = lines.join('\n');

  const tags = ['manhwa', 'manhwa recap', 'manhwa explained', 'roman urdu', 'webtoon', 'manhwa hindi', 'manhwa urdu', series.toLowerCase(), 'recap and analysis'];

  const warnings = [];
  const fb = findForbidden(series + ' ' + chTitle);
  if (fb.length) warnings.push(`Title contains risky phrase(s): ${fb.join(', ')} — remove them.`);
  const ag = findAggregators(series + ' ' + chTitle + ' ' + (project.official_url || '') + ' ' + (project.platform || ''));
  if (ag.length) warnings.push(`Aggregator/pirate site name found in project info: ${ag.join(', ')} — never link or name these.`);
  const wm = (chapter.flags && chapter.flags.watermarks) || [];
  if (wm.length) warnings.push(`Gemini saw site watermark(s) in the images: ${wm.join(', ')}. Images from pirate aggregators weaken any fair-use/good-faith defence — prefer official-source images.`);
  if (!project.platform) warnings.push('Official platform not set on the project — add it so the credit block and end card can link to the official release.');

  return { title, description, tags, warnings };
}

/** Evidence manifest — dispute/compliance ke liye har render ke saath save hota hai. */
function writeManifest({ outDir, project, chapter, settings, audio, render, listing, sections }) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    app: 'manhwa-narrator',
    project: { id: project.id, name: project.name, author: project.author || '', platform: project.platform || '', official_url: project.official_url || '' },
    chapter: { id: chapter.id, title: chapter.title, images: chapter.images.length, flags: chapter.flags || {} },
    script: { sections: sections.length, chars: sections.reduce((a, s) => a + (s.chars || 0), 0), commentaryMode: settings.commentaryMode },
    voiceover: audio ? { model: audio.model, voice: audio.voice, totalSec: audio.totalSec, chunks: (audio.chunks || []).length } : null,
    video: render ? { preset: render.preset, W: render.W, H: render.H, fps: render.fps, durationSec: render.durationSec, coveragePercent: render.coveragePercent, avgShownPercent: render.avgShownPercent, music: 'none' } : null,
    listing: listing ? { title: listing.title, warnings: listing.warnings } : null,
    policyNotes: [
      'Narration is an original script in the narrator\'s own words (no verbatim dialogue).',
      'Only a portion of each strip is shown (coveragePercent) — not the complete page sequence.',
      'No background music; AI TTS voice (generic, not a real person) — YouTube AI disclosure not required for this type of content.',
      'Not made for kids.',
    ],
  };
  const file = path.join(outDir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

module.exports = { buildListing, writeManifest, findForbidden, findAggregators, AGGREGATOR_HINTS };
