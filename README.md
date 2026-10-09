# Video Agent

This is the GitHub project for a video cutting and generation agent. Video Agent is a browser-based workspace that helps you decide what video to make, then turns a transcript and a few photos into a short social video. It includes Xiaoyi voice samples, sample listing media, and a demo preview. Idea generation uses Claude with web search; live voice and video generation need a Qwen3-TTS service and Google Cloud Vertex AI.

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:5173](http://localhost:5173). There is no frontend build step; `npm install` only adds the Anthropic SDK used by the idea step.

Copy `.env.example` to `.env` and set:

- `ANTHROPIC_API_KEY`: turns on step 00, Ideas. `IDEAS_MODEL_ID` can override the default `claude-opus-5-5`.
- `QWEN_TTS_ENDPOINT`: an endpoint that accepts `{ "text", "voice", "format" }` and returns MP3 bytes or `{ "audioBase64": "..." }`.
- `GOOGLE_CLOUD_PROJECT` and `VERTEX_OUTPUT_URI`: a project with Vertex AI and a writable Cloud Storage output prefix.
- `VERTEX_LOCATION` and `VERTEX_MODEL_ID` can override the defaults.

For local Vertex requests, sign in with Application Default Credentials:

```bash
gcloud auth application-default login
```

The Qwen endpoint is a separate model service. The UI does not put Google or Qwen credentials in the browser. The server calls Qwen first, sends the transcript with the chosen visual direction and frame(s) to Veo, then muxes the generated scene and narration into an MP4 with FFmpeg.

## Deploy the UI and Vertex proxy to Cloud Run

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
  --memory 1Gi \
  --cpu 2 \
  --timeout 900 \
  --no-allow-unauthenticated \
  --set-env-vars "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,VERTEX_LOCATION=us-central1,VERTEX_MODEL_ID=veo-3.1-fast-generate-001,VERTEX_OUTPUT_URI=gs://$BUCKET/framehouse/,QWEN_TTS_ENDPOINT=$QWEN_TTS_ENDPOINT"
```

Grant `roles/aiplatform.user` to the Cloud Run service account and `roles/storage.objectUser` on the output bucket. The service reads its Cloud Run identity token through the metadata server and uses an identity token to call a private Cloud Run Qwen endpoint. For production, keep the studio service authenticated for agent access.

## Live generation sequence

0. `/api/ideas` sends your brief, target platform, photos (up to 6, downscaled in the browser) and optionally your current script and opening frame to Claude. Claude reviews the materials, uses web search to find accounts and formats working on that platform now, and returns a materials review, trend notes with links, and three ready-to-use scripts with camera directions. "Use this idea" fills the transcript and motion direction.
1. `/api/tts` sends the written transcript and voice choice to the configured Qwen endpoint.
2. `/api/video` submits the selected opening frame, optional ending frame, and motion direction to Vertex AI Veo 3.1 Fast. It disables Veo audio because the separately generated Qwen narration is the soundtrack.
3. `/api/export` combines the scene and narration into an MP4 with H.264 video and AAC audio.

Veo supports 4, 6, or 8 seconds per scene. Longer narration currently keeps the narration length by looping the generated scene during export; a multi-scene storyboard is a better follow-up for longer listing scripts. The included demo MP4 is explicitly a sample output and does not imply that either cloud model is connected.
