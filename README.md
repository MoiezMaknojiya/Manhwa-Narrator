# 🎬 Manhwa Narrator

Upload manhwa / manhua / manga chapter images → get a Roman Urdu YouTube narration script (Google Gemini) → generate a **separate AI voice file for every image** (Gemini TTS) to drop into your own video editor, with a copyright & YouTube-policy checklist built in.

## Getting Started

1. **Install Node.js v24** (v22.13 minimum): https://nodejs.org — no Visual Studio or compiler needed.
2. Open a terminal in the project folder and install dependencies (this also downloads a bundled ffmpeg, ~80 MB, used for MP3 encoding):

   ```bash
   npm install
   ```

3. Start the app:

   ```bash
   npm start
   ```

4. Open in your browser: **http://localhost:3000**

## First-Time Setup

1. Go to the **Settings** page.
2. Paste your **Google AI API key(s)** (one per line for multiple) — get keys at https://aistudio.google.com/apikey
3. Pick a script model (default: `gemini-3.8-flash` — works on the free tier). ⚠️ Pro models require paid billing and return 429 on free keys. Use **"Load Models From Google"** to see the live list your key can access.
4. Voiceover: pick a **TTS model** (default `gemini-3.8-flash-tts`, free tier), a **voice** (default **Zeno**, `en-us-zeno` — one of Google's new en-US character voices; the 30 classic Gemini voices are listed too), a **delivery style**, **temperature** and **language** — the same four controls as AI Studio's "Generate speech". The style is sent as metadata, never spoken aloud. ⚠️ The free tier allows only **10 TTS requests per day per key** (Google's own 429 message, Oct 2026). **1 image = 1 request**, so a 21-image chapter needs 21 — with 3 keys that is about one chapter a day. The app rotates keys automatically and shows the remaining TTS quota on the chapter page.
5. The narration **prompt** is locked in `prompts/narration-prompt.md` — the app reads that file fresh on every generate. The **commentary layer** (`prompts/commentary-addon.md`) is appended when the toggle in Settings is on (default ON).

## Workflow

1. **Home** → create a project. On the project page fill in **Official Source** (author, platform, official URL) — it goes into the description credit block.
2. Inside the project → **Add Chapter**.
3. On the chapter page → **drag & drop** all the panel images (they sort by file name: `1.jpg, 2.jpg, 10.jpg…`). Ctrl+V paste works too.
4. **⚡ Generate Script** → Roman Urdu script with `--- [IMAGE n] ---` markers on every section. Gemini also reports any site watermark it sees in the images.
5. Edit if you like, **💾 Save Edits**.
6. **🎙️ Generate Voices** (the Image Voices card is **hidden by default** — turn it on in Settings → "Image Voices card"; every on/off asks for your secret number, which you create the first time) → every `--- [IMAGE n] ---` section gets its own TTS request and its own file: `image-01.mp3`, `image-02.mp3`… Each image has a player, an MP3 download, a **Voice** dropdown (pick a different voice for just that image — style/temperature/language stay global) and a **🔄 Regenerate** button (new take for that image only). **⬇️ All voices (ZIP)** downloads the whole chapter as MP3s. Edit the video yourself in any editor.
7. Go through the **Pre-upload checklist** on the chapter page before uploading.

## Features

- **Multiple API keys with auto-switch** — when one key hits its limit (or is invalid), the app switches to the next key and re-runs the same request. 503 "high demand" and 429 rate limits are retried with waits first.
- **AI Quota card** — per-key usage bars (local estimate; exact numbers in AI Studio). Resets at midnight Pacific. Quota is per model, so TTS requests are counted separately.
- **Character roster** — Gemini extracts characters (name, permanent appearance, outfits, role, relationships) per project and they are fed back into every chapter's prompt so names stay consistent. Edit or add characters on the project page.
- **Name safety (v1.22)** — the roster matcher folds romanization/spelling variants (Hyeon/Hyun, Sin/Shin, Ji-hyeok/Jihyuk), refuses ambiguous short names (shared surnames) instead of guessing, never adds unnamed/guessed figures ("masked man", "X ki ammi") to the roster, learns aliases automatically and rewrites variant spellings in the saved script to the roster spelling. The roster sent to Gemini is chapter-scoped (relationships/characters from later chapters are hidden when regenerating an early chapter — no spoilers), the prompt forbids naming hidden/unsure faces, and every script gets a name audit (unknown names, misspellings, ambiguous matches) shown on the chapter page. Per-chapter notes, "Restore previous script", merge duplicates, copy a roster into a sequel project, status (dead), notes and "say as" pronunciation are on the project/chapter pages. Deleting a character stops Gemini from re-adding it.
- **Face references (v2)** — each roster character can hold 1–3 cropped reference faces (project page → "Add face reference" → pick any chapter image, drag the square box onto the face, Save). Every generate sends those crops to Gemini, labelled with the name, right before the chapter images, with a rule that a matching face + fitting context = that roster name even in a new outfit/angle, while a clearly different face is still described, not named. Only characters already revealed by that chapter are sent (no spoilers). Faces follow the character on merge/copy and are removed with it; files live in `data/faces/` (not committed). Real-photo face models (ArcFace) were tested first and rejected: on manhwa art they miss most faces and cannot tell the hero from other characters.
- **Crop panels (v1.23)** — every chapter page has a "Crop panels" button that opens a cropping workspace: pick any images, auto-detect panel gutters or add boxes yourself — new crops are fixed-ratio (16:9 for YouTube landscape by default; 4:3, 1:1 or 9:16 Shorts selectable) and resizing keeps the ratio, or turn on "Free width" for any shape (2–4 quick splits, drag to move, drag an edge to resize, Ctrl+Z undo, keyboard nudging), keep each image under a copyright budget (default 40 % of its height, shown as a meter), then "Export to folder" (Browse… picks the folder in a normal Windows dialog) writes `01a.jpg, 01b.jpg, 02a.jpg …` at source resolution ready for CapCut. Crops are saved per chapter, so you can come back and adjust them.
- **English listings (v1.24)** — the suggested YouTube title/description is fully English (keywords "Explained in Hindi/Urdu" kept) and follows YouTube Help + vidIQ + youtube-seo-skills research: hook with the keyword in the first 150 chars, official link above the fold, a per-video unique summary placeholder, watch-next/playlist links, condensed fair-use block and only 5 hashtags. Matches the channel’s About text and upload defaults. Template: `output/youtube/UNIVERSAL YouTube description template (all series) - ENGLISH.txt`.
- **UX pass (v1.24)** — one visual language across the app: line icons instead of emoji, a proper confirm dialog for every destructive action (delete project/chapter/image, clear images, regenerate over a script, merge/remove characters), toasts with icons, "Copied"/"Saved" button feedback, Ctrl+S saves the script on the chapter page and the settings page (which also shows a sticky "Unsaved changes" bar), keyboard focus rings everywhere, reduced-motion support, higher-contrast links/placeholders, a favicon and a skip-to-content link. The crop workspace has a **Browse…** button that opens the normal Windows folder window and writes the crops into the chosen folder right away, plus "Open folder" to reveal them in Explorer.
- **Tall-strip slicing** — long webtoon strips are sliced before upload so Gemini can read every panel.
- **Per-image voices** — Gemini TTS via the Interactions API, one request per image section, so every file contains exactly that image's text. Cached per image (edit one section → only that image is regenerated; change the voice/style → all are). If the daily quota runs out midway, finished images stay saved and the next run only makes the rest. **Skip guard:** LLM TTS sometimes drops text, so every clip's speaking rate is checked; a clip that comes back too short is retried once and flagged in the UI.
- **Policy layer** — commentary addon in the prompt, aggregator-watermark detection, official-source credits, risky-phrase check on titles, upload checklist. Details and sources in **POLICY.md**.
- **Token usage tracking** — today/total token counts and recent generation history.

## Notes

- Everything is local: projects/chapters/characters live in `data/app.db` (SQLite via Node's built-in driver), images in `uploads/`, image voices (MP3 only) in `output/<project>/<chapter>/clips/` (downloads get friendly names like `image-01.mp3`).
- API keys are stored only on your computer. `data/`, `uploads/` and `output/` are git-ignored.
- To change the port: `PORT=4000 npm start`
- Voice generation runs in the background; the chapter page polls progress. Server restart cancels a running job (finished files stay).
- Upgrading from an older version? Delete `node_modules` and run `npm install` again. Keep your `data/` and `uploads/` folders.
