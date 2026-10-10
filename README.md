# 🎬 Manhwa Narrator

Upload manhwa / manhua / manga chapter images and generate a Roman Urdu YouTube narration script with Google Gemini AI.

## Getting Started

1. **Install Node.js v24** (v22.13 minimum): https://nodejs.org — no Visual Studio or compiler needed.
2. Open a terminal in the project folder and install dependencies:

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
3. Pick a model (default: `gemini-3.8-flash` — works on the free tier, ~1500 requests/day per key). ⚠️ Pro models (e.g. gemini-3.1-pro-preview) require paid billing and return 429 on free keys. Use **"Load Models From Google"** to see the live list your key can access.
4. The narration **prompt** is locked in `prompts/narration-prompt.md` — the app reads that file fresh on every generate. The script output stays in Roman Urdu; edit the file if you ever want to change the style.

## Workflow

1. **Home** → create a project.
2. Inside the project → **Add Chapter**.
3. On the chapter page → **drag & drop** all the panel images (they sort by file name: `1.jpg, 2.jpg, 10.jpg…`). Ctrl+V paste works too. Upload starts instantly.
4. Hit **⚡ Generate Script** → your Roman Urdu script arrives in 30-90 seconds, with `--- [IMAGE n] ---` markers on every section for easy video-edit syncing.
5. **Edit / Copy / Download (.txt)** the script. Edits save with **💾 Save Edits**.

## Features

- **Multiple API keys with auto-switch** — when one key hits its daily limit (or is invalid), the app automatically switches to the next key and re-runs the same request. Work never stops.
- **AI Quota card** — per-key usage bars showing how many requests are left today (local estimate; exact numbers in AI Studio). Resets at midnight Pacific.
- **Auto-retry on 503** — if Google's model is under high demand, the app waits and retries automatically before reporting anything.
- **Character consistency** — the app quietly tracks characters (name, appearance, aliases in English) per project and feeds them back to Gemini, so names stay the same across chapters even when the source translation changes them.
- **Tall-strip slicing** — long webtoon strips are automatically sliced before upload so Gemini can read every panel clearly.
- **Token usage tracking** — today/total token counts and recent generation history.

## Notes

- Everything is local: projects/chapters/characters live in `data/app.db` (SQLite via Node's built-in driver), images in `uploads/`.
- API keys are stored only on your computer.
- To change the port: `PORT=4000 npm start`
- Upgrading from an older version? Delete `node_modules` and run `npm install` again. Keep your `data/` and `uploads/` folders.
