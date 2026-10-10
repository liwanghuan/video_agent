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
| 01 · Voiceover | Develop an idea and timed transcript, choose a voice, and generate narration. A full production plan can split narration into per-shot blocks. | `/api/script` → Gemini; `/api/tts` → configured Qwen endpoint |
| 02 · Bring to life | Generate one scene in the classic workflow, or review/edit a multi-shot storyboard and generate each shot's narration and Veo clip in order. | `/api/video` → Vertex AI Veo long-running prediction; shot state/orchestration in `app.js` |
| 03 · Polish & export | Mux one scene with narration, or concatenate all storyboard clips with their corresponding narration, add optional selectable subtitles, preview, and download the final MP4. | `/api/export` or `/api/export-segments` → FFmpeg |

The ideas stage contains an original idea, optional Gemini concepts, and the ADK full-video plan. The plan shows timed transcript blocks and shot cards with editable narration, opening/closing-frame prompts, and a Veo motion prompt. A shot may generate its audio and video separately; “generate all” processes them sequentially. The explicit final-export action remains disabled until every shot has both assets. The older single-scene workflow remains available for a single opening image, one voiceover, and one Veo clip.

## 3. Runtime architecture

```text
┌────────────────────── Browser ──────────────────────┐
│ index.html + styles.css + app.js                    │
│ stage UI · local draft · per-shot state · preview   │
└────────────────────────┬────────────────────────────┘
                         │ same-origin HTTP / JSON / media
┌────────────────────────▼────────────────────────────┐
│ Node.js server.js (static server + API orchestration)│
│ config · provider auth · Veo polling · FFmpeg export │
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
                    ┌───────┴────────┐
                    ▼                ▼
          single-scene mux    multi-shot concat/mux
             /api/export       /api/export-segments
```

### Browser

- `index.html` defines the semantic page structure, controls, panels, dialogs, and media elements.
- `styles.css` owns visual styling and responsive behavior.
- `app.js` controls navigation, form state, client-side validation, provider status, rendering of model results, and calls to the backend.
- The browser downsizes idea-reference photos before sending them (maximum side 1280 px; JPEG quality 0.85) and limits an idea session to six photos.
- Draft fields are saved in browser `localStorage` under `framehouse-draft`. Generated audio/video blobs and uploaded image data are in-memory for the active page session; they are not a durable asset library.

### Node.js application server

`server.js` uses Node's built-in HTTP, filesystem, and process APIs; there is no frontend bundler or npm dependency tree. It serves static files, routes `/api/*`, calls providers, and launches FFmpeg for single- and multi-shot exports. `.env` is read for local development; Cloud Run values are injected as environment variables. A separate Python service in `adk_service/` provides the ADK planning workflow; the browser then orchestrates media requests through the Node API.

The Docker image is defined by `Dockerfile`: Node 22 Debian slim, FFmpeg and CA certificates, static app files and sample assets, then `node server.js`. The server listens on the injected `PORT` and binds to `0.0.0.0` in Cloud Run.

## 4. API surface and data flow

All API endpoints are same-origin JSON requests unless noted. Errors are returned as JSON `{ "error": "..." }` with an HTTP error status.

| Route | Input (summary) | Output | Provider / behavior |
|---|---|---|---|
| `GET /api/health` | None | `{ qwen, vertex, ideas, adk, demo, model, location }` | Configuration presence only; not a full provider readiness test. |
| `POST /api/ideas` | `brief`, `platform`, `transcript`, `images[]` (`name`, `mimeType`, base64 `data`) | `materials`, `trends`, `ideas`, grounded `sources`, `model` | Gemini; Google Search grounding enabled. Images are filtered to supported types and capped at six. |
| `POST /api/script` | `idea`, `brief`, `platform`, `durationSeconds`, `avatar`, `images[]` | Timed `hook`, `beats`, `screenplay[]`, `avatar`, `motion`, `prep`, composed `voiceover`, `model` | Gemini JSON response; duration restricted to 15/30/45/60 seconds and presenter to known enum values. |
| `POST /api/production-plan` | `projectId`, `baseProjectVersion`, selected `idea`, `brief`, confirmed `facts[]`, platform/language/duration, `frameAssets[]`, voice profile ID | Proposal with `proposalId`, `inputHash`, `scriptPlan`, `scenePlan`, warnings, and `approvalRequired: true` | Proxies to private ADK planner configured by `ADK_PLANNER_URL`; requires an even duration from 4–60 seconds. Synchronous planning only; does not persist proposals or enqueue media jobs. |
| `POST /api/tts` | `text`, optional `voice` | `audio/mpeg` bytes | Proxies to `QWEN_TTS_ENDPOINT`; upstream may return MP3 bytes or JSON containing base64 audio. |
| `POST /api/video` | `prompt`, `transcript`, `firstFrame`, optional `lastFrame`, `durationSeconds`, `aspectRatio`, `resolution` | `video/mp4` bytes | Starts Veo `predictLongRunning`, polls operation, downloads result from GCS when needed. Veo audio is disabled. |
| `POST /api/export` | base64 `videoBase64`, `audioBase64`, `transcript`, `subtitles`, `loopVideo` | Downloadable MP4 bytes | Writes temporary files, runs FFmpeg to encode H.264/AAC and optional `mov_text` subtitle track, then removes temp directory. |
| `POST /api/export-segments` | Ordered `segments[]` of base64 video/audio, transcript, and 4/6/8-second duration; `aspectRatio`, `resolution`, `subtitles` | Final `video/mp4` bytes | Normalizes shot video, concatenates video and matching audio tracks, pads short audio to its shot duration, holds the final frame if audio runs long, and adds optional selectable Chinese `mov_text` captions. Up to 15 shots / 120 seconds; JSON body limit 120 MiB. |

### End-to-end production sequence

1. Optional planning: the browser sends the creator brief, platform, references, and optionally current draft/opening frame to `/api/ideas`. The server uses Gemini with Google Search grounding and returns source links with the structured plan.
2. Script: `/api/script` asks Gemini for a timed Chinese voiceover and screenplay. The UI renders timing and flags a hook over three seconds or a beat over five seconds; this is a client-side warning, not a server rejection.
3. **Single-scene production:** `/api/tts` forwards the transcript and selected voice to Qwen; `/api/video` sends the opening frame and silent-scene prompt to Veo. The browser holds both outputs and `/api/export` muxes Qwen audio onto the Veo clip, optionally looping the clip and embedding a selectable subtitle track.
4. **Multi-shot production:** the ADK proposal supplies continuous shot timing, transcript-block ownership, and frame/motion prompts. The browser calls `/api/tts` for each shot with the same selected voice, then calls `/api/video` in order. Shot 1 starts from the selected/default listing photo; the browser extracts each clip's final frame and sends it as the next shot's actual opening image. Re-generating a shot invalidates downstream video takes while retaining their audio.
5. **Final assembly:** `/api/export-segments` receives all ordered MP4/MP3 pairs and uses FFmpeg to normalize and concatenate them into one MP4. Each narration starts at its shot boundary; short audio is padded with silence, and when speech exceeds the planned shot duration the video holds its last frame rather than cutting speech. Optional captions are selectable MP4 subtitles; their timing is estimated from text length, not speech recognition.
6. **Editing and export limits:** prompt/text edits are per active browser session; revised narration invalidates that shot's audio and downstream video chain. No version history or saved generated media is implemented. Single-scene export can loop; storyboard export preserves shot order and per-shot audio.

## 5. Model and cloud boundaries

### Gemini

Gemini is used for idea research and script/screenplay generation. `GEMINI_API_KEY` gates both features; `IDEAS_MODEL_ID` selects the model (default in code: `gemini-3.8-flash`). The app calls the Generative Language API from the server. Idea research enables Google Search grounding; script generation requests JSON without grounding. Do not send this key to the browser.

The production-plan path uses ADK with Vertex AI Gemini in `adk_service/`, currently running Transcript Planner → Scene Planner → Plan Reviewer. It defaults to `gemini-3.7-flash` (override with `ADK_MODEL_ID`) and uses its Cloud Run service identity rather than `GEMINI_API_KEY`. The ADK service returns a proposal and does not call Qwen/Veo or persist an approval/job. The browser's storyboard editor runs the per-shot Qwen and Veo requests through the Node API after creator review.

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
| `ADK_PLANNER_URL` | Optional private ADK planner URL; the Node API obtains a Cloud Run identity token when deployed on Cloud Run. |
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
- **No durable job model:** existing Gemini/Veo calls are synchronous from the UI perspective. Veo is polled inside one server request; there is no queue, job ID, retry workflow, or resumable progress state. ADK planning is also synchronous and its one-invocation session is in memory.
- **Request memory and size:** JSON/base64 image and media payloads can be large. `readJson` has a global limit (120 MiB), with lower per-route limits for planning/TTS; multi-shot export accepts at most 15 clips and 120 seconds. Large media and concurrent FFmpeg exports can consume substantial memory, so size Cloud Run memory/concurrency from observed workloads.
- **Authentication is deployment-level:** this code does not implement app user login or per-user authorization. Keep the Cloud Run service behind a suitable authenticated access layer; do not expose paid model endpoints without abuse controls.
- **Provider flags are configuration checks:** `/api/health` does not make test calls to confirm readiness.
- **Export behavior:** single-scene narration can loop the source video; multi-shot output concatenates the generated clips and their matching audio. Shot audio alignment is boundary-level, not phoneme/word-level. Selectable subtitle timing is estimated from transcript length and shot duration, not aligned to recognized speech.
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
6. **Persist storyboard assets and versions:** the current multi-shot UI generates and assembles per-shot assets in browser memory; store each prompt, frame, audio/video output, and edit version durably in Cloud Storage and a project database.
7. **Improve synchronization:** use Qwen timing metadata or forced alignment to place speech and subtitle cues precisely within each shot instead of estimating subtitle timing by character count.
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
| `adk_service/` | Python ADK planning workflow and private Cloud Run service container. |
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
