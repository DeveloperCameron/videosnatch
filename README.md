# VideoSnatch 🎬

Download videos from YouTube, Twitter/X, Instagram, TikTok, Vimeo, Reddit, and 1000+ other sites.

## Prerequisites

### 1. Install yt-dlp
**macOS:**
```bash
brew install yt-dlp
```
**Windows:**
```bash
winget install yt-dlp
```
Or download the `.exe` from https://github.com/yt-dlp/yt-dlp/releases and add it to your PATH.

**Linux / pip:**
```bash
pip install yt-dlp
```

### 2. Install ffmpeg (needed for merging HD video + audio)
**macOS:** `brew install ffmpeg`  
**Windows:** `winget install ffmpeg`  
**Linux:** `sudo apt install ffmpeg`

### 3. Install Node.js
Download from https://nodejs.org (v16+ recommended)

---

## Setup & Run

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Then open your browser to: **http://localhost:3000**

---

## How it works

1. Paste any video URL into the input field
2. Click **Fetch** — the app pulls video metadata and available quality options
3. Choose your preferred quality (or leave on "Best")
4. Click **Download Video** (or **Audio Only** for MP3)
5. Watch the real-time progress bar
6. Click **Save File** when complete

## Supported Sites (sample)
YouTube, Twitter/X, Instagram, TikTok, Vimeo, Reddit, Twitch, Facebook, Dailymotion, Bilibili, SoundCloud, and 1000+ more via yt-dlp.

## Notes
- Downloaded files are stored in `./downloads/` and auto-deleted after 1 hour
- Only download content you have the legal right to download
- For YouTube, some formats may require cookies if age-restricted

## Troubleshooting

**"yt-dlp not installed" error:** Make sure `yt-dlp` is in your system PATH. Run `yt-dlp --version` in your terminal to verify.

**Video won't merge / no sound:** Install ffmpeg (see prerequisites above).

**Age-restricted content:** You may need to pass cookies. See yt-dlp docs: `--cookies-from-browser chrome`
