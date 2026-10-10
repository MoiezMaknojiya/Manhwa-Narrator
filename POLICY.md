# Copyright & YouTube policy notes for manhwa recap videos

Research date: **10 October 2026**. Everything below was checked against official YouTube Help pages, publisher pages and dated news. This is a working summary for this tool, not legal advice. Re-check before relying on any of it; policies changed in 2024, 2025 and 2026.

## The short version

1. **YouTube does not need a Content ID match to hurt you.** Content ID fingerprints audio/video, not comic pages. Publishers (Shueisha, Kakao, Naver and the firms they hire) remove recap videos by manual DMCA takedown, which lands as a **copyright strike**. Three strikes in 90 days terminates the channel. There is no "claim and share revenue" buffer for images.
2. **Pure retelling is not transformative.** In July 2026 a US federal court (KADOKAWA subpoena case) found that anime recap channels "describe and narrate the work rather than criticize, parody, or alter it", so fair use did not protect them even at ~15% of an episode. Japan convicted the operator of a text-only plot-summary site in April 2026. Translating into Roman Urdu is a derivative use, not a transformation.
3. **YouTube Partner Program judges the channel, not the video.** The July 2025 "inauthentic content" update (and the July 2026 clarification) lists what fails: "image slideshows… or scrolling text with little narrative or value", "readings of others' material without original creation", "AI-generated content made with generic or unoriginal templates", "clips… edited together with little narrative". What passes: "rewritten dialogue or voiceovers", "edited footage with a storyline", and content where the creator can "explain their contribution". In January 2026 YouTube terminated 16 channels (35M subs) in one sweep.
4. **WEBTOON is the only publisher with published fan-video rules** (updated 6 Nov 2025): WEBTOON Originals only, free episodes only (no Fast Pass / Daily Pass), credit and link WEBTOON, **at most 20 panels or 50% of the episode, whichever is less**, no links to piracy sites, takedowns at their discretion.
5. **AI disclosure is not required** for a generic TTS voice over drawn panels. The "altered or synthetic content" label is mandatory only for realistic content (a real person saying something they did not, altered real events, AI music as the main focus). Disclosing anyway costs nothing.
6. **Music:** only the YouTube Audio Library is guaranteed not to be claimed. Other "royalty-free" packs are not. Even a few seconds of claimed music blocks monetization on that video.
7. **Pirate aggregator images** (sites like the one watermarked on the sample chapter) are themselves infringing copies. A visible aggregator watermark or URL ties the video to piracy and destroys any good-faith argument. Cropping the watermark does not change the legal status of the image.
8. **Not made for kids.** Manhwa recaps are general-audience content; mark them as not made for kids.

## What this tool does about it

| Rule | Where it lives | Default |
|---|---|---|
| Script must contain narrator commentary, not only retelling | `prompts/commentary-addon.md`, appended when **Settings → Script policy → Commentary layer** is on | ON |
| No verbatim dialogue | base prompt (own words rule) + commentary addon | always |
| Show only part of each strip | **Settings → Video → Strip coverage** (`coveragePercent`), excerpt mode in `lib/video.js` | 50% |
| Credit the official source | Project page → Official Source (author, platform, URL) → end card + description credit block | warns until set |
| Detect aggregator watermarks | Gemini reports site watermarks during script generation (`===SOURCE===` block) → chapter flags → checklist warning | automatic |
| No pirate names/links in metadata | `lib/publish.js` checks title/project info against a list of aggregator hosts and risky phrases | automatic |
| No music | the renderer never adds music; the checklist reminds you to use only the YouTube Audio Library | always |
| AI disclosure guidance | checklist item (not required, optional) | info |
| Not made for kids | checklist item | info |
| Evidence trail | `manifest.json` next to every render: source, coverage %, voice model, script size, listing warnings | automatic |
| Trim site banners | **Settings → Video → Cut from top of first image / bottom of last image** | 0 px |

## What is still risky no matter what

- Every panel is copyrighted. No publisher other than WEBTOON has published any tolerance, and WEBTOON's is revocable and only covers free Originals in that language.
- Courts in 2026 treated narrated recaps and even text summaries as non-transformative. Own-words narration with commentary reduces exposure; it does not remove it.
- Enforcement is manual and sudden. A publisher that ignored recaps for years can mass-strike overnight (anime reaction channels, September 2026).
- YPP reviews the whole channel. A channel that is 100% recaps in one format can be ruled "inauthentic" with zero copyright claims.
- Fair use is US law. YouTube applies the rules of the country of the takedown request; Pakistan, Korea and Japan offer narrower protection.
- Naver launched its own recap product ("Cuts") and Tapas is being folded into KakaoPage; publishers building their own recap offerings have more reason to pursue unofficial ones.

## Practical upload routine

1. Generate the script with the commentary layer on. Read it; add your own opinion where it feels thin.
2. Fill in the project's official source. Never paste an aggregator link anywhere.
3. Keep strip coverage at 50% or lower. Prefer 16:9 long-form over Shorts (Shorts rules are stricter about "no original content").
4. Generate the voiceover, render the video, download `captions.srt` and upload it as subtitles.
5. Use the suggested title/description (credit block included). Avoid "full chapter", "read free", "leaked".
6. Set "not made for kids". Add music only from the YouTube Audio Library, if at all.
7. Keep `manifest.json`. If a strike lands, do not mass-upload; read YouTube's counter-notice flow before acting.

## Sources (checked 10 Oct 2026)

- YouTube monetization policies / inauthentic content: https://support.google.com/youtube/answer/1311392
- YouTube July 2026 clarification (TechCrunch): https://techcrunch.com/2026/07/20/youtube-clarifies-policies-around-ai-slop-and-upsetting-videos/
- January 2026 channel terminations: https://thenextweb.com/news/youtube-ai-slop-crackdown-faceless-creators-collateral-damage
- Altered or synthetic content disclosure: https://support.google.com/youtube/answer/14328491
- Improved AI labels (May 2026): https://blog.youtube/news-and-events/improving-ai-labels-viewers-creators/
- How Content ID works: https://support.google.com/youtube/answer/2797370
- Publishers on Content ID not matching comics (Gigazine): https://gigazine.net/gsc_news/en/20240418-manga-publishers-grill-youtube-tiktok
- WEBTOON fan-video guidelines: https://webtoon.zendesk.com/hc/en-us/articles/11761736348692
- KADOKAWA subpoena ruling on recap channels (TorrentFreak): https://torrentfreak.com/court-rejects-fair-use-claim-orders-youtube-to-unmask-anime-recap-channels/
- Anime reaction channel strikes, Sept 2026 (Dexerto): https://www.dexerto.com/youtube/anime-youtuber-says-channel-faced-deletion-after-copyright-strikes-removed-60-videos-3408486/
- YouTube fair-use myths page: https://support.google.com/youtube/answer/9783148
- YouTube Audio Library rules: https://support.google.com/youtube/answer/3376882
- Made for kids guidance: https://support.google.com/youtube/answer/9528076
- Shorts monetization eligibility: https://support.google.com/youtube/answer/12929256
