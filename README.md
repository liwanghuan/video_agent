# Video Agent

This is the GitHub project for a video cutting and generation agent. Video Agent is a browser-based workspace that helps you decide what video to make, then turns a transcript and a few photos into a short social video. It includes Xiaoyi voice samples, sample listing media, and a demo preview. Idea generation uses Gemini with Google Search grounding; live voice and video generation need a Qwen3-TTS service and Google Cloud Vertex AI.

## Run locally

```bash
npm start
```

Open [http://localhost:5173](http://localhost:5173). No frontend build step or npm dependencies are required.

Copy `.env.example` to `.env` and set:

- `GEMINI_API_KEY`: turns on step 00, Ideas. `IDEAS_MODEL_ID` can override the default `gemini-3.8-flash`.
- `QWEN_TTS_ENDPOINT`: an endpoint that accepts `{ "text", "voice", "format" }` and returns MP3 bytes or `{ "audioBase64": "..." }`.
- `ADK_PLANNER_URL`: optional private ADK planning service URL. Its Cloud Run deployment and local setup are in [`DEPLOY_GCLOUD.md`](DEPLOY_GCLOUD.md).
- `GOOGLE_CLOUD_PROJECT` and `VERTEX_OUTPUT_URI`: a project with Vertex AI and a writable Cloud Storage output prefix.
- `VERTEX_LOCATION` and `VERTEX_MODEL_ID` can override the defaults.

For local Vertex requests, sign in with Application Default Credentials:

```bash
gcloud auth application-default login
```

The Qwen endpoint is a separate model service. The UI does not put Google or Qwen credentials in the browser. The server calls Qwen and Vertex; FFmpeg combines their outputs into downloadable MP4 files.

When `ADK_PLANNER_URL` is configured, the Ideas screen offers a multi-agent full-video plan. It returns timed transcript blocks and per-shot opening-frame, closing-frame, and Veo motion prompts. Review and edit each shot, then generate its Qwen audio and silent Veo video. Shots run sequentially so each next Veo request starts from the actual last frame extracted from the preceding clip. Media currently lives in the browser session and is not persisted as a cloud project.

## Deploy the UI and Vertex proxy to Cloud Run

For the separate private ADK planner deployment, inter-service IAM, and configuration, follow [`DEPLOY_GCLOUD.md`](DEPLOY_GCLOUD.md). The main studio service account needs `roles/run.invoker` on the planner service.

Create a writable bucket and configure a Cloud Run service account with Vertex AI User and Storage Object User permissions for the generated output bucket. The Qwen endpoint must also be reachable from the service. If it requires Cloud Run IAM, grant the studio service account permission to invoke that service. Set `PROJECT_ID`, `BUCKET`, and `REGION` for the shell before running:

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com aiplatform.googleapis.com

gcloud artifacts repositories create framehouse \
  --repository-format=docker \
  --location="$REGION"

gcloud builds submit \
  --tag "$REGION-docker.pkg.dev/$PROJECT_ID/framehouse/studio:latest"

gcloud run deploy framehouse-studio \
  --image "$REGION-docker.pkg.dev/$PROJECT_ID/framehouse/studio:latest" \
  --region "$REGION" \
  --memory 2Gi \
  --cpu 2 \
  --timeout 900 \
  --no-allow-unauthenticated \
  --set-env-vars "GEMINI_API_KEY=$GEMINI_API_KEY,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,VERTEX_LOCATION=us-central1,VERTEX_MODEL_ID=veo-3.1-fast-generate-001,VERTEX_OUTPUT_URI=gs://$BUCKET/framehouse/,QWEN_TTS_ENDPOINT=$QWEN_TTS_ENDPOINT"
```

Grant `roles/aiplatform.user` to the Cloud Run service account and `roles/storage.objectUser` on the output bucket. The service reads its Cloud Run identity token through the metadata server and uses an identity token to call a private Cloud Run Qwen endpoint. For production, keep the studio service authenticated for agent access.

## Live generation sequence

0. `/api/ideas` sends your brief, target platform, photos (up to 6, downscaled in the browser) and optionally your current script and opening frame to Gemini. Gemini reviews the materials, uses Google Search grounding to find accounts and formats working on that platform now, and returns a materials review, trend notes with links, and three ready-to-use scripts with camera directions. "Use draft as-is" fills the transcript and motion direction straight away.
   - **Step 1 · Original idea:** "Develop this idea" copies an idea into an editable original-idea box, or "I already have an idea" lets you write your own.
   - **Step 2 · Script & screenplay:** `/api/script` sends the original idea, target length (15/30/45/60s), presenter choice (real person, digital human, none, or let the agent choose) and photos to Gemini. It returns a script that follows the 3s + 5s rule (a hook in the first 3 seconds, a new point at least every 5 seconds), a presenter brief, and a shot-by-shot screenplay with shot size, angle, camera move, presenter action, on-screen text, voiceover, sound, transition and source. The UI flags beats that break the timing, and you can copy or download the screenplay as Markdown or send the voiceover and opening motion to step 01.
1. The ADK planner produces a transcript with shot timing and a video plan. Each scene gets a narration block, an opening/closing still-frame prompt, and a silent Veo motion prompt. The service validates that transcript blocks map to the scene containing their midpoint and shares each shot's closing composition with the next shot.
2. `/api/tts` generates each shot's narration using the same selected voice profile. `/api/video` generates the corresponding silent Veo 3.1 Fast clip. The browser passes the first uploaded photo to shot 1, then extracts each generated clip's final frame for the next shot's opening image.
3. For the single-scene workflow, `/api/export` overlays the generated voiceover on the Veo scene, optionally loops the scene to cover longer narration, adds an optional selectable Chinese subtitle track, and exports H.264/AAC MP4.
4. For the storyboard workflow, `/api/export-segments` normalizes and concatenates ordered Veo clips and their matching Qwen audio tracks, adds an optional selectable Chinese subtitle track, and exports one final MP4. Short narration tracks are padded with silence to the shot boundary; if a voice track runs longer than its shot, that shot's last frame is held so speech is not cut off. The assembly route accepts up to 15 shots and 120 seconds, with a 120 MiB JSON request limit.

Veo supports 4, 6, or 8 seconds per scene. Single-scene export can loop that scene to cover narration; the multi-shot workflow instead concatenates its planned clips and keeps each narration track aligned to its shot. The included demo MP4 is explicitly a sample output and does not imply that either cloud model is connected.
