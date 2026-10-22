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
 * YouTube description — SEO structure (youtube-seo-optimize skill): hook line ≤150 chars with the primary keyword first,
 * short body, official-source links + credits, about/contact, AI disclosure, fair-use disclaimer, topics line,
 * ~39 related hashtags (YouTube ignores all above 60; the 3 "most engaging" show above the title → series + main keyword first).
 * Stays under YouTube's 5000 chars. English (2026-10-22) — same structure as output/youtube/UNIVERSAL … - ENGLISH template.
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
  // Hook ≤150 chars: lambi series ka naam ho toh poori tail clause girti hai, aadha lafz kabhi nahi
  const hookHead = `${series} ${chTitle} Explained in Hindi/Urdu`;
  const hookTails = [
    ` — the full story in our own words, with analysis and reactions. Full ${kindLabel.toLowerCase()} recap in Hindi.`,
    ' — the full story in our own words, with analysis and reactions.',
    ' — the full story in our own words.',
    ` — full ${kindLabel.toLowerCase()} recap.`,
    '',
  ];
  lines.push(hookTails.map((t) => hookHead + t).find((h) => h.length <= 150) || cutWords(hookHead, 150));
  lines.push('');
  lines.push(`In this video, ${series} ${chTitle} is explained in Hindi / Urdu — the story of every panel, the characters' decisions, and the twist that sets up what comes next. If you want to understand manhwa, manhua, webtoon or manga stories in Hindi — with straight, clear and fast narration — this video is for you.`);
  lines.push('');
  lines.push(`In this ${kindLabel} Explained in Hindi video you get:`);
  lines.push('⚔️ An image-by-image recap of the chapter — no boring parts, just the story');
  lines.push('🧠 My analysis and theories — what happened, why it happened, and what could happen next');
  lines.push("👑 The main character's journey — Overpowered MC, revenge, system, cultivation, murim, regression, isekai — whatever this series' flavour is");
  lines.push('🎙️ Fast, clear Hindi / Urdu narration');
  lines.push('');
  lines.push(`This is ${series} ${chTitle}. Read the full chapter officially here and support the creators: ${official}`);
  lines.push('');
  lines.push('💬 QUESTION OF THE DAY: [one question about this chapter for the viewers] — tell me in the comments 👇');
  lines.push('');
  lines.push(`👉 Don't miss the next chapter — SUBSCRIBE 🔔. If you enjoyed the video, LIKE 👍 and SHARE 🔁 it with other ${kindLabel.toLowerCase()} fans.`);
  lines.push('');
  lines.push('🔗 OFFICIAL SOURCE — SUPPORT THE CREATORS');
  lines.push(`📖 Read it officially: ${official}`);
  if (project.author) lines.push(`✍️ Credits: ${project.author}`);
  lines.push('Please read the full chapter on the official platform — that is the only place where the creators actually get supported.');
  lines.push('');
  lines.push('📺 MORE FROM THIS SERIES');
  lines.push(`${series} — full Hindi/Urdu playlist: [PLAYLIST LINK]`);
  lines.push('Next chapter: coming soon');
  lines.push('');
  lines.push('👋 ABOUT [CHANNEL NAME]');
  lines.push('We explain Manhwa, Manhua, Webtoon and Manga stories in Hindi / Urdu — in our own words, with our own analysis and reactions, across many different series. New recaps every week. Subscribe: [CHANNEL LINK]');
  lines.push('');
  lines.push('📩 BUSINESS / COPYRIGHT CONTACT');
  lines.push('[YOUR EMAIL] — Rights holders: if you have any objection to any part of this video, please email us first; we will add credit or remove the content right away. A direct conversation before a strike is always appreciated, thank you.');
  lines.push('');
  lines.push('🎙️ AI DISCLOSURE');
  lines.push('The narration is an AI text-to-speech voice. The script, analysis and commentary are our own (no verbatim dialogue). Background music: none.');
  lines.push('');
  lines.push('ℹ️ NOTE: This video is not made for kids (Not made for kids / COPPA).');
  lines.push('');
  lines.push('⚖️ FAIR USE & COPYRIGHT DISCLAIMER');
  lines.push('Copyright Disclaimer under Section 107 of the Copyright Act 1976: allowance is made for "fair use" for purposes such as criticism, comment, news reporting, teaching, scholarship, education and research. Fair use is a use permitted by copyright statute that might otherwise be infringing. Non-profit, educational or personal use tips the balance in favor of fair use.');
  lines.push('');
  lines.push(`This video is a work of commentary, review and criticism. It is transformative in nature: we provide our own narration, storytelling, analysis and opinions to explain and review the ${kindLabel.toLowerCase()}. Only a limited portion of the chapter's panels is shown, and the video is not a substitute for reading the original work — it is made to send new readers to the official release.`);
  lines.push('');
  lines.push(`We do not own any of the artwork, panels or characters shown. All rights belong to their respective owners${project.author ? ` (${project.author}${project.platform ? ', ' + project.platform : ''})` : ''}. No copyright infringement intended. If you are a rights holder and have any concern about the use of your material, please contact us at the email above and we will promptly address it.`);
  lines.push('');
  lines.push(`🔍 Topics: ${kindLabel.toLowerCase()} explained in hindi, ${kindLabel.toLowerCase()} recap in hindi, ${kindLabel.toLowerCase()} explained in urdu, manhua explained in hindi, manga explained in hindi, webtoon explained in hindi, anime explained in hindi, overpowered mc, revenge, system, murim, cultivation, isekai, regression, ${series.toLowerCase()} hindi`);
  lines.push('');
  // Hashtags: YouTube 60 se zyada par sab ignore karta hai; title ke upar "most engaging" 3 dikhte hain → series + main keyword pehle.
  // Sirf related hashtags (unrelated = misleading metadata). ~39 total.
  const K = kindLabel;
  lines.push(`#${hashtagBase} #${K}ExplainedInHindi #${K}Recap`);
  lines.push(`#${K}ExplainedInUrdu #${K}RecapInHindi #${K}InHindi #${K}Hindi #${K}Explained #${K}Explanation #Hindi${K} #Urdu${K} #${K}Urdu`);
  lines.push('#MangaExplainedInHindi #ManhuaExplainedInHindi #WebtoonExplainedInHindi #WebtoonHindi #MangaRecapInHindi #ManhuaRecapInHindi #ComicExplainedInHindi');
  lines.push('#AnimeExplainedInHindi #AnimeRecapHindi #StoryExplainedInHindi #HindiExplanation #UrduExplanation');
  lines.push('#OverpoweredMC #OPMC #RevengeManhwa #SystemManhwa #MurimManhwa #CultivationManhua #IsekaiManhwa #RegressionManhwa #ActionManhwa #FantasyManhwa');
  lines.push('#Manhwa #Manhua #Webtoon #Manga');
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
