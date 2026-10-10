# 🎬 Manhwa Narrator

Upload manhwa / manhua / manga chapter images → get a Roman Urdu YouTube narration script (Google Gemini) → generate an AI voiceover (Gemini TTS) → render a ready-to-upload video (bundled ffmpeg), with a copyright & YouTube-policy checklist built in.

## Getting Started

1. **Install Node.js v24** (v22.13 minimum): https://nodejs.org — no Visual Studio or compiler needed.
2. Open a terminal in the project folder and install dependencies (this also downloads a bundled ffmpeg, ~80 MB):

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
4. Voiceover: pick a **TTS model** (default `gemini-3.8-flash-tts`, free tier) and a **voice**. The delivery style is sent as metadata, never spoken aloud. ⚠️ The free tier allows only **10 TTS requests per day per key** (Google's own 429 message, Oct 2026); a chapter needs ~7-8, so with 3 keys you get ~4 chapters a day. The app rotates keys automatically and shows the remaining TTS quota on the chapter page.
5. Video: choose **Landscape (YouTube)** or **Portrait (Shorts)**, set your **channel watermark**, and keep **strip coverage at 50%** (see POLICY.md for why).
6. The narration **prompt** is locked in `prompts/narration-prompt.md` — the app reads that file fresh on every generate. The **commentary layer** (`prompts/commentary-addon.md`) is appended when the toggle in Settings is on (default ON).

## Workflow

1. **Home** → create a project. On the project page fill in **Official Source** (author, platform, official URL) — it goes into the end card and the description credit block.
2. Inside the project → **Add Chapter**.
3. On the chapter page → **drag & drop** all the panel images (they sort by file name: `1.jpg, 2.jpg, 10.jpg…`). Ctrl+V paste works too.
4. **⚡ Generate Script** → Roman Urdu script with `--- [IMAGE n] ---` markers on every section. Gemini also reports any site watermark it sees in the images.
5. Edit if you like, **💾 Save Edits**.
6. **🎙️ Generate Voiceover** → sections are read in order with a pause between them; the app detects each section's timing from the audio. MP3 download + player.
7. **🎞️ Render Video** → each section's images become a strip that scrolls / shows excerpts in sync with the narration, over a blurred background, with your watermark and an end card crediting the official source. Outputs: `video.mp4`, `captions.srt`, `description.txt` (title + description + tags), `manifest.json`.
8. Go through the **Pre-upload checklist** on the chapter page before uploading.

## Features

- **Multiple API keys with auto-switch** — when one key hits its limit (or is invalid), the app switches to the next key and re-runs the same request. 503 "high demand" and 429 rate limits are retried with waits first.
- **AI Quota card** — per-key usage bars (local estimate; exact numbers in AI Studio). Resets at midnight Pacific. Quota is per model, so TTS requests are counted separately.
- **Character roster** — Gemini extracts characters (name, appearance, role, relationships) per project and they are fed back into every chapter's prompt so names stay consistent. Edit or add characters on the project page.
- **Tall-strip slicing** — long webtoon strips are sliced before upload so Gemini can read every panel.
- **Voiceover** — Gemini TTS via the Interactions API; chunked to save quota (max 4 sections per request), cached per chunk (edit one section → only that chunk is regenerated), section timing by silence detection. **Skip guard:** LLM TTS sometimes drops whole paragraphs, so every chunk's speaking rate is checked; a chunk that comes back too short is retried, then regenerated section by section (exact timing) and flagged in the UI.
- **Video** — ffmpeg + sharp, no system install needed. 1080p/30fps H.264 + AAC, excerpt mode (shows only part of each strip), blurred background, watermark, end card, SRT captions.
- **Policy layer** — commentary addon in the prompt, coverage limit, aggregator-watermark detection, official-source credits, risky-phrase check on titles, evidence manifest. Details and sources in **POLICY.md**.
- **Token usage tracking** — today/total token counts and recent generation history.

## Notes

- Everything is local: projects/chapters/characters live in `data/app.db` (SQLite via Node's built-in driver), images in `uploads/`, voiceovers and videos in `output/<project>/<chapter>/`.
- API keys are stored only on your computer. `data/`, `uploads/` and `output/` are git-ignored.
- To change the port: `PORT=4000 npm start`
- Rendering runs in the background; the chapter page polls progress. Server restart cancels a running job (finished files stay).
- Upgrading from an older version? Delete `node_modules` and run `npm install` again. Keep your `data/` and `uploads/` folders.
