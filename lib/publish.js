// Upload helpers — YouTube title/description/tags aur policy warnings (video aap khud editor mein banate ho).
// Rules POLICY.md se aate hain (YPP inauthentic content, WEBTOON fan-video rules, copyright reality).

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
 */
/**
 * YouTube description — v2 (2026-10-22), built from YouTube Help "Tips for video descriptions" + hashtag rules, vidIQ 2026 and
 * deeployCO/youtube-seo-skills: hook ≤150 chars with the primary keyword early → official link above the fold → a per-video
 * unique summary placeholder (YouTube asks for unique descriptions) → bullets → watch next / playlist → CTA → credits → about →
 * contact → AI + kids disclosures → condensed fair-use block → topics line → only 5 hashtags (the 3 "most engaging" show above the title).
 * Stays under YouTube's 5000 chars (~3,000). Same structure as output/youtube/UNIVERSAL … - ENGLISH template.
 */
function buildListing({ project, chapter }) {
  const series = project.name.trim();
  const chTitle = (chapter.title || '').trim();
  const kind = (project.type || 'manhwa').toLowerCase();
  const kindLabel = kind === 'manhua' ? 'Manhua' : kind === 'manga' ? 'Manga' : 'Manhwa';
  const cutWords = (s, max) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, ''));
  const baseTitle = `${series} ${chTitle} Explained in Hindi/Urdu`;
  const title = (baseTitle.length + 15 <= 70 ? `${baseTitle} | ${kindLabel} Recap` : baseTitle).slice(0, 100); // ≤70 = mobile par poora
  const hashtagBase = series.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  const official = project.platform
    ? `${project.platform}${project.official_url ? ': ' + project.official_url : ''}`
    : '[official platform + link — set it on the project page]';

  const lines = [];
  const kl = kindLabel.toLowerCase();
  // Hook ≤150 chars (first 100-160 chars are all that shows before "Show more"): primary keyword as early as possible,
  // long series names drop the tail clause, never a cut word.
  const hookHead = `${series} ${chTitle} Explained in Hindi/Urdu`;
  const hookTails = [
    ` — full ${kl} recap in our own words, with analysis, theories and reactions. No boring parts.`,
    ` — full ${kl} recap in our own words, with analysis and reactions.`,
    ` — full ${kl} recap in our own words.`,
    ` — full ${kl} recap.`,
    '',
  ];
  lines.push(hookTails.map((t) => hookHead + t).find((h) => h.length <= 150) || cutWords(hookHead, 150));
  // Primary link right under the hook (above the fold): official release
  lines.push(`📖 Read it officially on ${official}`);
  lines.push('');
  lines.push('[CHAPTER SUMMARY — write 2-3 unique lines in English for THIS chapter: what happens, who it focuses on, and the cliffhanger without spoiling the ending. YouTube asks for a unique description on every video.]');
  lines.push('');
  lines.push(`In this ${series} ${chTitle} Hindi explanation you get:`);
  lines.push('⚔️ The whole chapter, panel by panel — just the story, nothing important skipped');
  lines.push('🧠 My analysis and theories — what happened, why, and what it sets up next');
  lines.push("👑 The main character's journey, choices and power-ups");
  lines.push('🎙️ Fast, clear Hindi / Urdu narration');
  lines.push('');
  lines.push('▶️ WATCH NEXT');
  lines.push('Next chapter: [NEXT VIDEO LINK]');
  lines.push(`${series} — full Hindi/Urdu playlist (every chapter in order): [PLAYLIST LINK]`);
  lines.push('');
  lines.push('👉 Don\'t miss the next chapter — SUBSCRIBE 🔔 to [CHANNEL NAME]: [CHANNEL LINK]');
  lines.push('💬 QUESTION OF THE DAY: [one question about this chapter] — tell me in the comments 👇');
  lines.push('');
  lines.push('✍️ CREDITS — SUPPORT THE CREATORS');
  lines.push(`Story & art: ${project.author || '[AUTHOR / ARTIST / PUBLISHER]'} · Official release: ${official}`);
  lines.push('Please read the full chapter on the official platform; that is the only place where the creators actually get supported.');
  lines.push('');
  lines.push('👋 ABOUT [CHANNEL NAME]');
  lines.push('Manhwa, Manhua, Webtoon and Manga stories explained in Hindi / Urdu — in our own words, with our own analysis and reactions, across many different series. New recaps every week.');
  lines.push('');
  lines.push('📩 BUSINESS / COPYRIGHT: [YOUR EMAIL]');
  lines.push('Rights holders: if you object to any part of this video, please email us first — we will add credit or remove the content right away. A direct conversation before a strike is always appreciated.');
  lines.push('');
  lines.push('🎙️ AI DISCLOSURE: The narration is an AI text-to-speech voice. The script, analysis and commentary are our own; no verbatim dialogue. Background music: none.');
  lines.push('ℹ️ This video is not made for kids (COPPA).');
  lines.push('');
  lines.push('⚖️ FAIR USE & COPYRIGHT DISCLAIMER');
  lines.push(`Copyright Disclaimer under Section 107 of the Copyright Act 1976: allowance is made for "fair use" for purposes such as criticism, comment, news reporting, teaching, scholarship, education and research. This video is commentary, review and criticism: we add our own narration, storytelling, analysis and opinions, show only a limited portion of the chapter's panels, and it is not a substitute for reading the original — it exists to send new readers to the official release. We do not own any artwork, panels or characters shown; all rights belong to their respective owners${project.author ? ` (${project.author}${project.platform ? ' and ' + project.platform : ''})` : ''}. No copyright infringement intended — rights holders, contact us at the email above and we will promptly address any concern.`);
  lines.push('');
  lines.push(`🔍 Topics: ${series.toLowerCase()} explained in hindi, ${series.toLowerCase()} ${chTitle.toLowerCase()} hindi, ${kl} explained in hindi, ${kl} recap in hindi, ${kl} explained in urdu, manhua explained in hindi, manga explained in hindi, webtoon explained in hindi, overpowered mc ${kl}, revenge ${kl}, system ${kl}, murim ${kl}, cultivation manhua, isekai ${kl}, regression ${kl}`);
  lines.push('');
  // Hashtags: only 5 — YouTube allows ≤60 but "the more tags you add, the less relevant they become"; the 3 "most engaging" show above the title.
  const K = kindLabel;
  lines.push(`#${hashtagBase} #${K}ExplainedInHindi #${K}Recap #${K}ExplainedInUrdu #${K}`);
  const description = lines.join('\n').slice(0, 5000);

  const tags = [
    `${series} ${chTitle} explained in hindi`.toLowerCase(), series.toLowerCase(), `${kindLabel} explained in hindi`.toLowerCase(), `${kindLabel} recap in hindi`.toLowerCase(),
    `${kindLabel} explained in urdu`.toLowerCase(), 'overpowered mc', 'revenge story', 'webtoon explained in hindi', `${kindLabel} recap`.toLowerCase(),
  ];

  const warnings = [];
  const fb = findForbidden(series + ' ' + chTitle);
  if (fb.length) warnings.push(`Title contains risky phrase(s): ${fb.join(', ')} — remove them.`);
  const ag = findAggregators(series + ' ' + chTitle + ' ' + (project.official_url || '') + ' ' + (project.platform || ''));
  if (ag.length) warnings.push(`Aggregator/pirate site name found in project info: ${ag.join(', ')} — never link or name these.`);
  const wm = (chapter.flags && chapter.flags.watermarks) || [];
  if (wm.length) warnings.push(`Gemini saw site watermark(s) in the images: ${wm.join(', ')}. Images from pirate aggregators weaken any fair-use/good-faith defence — prefer official-source images.`);
  if (!project.platform) warnings.push('Official platform not set on the project — add it so the description credit block can link to the official release.');

  return { title, description, tags, warnings };
}

module.exports = { buildListing, findForbidden, findAggregators, AGGREGATOR_HINTS };
