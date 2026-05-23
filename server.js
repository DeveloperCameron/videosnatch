const express = require("express");
const cors = require("cors");
const { exec, execSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(DOWNLOADS_DIR));

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);

// Find a binary using `which`, with hardcoded fallbacks
function findBin(name) {
  try {
    const result = execSync(`which ${name} 2>/dev/null`).toString().trim();
    if (result) return result;
  } catch {}
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    `/nix/var/nix/profiles/default/bin/${name}`,
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return name;
}

const YTDLP = findBin("yt-dlp");
const FFMPEG_BIN = findBin("ffmpeg");
const FFMPEG_DIR = (FFMPEG_BIN && FFMPEG_BIN !== "ffmpeg") ? path.dirname(FFMPEG_BIN) : "";

console.log(`\n🎬 VideoSnatch starting...`);
console.log(`   yt-dlp:  ${YTDLP}`);
console.log(`   ffmpeg:  ${FFMPEG_BIN}`);
console.log(`   ffmpeg dir: ${FFMPEG_DIR}\n`);

function checkYtDlp() {
  return new Promise((resolve) => {
    exec(`"${YTDLP}" --version`, (err) => resolve(!err));
  });
}

app.get("/api/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "No URL provided" });

  const installed = await checkYtDlp();
  if (!installed) {
    return res.status(500).json({
      error: "yt-dlp not installed",
      install: "pip install yt-dlp  OR  brew install yt-dlp",
    });
  }

  exec(
    `"${YTDLP}" --dump-json --no-playlist "${url.replace(/"/g, '\\"')}"`,
    { maxBuffer: 1024 * 1024 * 10 },
    (err, stdout, stderr) => {
      if (err) return res.status(400).json({ error: stderr || err.message });
      try {
        const info = JSON.parse(stdout);
        const formats = (info.formats || [])
          .filter((f) => f.vcodec !== "none" && f.ext)
          .map((f) => ({
            format_id: f.format_id,
            ext: f.ext,
            resolution: f.resolution || (f.height ? `${f.height}p` : "unknown"),
            fps: f.fps,
            filesize: f.filesize,
            vcodec: f.vcodec,
            acodec: f.acodec,
            note: f.format_note,
          }))
          .filter((f, i, arr) =>
            arr.findIndex((x) => x.resolution === f.resolution && x.ext === f.ext) === i
          )
          .sort((a, b) => (parseInt(b.resolution) || 0) - (parseInt(a.resolution) || 0));

        res.json({
          title: info.title,
          thumbnail: info.thumbnail,
          duration: info.duration,
          uploader: info.uploader,
          platform: info.extractor_key,
          formats: formats.slice(0, 12),
        });
      } catch (e) {
        res.status(500).json({ error: "Failed to parse video info" });
      }
    }
  );
});

app.get("/api/download", async (req, res) => {
  const { url, format_id } = req.query;
  if (!url) return res.status(400).json({ error: "No URL provided" });

  const installed = await checkYtDlp();
  if (!installed) return res.status(500).json({ error: "yt-dlp not installed" });

  const jobId = uuidv4();
  const outputTemplate = path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const args = ["--no-playlist", "--newline", "-o", outputTemplate];

  if (FFMPEG_DIR) args.push("--ffmpeg-location", FFMPEG_DIR);

  if (format_id === "bestaudio") {
    args.push("-f", "bestaudio", "-x", "--audio-format", "mp3");
  } else if (format_id) {
    args.push("-f", `${format_id}+bestaudio/best`);
    args.push("--merge-output-format", "mp4");
  } else {
    args.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best");
    args.push("--merge-output-format", "mp4");
  }

  args.push(url);

  const proc = spawn(YTDLP, args);
  let filename = null;

  proc.stdout.on("data", (data) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      const progressMatch = line.match(/(\d+\.?\d*)%\s+of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)/);
      if (progressMatch) {
        send({ type: "progress", percent: parseFloat(progressMatch[1]), size: progressMatch[2], speed: progressMatch[3] });
      }
      const destMatch = line.match(/\[(?:download|Merger)\]\s+(?:Destination|Merging):\s+(.+)/);
      if (destMatch) filename = destMatch[1].trim();
      const mergedMatch = line.match(/\[Merger\] Merging formats into "(.+)"/);
      if (mergedMatch) filename = mergedMatch[1].trim();
    }
  });

  proc.stderr.on("data", (data) => send({ type: "log", message: data.toString() }));

  proc.on("close", (code) => {
    if (code === 0) {
      let finalFile = filename;
      if (!finalFile || !fs.existsSync(finalFile)) {
        const files = fs.readdirSync(DOWNLOADS_DIR).filter((f) => f.startsWith(jobId));
        if (files.length > 0) finalFile = path.join(DOWNLOADS_DIR, files[0]);
      }
      if (finalFile && fs.existsSync(finalFile)) {
        send({ type: "done", downloadUrl: `/downloads/${path.basename(finalFile)}`, filename: path.basename(finalFile) });
      } else {
        send({ type: "error", message: "Download completed but file not found" });
      }
    } else {
      send({ type: "error", message: `Process exited with code ${code}` });
    }
    res.end();
  });

  req.on("close", () => proc.kill());
});

setInterval(() => {
  const now = Date.now();
  try {
    fs.readdirSync(DOWNLOADS_DIR).forEach((file) => {
      const fp = path.join(DOWNLOADS_DIR, file);
      if (now - fs.statSync(fp).mtimeMs > 3600000) fs.unlinkSync(fp);
    });
  } catch {}
}, 600000);

app.listen(PORT, () => console.log(`🎬 VideoSnatch running at http://localhost:${PORT}`));