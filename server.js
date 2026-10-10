const http = require("node:http");
const { execFileSync, spawn } = require("node:child_process");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = __dirname;

function loadDotEnv() {
  try {
    const source = require("node:fs").readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch {}
}
loadDotEnv();
const PORT = Number(process.env.PORT || 5173);

const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
const location = process.env.VERTEX_LOCATION || "us-central1";
const model = process.env.VERTEX_MODEL_ID || "veo-3.1-fast-generate-001";
const qwenEndpoint = process.env.QWEN_TTS_ENDPOINT || "";
const outputUri = process.env.VERTEX_OUTPUT_URI || "";
const ideasModel = process.env.IDEAS_MODEL_ID || "gemini-3.8-flash";
const geminiApiKey = process.env.GEMINI_API_KEY || "";
const ideasConfigured = Boolean(geminiApiKey);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

async function readJson(request, maxBytes = 120 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Expected a JSON request body."), { statusCode: 400 });
  }
}

async function accessToken() {
  if (process.env.K_SERVICE) {
    const metadata = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "Metadata-Flavor": "Google" },
    });
    if (!metadata.ok) throw new Error("Could not get a Google Cloud service token. Check the Cloud Run service account.");
    return (await metadata.json()).access_token;
  }
  try {
    return execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", timeout: 15000 }).trim();
  } catch {
    throw new Error("Google Cloud credentials are missing. Run gcloud auth application-default login or use a Cloud Run service account.");
  }
}

async function qwenAuthorization() {
  if (process.env.QWEN_TTS_TOKEN) return `Bearer ${process.env.QWEN_TTS_TOKEN}`;
  if (process.env.K_SERVICE) {
    const audience = new URL(qwenEndpoint).origin;
    const identityUrl = new URL("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity");
    identityUrl.searchParams.set("audience", audience);
    identityUrl.searchParams.set("format", "full");
    const response = await fetch(identityUrl, { headers: { "Metadata-Flavor": "Google" } });
    if (!response.ok) throw new Error("Could not mint an identity token for the Qwen service.");
    return `Bearer ${(await response.text()).trim()}`;
  }
  try {
    const audience = new URL(qwenEndpoint).origin;
    const identityToken = execFileSync("gcloud", ["auth", "print-identity-token", `--audiences=${audience}`], { encoding: "utf8", timeout: 15000 }).trim();
    return `Bearer ${identityToken}`;
  } catch {
    return "";
  }
}

async function requestGoogle(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || payload.message || `Vertex AI returned HTTP ${response.status}.`);
  return payload;
}

async function waitForOperation(operationName, token) {
  const operationUrl = `https://${location}-aiplatform.googleapis.com/v1/${operationName}`;
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const operation = await requestGoogle(operationUrl, token);
    if (operation.error) throw new Error(operation.error.message || "Veo could not generate this scene.");
    if (operation.done) return operation.response || {};
  }
  throw new Error("Veo is still processing after 12 minutes. Try again in a moment.");
}

async function downloadGcsObject(uri, token) {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error("Veo returned an unsupported video location.");
  const [, bucket, object] = match;
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Could not download the generated video from Cloud Storage (HTTP ${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

function findGeneratedVideo(operationResponse) {
  const result = operationResponse.generateVideoResponse || operationResponse;
  const sample = result.generatedSamples?.[0] || result.videos?.[0] || result.generated_videos?.[0];
  if (!sample) return null;
  const video = sample.video || sample;
  if (video.bytesBase64Encoded || video.encodedVideo || video.video) {
    return Buffer.from(video.bytesBase64Encoded || video.encodedVideo || video.video, "base64");
  }
  return video.uri || video.gcsUri || sample.uri || null;
}

async function generateVeo(body) {
  if (!project) throw Object.assign(new Error("Set GOOGLE_CLOUD_PROJECT in .env to connect Vertex AI."), { statusCode: 503 });
  if (!body.firstFrame?.data || !body.firstFrame?.mimeType) throw Object.assign(new Error("Choose an opening frame first."), { statusCode: 400 });
  if (!outputUri.startsWith("gs://")) throw Object.assign(new Error("Set VERTEX_OUTPUT_URI to a writable gs:// bucket prefix."), { statusCode: 503 });
  const token = await accessToken();
  const instance = {
    prompt: `${body.prompt || "Slow, realistic camera movement through this listing."}\n\nUse the spoken transcript only as context for the scene: ${body.transcript || ""}`,
    image: { bytesBase64Encoded: body.firstFrame.data, mimeType: body.firstFrame.mimeType },
  };
  if (body.lastFrame?.data && body.lastFrame?.mimeType) {
    instance.lastFrame = { bytesBase64Encoded: body.lastFrame.data, mimeType: body.lastFrame.mimeType };
  }
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predictLongRunning`;
  const operation = await requestGoogle(url, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [instance],
      parameters: {
        storageUri: outputUri.endsWith("/") ? outputUri : `${outputUri}/`,
        aspectRatio: body.aspectRatio === "16:9" ? "16:9" : "9:16",
        durationSeconds: [4, 6, 8].includes(Number(body.durationSeconds)) ? Number(body.durationSeconds) : 8,
        resolution: body.resolution === "720p" ? "720p" : "1080p",
        sampleCount: 1,
        generateAudio: false,
        enhancePrompt: true,
      },
    }),
  });
  if (!operation.name) throw new Error("Vertex AI did not return a generation operation.");
  const result = await waitForOperation(operation.name, token);
  const generated = findGeneratedVideo(result);
  if (Buffer.isBuffer(generated)) return generated;
  if (typeof generated === "string") return downloadGcsObject(generated, token);
  throw new Error(result.raiMediaFilteredReasons?.join(" ") || "Veo finished without returning a video. Check the prompt and try again.");
}

const IDEAS_SYSTEM = `You are the creative strategist inside Video Agent, a tool that turns a short script and a few photos into a 10–30 second vertical social video (AI camera motion from a still photo + a Mandarin voiceover + captions).

Your job, before anything is produced:
1. Look honestly at the creator's materials (their brief, any draft script, and the attached photos). Say what is strong, and what is missing or weak for the target platform. Be concrete about what they should provide or shoot next (e.g. "a wide shot of the whole room in daylight", "a price or offer line", "a face-to-camera opener").
2. Use web search to find what is working right now on the target platform for this niche: real, currently active accounts and the formats/hooks they use. Prefer sources from the last few months. Do not invent accounts; if you cannot verify an account, describe the trending format instead and leave "account" as a short format name and "url" empty.
3. Propose 3 distinct video ideas that this creator can make with this tool and their materials (or with one or two extra shots you named). Each idea is one scene: one opening photo, one camera move, one voiceover.

The voiceover script must be in natural spoken Simplified Chinese (Mandarin), 60–160 characters, written to be heard, with a hook in the first sentence. The motion direction must be in English, describe one small believable camera move, and tell the model to keep the subject's design, proportions and colours unchanged.

Reply with only a JSON object, no prose before or after it and no markdown fences, in exactly this shape:
{
  "materials": {
    "summary": "one or two sentences on what the creator has",
    "strengths": ["..."],
    "gaps": [{"item": "what to provide or shoot", "why": "why it matters for this platform"}]
  },
  "trends": [
    {"account": "account name or format name", "platform": "...", "style": "what they do", "takeaway": "what this creator should borrow", "url": "https://... or empty"}
  ],
  "ideas": [
    {"title": "short name", "angle": "why this will work", "hook": "the first line, in Chinese", "script": "full voiceover, in Chinese", "motion": "camera direction for the video model, in English", "shots": ["which photo to open on, and any extra shot needed"]}
  ]
}
Give 3–5 trends and exactly 3 ideas. All user-facing text other than "hook" and "script" should be in English.`;

function parseIdeasJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The idea model did not return a plan. Try again.");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("The idea model returned a plan that could not be read. Try again.");
  }
}

function searchSources(candidate) {
  const sources = new Map();
  for (const chunk of candidate?.groundingMetadata?.groundingChunks || []) {
    const url = chunk.web?.uri;
    if (url && !sources.has(url)) sources.set(url, { url, title: chunk.web.title || url });
  }
  return [...sources.values()].slice(0, 10);
}

async function generateIdeas(body) {
  if (!ideasConfigured) throw Object.assign(new Error("Set GEMINI_API_KEY in .env to turn on idea generation."), { statusCode: 503 });
  const platform = String(body.platform || "Rednote").slice(0, 40);
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter((image) => /^image\/(jpeg|png|webp|gif)$/.test(image?.mimeType) && image?.data)
    .slice(0, 6);
  const parts = images.flatMap((image, index) => [
    { text: `Photo ${index + 1}${image.name ? ` (${String(image.name).slice(0, 80)})` : ""}:` },
    { inlineData: { mimeType: image.mimeType, data: image.data } },
  ]);
  parts.push({
    text: [
      `Target platform: ${platform}`,
      `Today's date: ${new Date().toISOString().slice(0, 10)}`,
      `Creator's brief: ${String(body.brief || "").trim().slice(0, 2000) || "(none given; infer the niche from the photos and script)"}`,
      `Current draft script: ${String(body.transcript || "").trim().slice(0, 1200) || "(none yet)"}`,
      images.length ? `${images.length} photo(s) attached above.` : "No photos attached.",
    ].join("\n"),
  });

  const result = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ideasModel)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": geminiApiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: IDEAS_SYSTEM }] },
      contents: [{ role: "user", parts }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 32000 },
    }),
  });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(payload.error?.message || `Gemini request failed with HTTP ${result.status}.`);
  if (payload.promptFeedback?.blockReason) throw new Error("The idea model declined this request. Try rewording the brief.");
  const candidate = payload.candidates?.[0];
  if (["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION"].includes(candidate?.finishReason)) throw new Error("The idea model declined this request. Try rewording the brief.");
  if (candidate?.finishReason === "MAX_TOKENS") throw new Error("The idea plan was cut off. Try a shorter brief.");
  const text = (candidate?.content?.parts || []).filter((part) => part.text && !part.thought).map((part) => part.text).join("");
  return { ...parseIdeasJson(text), sources: searchSources(candidate), model: payload.modelVersion || ideasModel };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk) => { errorText += chunk.toString(); });
    child.on("error", (error) => reject(new Error(`FFmpeg is unavailable: ${error.message}`)));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(errorText.slice(-1200) || `FFmpeg exited with code ${code}.`)));
  });
}

function timestampSrt(milliseconds) {
  const ms = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const fraction = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(fraction).padStart(3, "0")}`;
}

function subtitleFileText(text, durationSeconds) {
  const cleanText = String(text || "").replace(/[\r\n]+/g, "").trim();
  if (!cleanText) return "";
  const chars = [...cleanText];
  const chunks = [];
  let chunk = "";
  for (const char of chars) {
    chunk += char;
    if (chunk.length >= 16 && /[，。！？；：,.!?;:]$/.test(chunk)) {
      chunks.push(chunk);
      chunk = "";
    } else if (chunk.length >= 21) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  if (chunk) chunks.push(chunk);
  const weight = chunks.reduce((sum, item) => sum + [...item].length, 0) || chunks.length;
  let elapsed = 0;
  return chunks.map((item, index) => {
    const start = elapsed;
    elapsed += durationSeconds * ([...item].length / weight);
    if (index === chunks.length - 1) elapsed = durationSeconds;
    return `${index + 1}\n${timestampSrt(start * 1000)} --> ${timestampSrt(elapsed * 1000)}\n${item}`;
  }).join("\n\n");
}

async function exportMp4(body) {
  if (!body.videoBase64 || !body.audioBase64) throw Object.assign(new Error("Both a generated scene and voiceover are required."), { statusCode: 400 });
  const temp = await mkdtemp(path.join(os.tmpdir(), "video-agent-export-"));
  const videoPath = path.join(temp, "scene.mp4");
  const audioPath = path.join(temp, "voiceover.mp3");
  const subtitlePath = path.join(temp, "captions.srt");
  const outputPath = path.join(temp, "listing-reel.mp4");
  try {
    await Promise.all([
      writeFile(videoPath, Buffer.from(body.videoBase64, "base64")),
      writeFile(audioPath, Buffer.from(body.audioBase64, "base64")),
    ]);
    const args = ["-hide_banner", "-loglevel", "error", "-y"];
    if (body.loopVideo !== false) args.push("-stream_loop", "-1");
    args.push("-i", videoPath, "-i", audioPath);
    if (body.subtitles && body.transcript?.trim()) {
      const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audioPath], { encoding: "utf8" }).trim());
      await writeFile(subtitlePath, subtitleFileText(body.transcript, duration), "utf8");
      args.push("-i", subtitlePath);
    }
    args.push("-map", "0:v:0", "-map", "1:a:0");
    if (body.subtitles && body.transcript?.trim()) args.push("-map", "2:s:0");
    args.push(
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "192k",
    );
    if (body.subtitles && body.transcript?.trim()) args.push("-c:s", "mov_text", "-metadata:s:s:0", "language=chi");
    args.push("-shortest", "-movflags", "+faststart", outputPath);
    await runFfmpeg(args);
    return await readFile(outputPath);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function handleApi(request, response, pathname) {
  if (pathname === "/api/health" && request.method === "GET") {
    return sendJson(response, 200, {
      qwen: Boolean(qwenEndpoint),
      vertex: Boolean(project && outputUri.startsWith("gs://")),
      ideas: ideasConfigured,
      demo: !(qwenEndpoint && project && outputUri.startsWith("gs://")),
      model,
      location,
    });
  }

  if (pathname === "/api/ideas" && request.method === "POST") {
    const body = await readJson(request, 40 * 1024 * 1024);
    return sendJson(response, 200, await generateIdeas(body));
  }

  if (pathname === "/api/tts" && request.method === "POST") {
    if (!qwenEndpoint) return sendJson(response, 503, { error: "QWEN_TTS_ENDPOINT is not configured. Set it to your authenticated Qwen3-TTS service URL." });
    const body = await readJson(request, 2 * 1024 * 1024);
    if (!body.text?.trim()) return sendJson(response, 400, { error: "Transcript text is required." });
    const authHeader = await qwenAuthorization();
    const upstream = await fetch(qwenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
      body: JSON.stringify({ text: body.text, voice: body.voice || "Xiaoyi", format: "mp3" }),
    });
    if (!upstream.ok) {
      const message = (await upstream.text()).slice(0, 700);
      return sendJson(response, 502, { error: `Qwen3-TTS request failed (${upstream.status}): ${message}` });
    }
    const contentType = upstream.headers.get("content-type") || "audio/mpeg";
    let audio;
    if (contentType.includes("json")) {
      const payload = await upstream.json();
      const encoded = payload.audioBase64 || payload.audio_base64 || payload.audio;
      if (!encoded) return sendJson(response, 502, { error: "Qwen endpoint must return audio bytes or JSON with audioBase64." });
      audio = Buffer.from(String(encoded).replace(/^data:[^,]+,/, ""), "base64");
    } else {
      audio = Buffer.from(await upstream.arrayBuffer());
    }
    response.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store" });
    return response.end(audio);
  }

  if (pathname === "/api/video" && request.method === "POST") {
    const body = await readJson(request);
    const video = await generateVeo(body);
    response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": video.length, "Cache-Control": "no-store" });
    return response.end(video);
  }

  if (pathname === "/api/export" && request.method === "POST") {
    const body = await readJson(request);
    const video = await exportMp4(body);
    response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": video.length, "Content-Disposition": 'attachment; filename="video-agent-reel.mp4"', "Cache-Control": "no-store" });
    return response.end(video);
  }

  return sendJson(response, 404, { error: "API route not found." });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url.pathname);
    const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filePath = path.resolve(ROOT, `.${requestedPath}`);
    if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) return sendJson(response, 403, { error: "Forbidden." });
    let stat;
    try { stat = await require("node:fs/promises").stat(filePath); } catch { return sendJson(response, 404, { error: "File not found." }); }
    if (!stat.isFile()) return sendJson(response, 404, { error: "File not found." });
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": [".html", ".css", ".js"].includes(path.extname(filePath).toLowerCase()) ? "no-cache" : "public, max-age=600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || "Unexpected server error." });
  }
});

const HOST = process.env.HOST || (process.env.K_SERVICE ? "0.0.0.0" : "127.0.0.1");
server.listen(PORT, HOST, () => {
  console.log(`Video Agent is running at http://localhost:${PORT}`);
  console.log(`Model mode: ${ideasConfigured ? "Ideas connected" : "Ideas off"} · ${qwenEndpoint ? "Qwen connected" : "Qwen demo"} · ${project && outputUri ? "Vertex configured" : "Vertex demo"}`);
});
