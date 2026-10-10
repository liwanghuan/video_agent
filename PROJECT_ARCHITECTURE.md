# Video Agent — Project Design and Architecture

This document describes the repository as it exists today and provides architectural context for future development. It is intended for engineers and product designers continuing the project. Treat the code as the source of truth when implementation and this overview differ.

## 1. Product intent

Video Agent is a browser-based creative workspace for real-estate and other small-business agents who need short social videos but may start with only an idea, a transcript, and a few photos. The product guides a creator from research and story planning through Mandarin voiceover, image-to-video generation, and MP4 export.

The primary product principles are:

- Guide, do not just expose model controls: structure creation into clear stages.
- Keep the creator in control: generated ideas, scripts, and camera directions remain editable before production.
- Ground content in supplied facts and media; the script prompt asks the model to use placeholders rather than invent missing prices or claims.
- Separate speech from visuals: Qwen generates narration; Veo generates silent motion footage; FFmpeg combines them at export.
- Keep cloud credentials server-side. The browser calls this app's API and never calls Google or Qwen with secret credentials directly.
- Preserve a usable demo state when live model services are not configured.

## 2. User workflow and screen model

The interface is a single-page application with four top-level stages. The current sidebar and sample project list are visual prototype content, not a multi-user project database.

| Stage | User intent | Main implementation |
|---|---|---|
| 00 · Ideas | Describe the promotion, choose a platform, add up to six photos, and receive a material review, current trend research, and three concepts. | `/api/ideas` → Gemini `generateContent` with Google Search grounding |
| 01 · Voiceover | Develop an idea, set target duration/presenter, generate a timed script and screenplay, or skip directly to writing/editing the transcript; choose a voice and generate speech. | `/api/script` → Gemini; `/api/tts` → configured Qwen endpoint |
| 02 · Bring to life | Choose opening/optional closing frames, camera direction, aspect ratio, resolution, and 4/6/8-second scene duration. | `/api/video` → Vertex AI Veo long-running prediction |
| 03 · Polish & export | Review the scene, request a new take/edit, configure looping/subtitles/safe-area preview, and download an MP4. | `/api/export` → FFmpeg muxing and subtitle embedding |

The ideas stage contains two substeps: an original idea (creator-editable) and the generated script/screenplay. The screenplay view exposes the timed hook/beats, presenter brief, shot list, visual direction, on-screen text, voiceover, audio, transitions, and sources. It can be copied or downloaded as Markdown. “Use this script” passes the voiceover and opening motion to the production workflow.

## 3. Runtime architecture

```text
┌────────────────────── Browser ──────────────────────┐
│ index.html + styles.css + app.js                    │
│ stage UI · local draft · image downscaling · preview │
└────────────────────────┬────────────────────────────┘
                         │ same-origin HTTP / JSON / media
┌────────────────────────▼────────────────────────────┐
│ Node.js server.js (static server + API orchestration)│
│ config · input checks · provider auth · polling      │
└──────┬──────────────────┬───────────────────┬───────┘
       │                  │                   │
       ▼                  ▼                   ▼
 Gemini API         Qwen TTS service      Vertex AI Veo
 ideas + script     external HTTP API     async video job
 Google Search      MP3 response           │
 grounding                                 ▼
                                      Cloud Storage
                                      temporary Veo file
       │                  │                   │
       └──────────────────┴──────────┬────────┘
                                     ▼
                           server returns video/audio
                                     │
                                     ▼
                         FFmpeg → exported MP4
```

### Browser

- `index.html` defines the semantic page structure, controls, panels, dialogs, and media elements.
- `styles.css` owns visual styling and responsive behavior.
- `app.js` controls navigation, form state, client-side validation, provider status, rendering of model results, and calls to the backend.
- The browser downsizes idea-reference photos before sending them (maximum side 1280 px; JPEG quality 0.85) and limits an idea session to six photos.
- Draft fields are saved in browser `localStorage` under `framehouse-draft`. Generated audio/video blobs and uploaded image data are in-memory for the active page session; they are not a durable asset library.

### Node.js application server

`server.js` uses Node's built-in HTTP, filesystem, and process APIs; there is no frontend bundler or npm dependency tree. It serves static files, routes `/api/*`, calls providers, and launches FFmpeg for export. `.env` is read for local development; Cloud Run values are injected as environment variables.

The Docker image is defined by `Dockerfile`: Node 22 Debian slim, FFmpeg and CA certificates, static app files and sample assets, then `node server.js`. The server listens on the injected `PORT` and binds to `0.0.0.0` in Cloud Run.

## 4. API surface and data flow

All API endpoints are same-origin JSON requests unless noted. Errors are returned as JSON `{ "error": "..." }` with an HTTP error status.

| Route | Input (summary) | Output | Provider / behavior |
|---|---|---|---|
| `GET /api/health` | None | `{ qwen, vertex, ideas, demo, model, location }` | Configuration presence only; not a full provider readiness test. |
| `POST /api/ideas` | `brief`, `platform`, `transcript`, `images[]` (`name`, `mimeType`, base64 `data`) | `materials`, `trends`, `ideas`, grounded `sources`, `model` | Gemini; Google Search grounding enabled. Images are filtered to supported types and capped at six. |
| `POST /api/script` | `idea`, `brief`, `platform`, `durationSeconds`, `avatar`, `images[]` | Timed `hook`, `beats`, `screenplay[]`, `avatar`, `motion`, `prep`, composed `voiceover`, `model` | Gemini JSON response; duration restricted to 15/30/45/60 seconds and presenter to known enum values. |
| `POST /api/tts` | `text`, optional `voice` | `audio/mpeg` bytes | Proxies to `QWEN_TTS_ENDPOINT`; upstream may return MP3 bytes or JSON containing base64 audio. |
| `POST /api/video` | `prompt`, `transcript`, `firstFrame`, optional `lastFrame`, `durationSeconds`, `aspectRatio`, `resolution` | `video/mp4` bytes | Starts Veo `predictLongRunning`, polls operation, downloads result from GCS when needed. Veo audio is disabled. |
| `POST /api/export` | base64 `videoBase64`, `audioBase64`, `transcript`, `subtitles`, `loopVideo` | Downloadable MP4 bytes | Writes temporary files, runs FFmpeg to encode H.264/AAC and optional `mov_text` subtitle track, then removes temp directory. |

### End-to-end production sequence

1. Optional planning: the browser sends the creator brief, platform, references, and optionally current draft/opening frame to `/api/ideas`. The server uses Gemini with Google Search grounding and returns source links with the structured plan.
2. Script: `/api/script` asks Gemini for a timed Chinese voiceover and screenplay. The UI renders timing and flags a hook over three seconds or a beat over five seconds; this is a client-side warning, not a server rejection.
3. Voice: `/api/tts` forwards text/voice/MP3 format to Qwen. The generated audio is held in browser memory and becomes the export narration.
4. Scene: `/api/video` uploads the chosen still frame(s), English motion direction, transcript context, ratio, duration, and resolution to Veo. The server polls the long-running operation for up to 12 minutes, retrieves the returned clip, and streams it to the browser.
5. Edit: an edit changes the prompt and triggers another Veo generation from the selected opening frame. A durable version history is not implemented.
6. Export: `/api/export` loops the scene when requested so it can cover narration length, muxes audio/video, optionally writes subtitle text based on the transcript, and returns the final MP4 for download.

## 5. Model and cloud boundaries

### Gemini

Gemini is used for idea research and script/screenplay generation. `GEMINI_API_KEY` gates both features; `IDEAS_MODEL_ID` selects the model (default in code: `gemini-3.8-flash`). The app calls the Generative Language API from the server. Idea research enables Google Search grounding; script generation requests JSON without grounding. Do not send this key to the browser.

### Qwen3-TTS

Qwen is an external service, not part of the repository image. `QWEN_TTS_ENDPOINT` must implement the request/response contract described in `README.md`. `QWEN_TTS_TOKEN` optionally supplies a bearer token. On Cloud Run, if the token is absent, the server attempts to mint an identity token for the Qwen service. A private Cloud Run Qwen service must grant `roles/run.invoker` to the Framehouse runtime identity.

### Vertex AI Veo

`GOOGLE_CLOUD_PROJECT`, `VERTEX_LOCATION`, `VERTEX_MODEL_ID`, and `VERTEX_OUTPUT_URI` configure Veo. Defaults in the current code are `us-central1` and `veo-3.1-fast-generate-001`. Cloud Run authentication uses the runtime service account and metadata server; local authentication uses `gcloud auth print-access-token`. The service account needs Vertex AI invocation permissions and object read/write access to the output bucket.

The Vertex output bucket is an intermediate location, not the application's media database. Add an object lifecycle policy for cleanup. Veo generation and Cloud Run request timeouts must stay compatible.

## 6. Configuration and deployment

See [`.env.example`](.env.example) for local configuration and [`DEPLOY_GCLOUD.md`](DEPLOY_GCLOUD.md) for setup/deploy commands and IAM. The principal configuration values are:

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Enables idea and screenplay calls. |
| `IDEAS_MODEL_ID` | Optional Gemini model override. |
| `QWEN_TTS_ENDPOINT` | External Qwen HTTP API URL. |
| `QWEN_TTS_TOKEN` | Optional Qwen bearer token; use Secret Manager in Cloud Run. |
| `GOOGLE_CLOUD_PROJECT` | GCP project for Vertex. |
| `VERTEX_LOCATION` | Vertex endpoint region. |
| `VERTEX_MODEL_ID` | Veo model ID. |
| `VERTEX_OUTPUT_URI` | Writable `gs://` prefix for Veo results. |
| `PORT` | HTTP listener port; Cloud Run injects this value. |

The UI can still preview bundled sample media with no cloud configuration. The health endpoint reflects whether configuration exists, not whether credentials, quota, endpoint reachability, model access, or bucket permissions have been verified.

## 7. Persistence, security, and current constraints

These are important current boundaries, not assumptions to build on:

- **No application database:** project names/sidebar entries are static examples. There is no account system, shared workspace, server-side project record, or saved generation history.
- **Browser-local drafts only:** `localStorage` is per-browser/device and not a backup or collaboration mechanism.
- **Ephemeral generated media:** generated buffers are transferred directly; browser object URLs are temporary. GCS is used as Veo staging only.
- **No durable job model:** Gemini/Veo calls are synchronous from the UI perspective. Veo is polled inside one server request; there is no queue, job ID, retry workflow, or resumable progress state.
- **Request memory and size:** JSON/base64 image and media payloads can be large. `readJson` has a global limit (120 MiB), with lower per-route limits for planning/TTS. Large media and concurrent FFmpeg exports can consume substantial memory.
- **Authentication is deployment-level:** this code does not implement app user login or per-user authorization. Keep the Cloud Run service behind a suitable authenticated access layer; do not expose paid model endpoints without abuse controls.
- **Provider flags are configuration checks:** `/api/health` does not make test calls to confirm readiness.
- **Export behavior:** longer narration is handled by looping the generated scene, not by generating a multi-shot film. Subtitle text is split into character/punctuation-based chunks and distributed across the audio duration; it is not aligned to recognized speech timestamps.
- **Input and safety:** prompts and uploads are model inputs. Add validation, size/type controls, user consent for likeness/voice use, retention policy, and rate limits before a public multi-user launch.
- **Sample media:** bundled samples are demos; they are not evidence that models are connected. Respect source/usage rights when replacing sample assets.

## 8. Design system and interaction conventions

The UI is implemented in plain HTML/CSS rather than a component framework. `index.html` provides stable element IDs consumed by `app.js`; IDs are effectively the frontend's component/API contract. Keep the markup and selectors synchronized when editing either side.

Interaction patterns already in use:

- One active workflow stage at a time; `setStep()` owns panel visibility and document title.
- Async buttons preserve their original markup and show a busy label while an operation runs.
- Inline feedback is used for operation-level success/failure; toast notifications are short confirmations.
- Provider state is fetched once from `/api/health` and reflected in connection labels.
- User-generated text remains editable between stages; only explicit buttons cross into a new stage.
- Dynamic model output should be inserted with `textContent`/DOM creation. Validate external URLs before rendering links (see `safeUrl()`), and use `noopener noreferrer` for new tabs.

## 9. Extension points for the next development phase

Recommended evolution paths; none are implemented unless noted above:

1. **Define durable domain models:** `Project`, `Asset`, `IdeaPlan`, `ScriptPlan`, `GenerationJob`, `VideoVersion`, and `Export`. Give each user/workspace ownership and timestamps.
2. **Move media out of request bodies:** browser uploads directly to private Cloud Storage using short-lived signed/resumable upload flows; send asset IDs to the API rather than large base64 payloads.
3. **Turn long calls into jobs:** create an API job record, enqueue Gemini/Veo/export work, return a job ID, expose progress/status/cancel/retry, and persist generated outputs. Avoid holding a single Cloud Run request open during Veo polling.
4. **Add identity and authorization:** authenticate users, scope every project/asset/job query by tenant, protect model spend with quotas/rate limits, and audit generation/export events.
5. **Make generation stages versioned:** store each script and prompt revision; model edits should create new versions rather than overwrite state. Support re-running audio/video independently.
6. **Improve screenplay-to-video:** generate a multi-shot plan and match scene durations, images, and narration beats; current Veo integration creates one scene per request.
7. **Align subtitles to speech:** use speech marks or forced alignment instead of assigning the full transcript to a single segment.
8. **Add tests and provider adapters:** unit-test request validation and transformations, contract-test Gemini/Qwen/Vertex adapters with fixtures, and add end-to-end tests for the workflow using mocked providers.
9. **Improve observability:** structured logs with request/job IDs, provider latency/error metrics, safe redaction, and alerts for failed generations and cost spikes.
10. **Centralize configuration and schemas:** validate environment at startup and define JSON schemas for model responses so prompt/model drift is surfaced early.

## 10. Repository map

| Path | Responsibility |
|---|---|
| `index.html` | App layout, workflow panels, modal/drawer, media controls. |
| `styles.css` | Visual design, responsive layout, component states. |
| `app.js` | Browser state, stage flow, provider requests, result rendering, local draft, downloads. |
| `server.js` | Static HTTP server, API handlers, Gemini/Qwen/Vertex integration, FFmpeg pipeline. |
| `Dockerfile` | Cloud Run runtime image; installs FFmpeg and copies app/sample assets. |
| `.env.example` | Local/runtime configuration template. |
| `DEPLOY_GCLOUD.md` | Step-by-step Google Cloud deployment notes. |
| `edge_samples/` | Reference voices, transcripts, and demo media served by the app. |
| `f30881536.jpg` | Default listing image used as opening-frame/demo poster. |

## 11. Local development

```bash
npm start
```

Open `http://localhost:5173`. There is no build step. Copy `.env.example` to `.env` for local provider configuration. Gemini calls need `GEMINI_API_KEY`; Vertex calls use local Google Cloud credentials (`gcloud auth application-default login`); Qwen must be reachable at `QWEN_TTS_ENDPOINT`.
