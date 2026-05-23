const express = require("express");
const cors = require("cors");
const { exec, spawn } = require("child_process");
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

// Ensure downloads dir exists
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);

// Find yt-dlp wherever it's installed (Mac Homebrew or system PATH)
function findBin(name) {
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    name, // fallback to PATH
  ];
  for (const c of candidates) {
    try {
      if (c === name || fs.existsSync(c)) return c;
    } catch {}
  }
  return name;
}

const YTDLP = findBin("yt-dlp");
const FFMPEG_DIR = path.dirname(findBin("ffmpeg"));

// Check if yt-dlp is installed
function checkYtDlp() {
  return new Promise((resolve) => {
    exec(`"${YTDLP}" --version`, (err) => resolve(!err));
  });
}

// GET /api/info — fetch video metadata
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
      if (err) {
        return res.status(400).json({ error: stderr || err.message });
      }
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
          .filter(
            (f, i, arr) =>
              arr.findIndex((x) => x.resolution === f.resolution && x.ext === f.ext) === i
          )
          .sort((a, b) => {
            const ah = parseInt(a.resolution) || 0;
            const bh = parseInt(b.resolution) || 0;
            return bh - ah;
          });

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

// GET /api/download — stream download progress via SSE
app.get("/api/download", async (req, res) => {
  const { url, format_id } = req.query;
  if (!url) return res.status(400).json({ error: "No URL provided" });

  const installed = await checkYtDlp();
  if (!installed) {
    return res.status(500).json({ error: "yt-dlp not installed" });
  }

  const jobId = uuidv4();
  const outputTemplate = path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const args = [
    "--no-playlist",
    "--newline",
    "-o", outputTemplate,
    "--ffmpeg-location", FFMPEG_DIR,
  ];

  if (format_id && format_id !== "bestaudio") {
    args.push("-f", `${format_id}+bestaudio/best`);
  } else if (format_id === "bestaudio") {
    args.push("-f", "bestaudio");
    args.push("-x", "--audio-format", "mp3");
  } else {
    args.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best");
  }

  if (format_id !== "bestaudio") {
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
        send({
          type: "progress",
          percent: parseFloat(progressMatch[1]),
          size: progressMatch[2],
          speed: progressMatch[3],
        });
      }
      const destMatch = line.match(/\[(?:download|Merger)\]\s+(?:Destination|Merging):\s+(.+)/);
      if (destMatch) filename = destMatch[1].trim();
      const mergedMatch = line.match(/\[Merger\] Merging formats into "(.+)"/);
      if (mergedMatch) filename = mergedMatch[1].trim();
    }
  });

  proc.stderr.on("data", (data) => {
    send({ type: "log", message: data.toString() });
  });

  proc.on("close", (code) => {
    if (code === 0) {
      let finalFile = filename;
      if (!finalFile || !fs.existsSync(finalFile)) {
        const files = fs.readdirSync(DOWNLOADS_DIR).filter((f) => f.startsWith(jobId));
        if (files.length > 0) finalFile = path.join(DOWNLOADS_DIR, files[0]);
      }
      if (finalFile && fs.existsSync(finalFile)) {
        const basename = path.basename(finalFile);
        send({ type: "done", downloadUrl: `/downloads/${basename}`, filename: basename });
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

// Clean up old downloads (older than 1hr)
setInterval(() => {
  const now = Date.now();
  try {
    fs.readdirSync(DOWNLOADS_DIR).forEach((file) => {
      const fp = path.join(DOWNLOADS_DIR, file);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > 3600000) fs.unlinkSync(fp);
    });
  } catch {}
}, 600000);

app.listen(PORT, () => {
  console.log(`\n🎬 VideoSnatch running at http://localhost:${PORT}\n`);
  console.log(`   yt-dlp: ${YTDLP}`);
  console.log(`   ffmpeg: ${FFMPEG_DIR}\n`);
});