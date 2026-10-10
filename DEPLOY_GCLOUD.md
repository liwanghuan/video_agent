# Deploy Framehouse to Google Cloud

This guide deploys the Framehouse web app/API on Cloud Run, uses Vertex AI Veo 3.1 to generate video, and calls a separately hosted Qwen3-TTS service for narration.

## Architecture

```text
Browser → Framehouse (Cloud Run) → Qwen3-TTS HTTP service
                              ├→ Vertex AI Veo 3.1
                              └→ Cloud Storage (temporary Veo output)
```

The Node app, website, `/api/tts`, `/api/video`, `/api/export`, `/api/export-segments`, and FFmpeg mux/assembly are in this repository. Veo is a managed Vertex model, not a container you deploy. Qwen3-TTS is an open model and must run as a separate inference service. See the [official Qwen3-TTS repository](https://github.com/QwenLM/Qwen3-TTS) for model setup.

## 1. Prepare the Google Cloud project

Install the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), use a billing-enabled project, and replace the sample project ID if you copy this block:

```bash
export PROJECT_ID="your-project-id"
export REGION="asia-southeast1"
export VERTEX_REGION="us-central1"
export BUCKET="${PROJECT_ID}-framehouse-video"
export RUN_SERVICE="framehouse-studio"
export RUN_SA="framehouse-runtime"

gcloud auth login
gcloud config set project "$PROJECT_ID"
gcloud config set run/region "$REGION"

gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com storage.googleapis.com iam.googleapis.com secretmanager.googleapis.com

gcloud artifacts repositories create framehouse \
  --repository-format=docker --location="$REGION"
```

Check current Veo availability and quota before selecting `VERTEX_REGION`. The app currently defaults to `us-central1`.

Create a bucket for generated Veo output and a dedicated Cloud Run runtime identity:

```bash
gcloud storage buckets create "gs://${BUCKET}" \
  --location="$VERTEX_REGION" --uniform-bucket-level-access

gcloud iam service-accounts create "$RUN_SA" \
  --display-name="Framehouse Cloud Run runtime"
export RUN_SA_EMAIL="${RUN_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUN_SA_EMAIL}" --role="roles/aiplatform.user"
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${RUN_SA_EMAIL}" --role="roles/storage.objectUser"
```

The service account uses Cloud Run's service identity. Do not create or package a service-account key. The roles above permit Vertex calls and access to the output bucket.

## 2. Host Qwen3-TTS

Qwen is not included in this repository. Run it on a GPU host (for example, a GPU-enabled Cloud Run service, Compute Engine, or another managed GPU platform) and expose an HTTPS inference endpoint.

Framehouse sends this JSON `POST` to `QWEN_TTS_ENDPOINT`:

```json
{"text":"Narration transcript","voice":"Xiaoyi","format":"mp3"}
```

The endpoint must return MP3 bytes, or JSON such as `{"audioBase64":"<base64 MP3>"}`. If the Qwen serving framework has a different API, put a small adapter in front of it. That adapter must map the voice name to a supported Qwen speaker or voice-cloning prompt; a voice label by itself does not clone the sample recording.

For Cloud Run GPU, build and deploy your **Qwen server's own container** (not this app's Dockerfile). Example for an L4 in Singapore; adjust resources and startup behavior after testing your chosen model:

```bash
export QWEN_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/framehouse/qwen-tts:latest"
gcloud builds submit /path/to/qwen-service --tag "$QWEN_IMAGE"

gcloud run deploy framehouse-qwen \
  --image "$QWEN_IMAGE" --region "$REGION" \
  --cpu 8 --memory 32Gi --gpu 1 --gpu-type nvidia-l4 \
  --no-gpu-zonal-redundancy --concurrency 1 --max-instances 2 \
  --timeout 900 --no-allow-unauthenticated
```

This is a sizing example, not a guarantee that a particular Qwen checkpoint fits or is available under your GPU quota. See current [Cloud Run GPU requirements and regions](https://docs.cloud.google.com/run/docs/configuring/services/gpu). For private Cloud Run Qwen, let the Framehouse runtime identity invoke it:

```bash
gcloud run services add-iam-policy-binding framehouse-qwen \
  --region "$REGION" \
  --member="serviceAccount:${RUN_SA_EMAIL}" --role="roles/run.invoker"
export QWEN_URL="$(gcloud run services describe framehouse-qwen \
  --region "$REGION" --format='value(status.url)')"
```

Use the canonical Cloud Run service URL for `QWEN_TTS_ENDPOINT`. Framehouse automatically obtains an identity token for this private service. For another host, use its HTTPS endpoint and protect it with an API token; don't expose a paid inference endpoint anonymously.

## 3. Deploy the ADK production-planning service

The separate Python service runs three ADK roles in order: Transcript Planner, Scene Planner, and Plan Reviewer. It returns timed transcript blocks plus editable per-shot opening-frame, closing-frame, and Veo-motion prompts; it does not call Qwen or Veo, save project state, or bypass the creator's review. After review, the browser orchestrates each Qwen audio request and Veo video request through the Framehouse Node API. Veo clips are generated sequentially: the actual extracted final frame of one shot becomes the next shot's opening image. Framehouse calls the planner through authenticated Cloud Run service-to-service access. The planner uses Vertex AI Gemini through its Cloud Run service identity; no Gemini API key is needed for this service.

Create a least-privilege runtime identity and grant Vertex AI access:

```bash
export ADK_SERVICE="framehouse-adk-planner"
export ADK_SA="framehouse-adk-runtime"
gcloud iam service-accounts create "$ADK_SA" \
  --display-name="Framehouse ADK planner runtime"
export ADK_SA_EMAIL="${ADK_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${ADK_SA_EMAIL}" --role="roles/aiplatform.user"
```

Build and deploy from the repository root:

```bash
export ADK_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/framehouse/adk-planner:latest"
gcloud builds submit --tag "$ADK_IMAGE" ./adk_service
gcloud run deploy "$ADK_SERVICE" \
  --image "$ADK_IMAGE" --region "$REGION" \
  --service-account "$ADK_SA_EMAIL" \
  --cpu 2 --memory 2Gi --concurrency 4 --timeout 240 \
  --no-allow-unauthenticated \
  --set-env-vars="GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=global,ADK_MODEL_ID=gemini-3.7-flash"
```

Allow only the Framehouse API runtime identity to invoke the planner, then configure the web service:

```bash
gcloud run services add-iam-policy-binding "$ADK_SERVICE" \
  --region "$REGION" \
  --member="serviceAccount:${RUN_SA_EMAIL}" --role="roles/run.invoker"
export ADK_URL="$(gcloud run services describe "$ADK_SERVICE" \
  --region "$REGION" --format='value(status.url)')"
gcloud run services update "$RUN_SERVICE" --region "$REGION" \
  --update-env-vars="ADK_PLANNER_URL=${ADK_URL}"
```

The web API obtains a Cloud Run identity token for the planner's canonical service URL. Do not make the planner public. For local development, run the ADK service separately and set `ADK_PLANNER_URL=http://127.0.0.1:8081`; local auth is optional when the planner is on localhost.

The new `POST /api/production-plan` endpoint accepts a selected idea, confirmed facts, duration, and frame asset IDs/descriptions, and returns a plan proposal with `proposalId`, `baseProjectVersion`, and `inputHash`. It currently requires an even duration from 4–60 seconds so 4/6/8-second Veo clips can exactly cover the full timeline. This endpoint is synchronous planning, not the durable media-generation workflow. Do not treat an in-memory ADK session as saved project/job state.

Local planner setup:

```bash
cd adk_service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export GOOGLE_GENAI_USE_VERTEXAI=TRUE
export GOOGLE_CLOUD_PROJECT="your-project-id"
export GOOGLE_CLOUD_LOCATION="global"
uvicorn main:app --host 0.0.0.0 --port 8081
```

Then set `ADK_PLANNER_URL=http://127.0.0.1:8081` in the Framehouse `.env`. Authenticate locally with `gcloud auth application-default login`.

## 4. Build and deploy Framehouse

From this repository directory, build the image and deploy the web app/API:

```bash
export STUDIO_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/framehouse/studio:latest"
gcloud builds submit --tag "$STUDIO_IMAGE" .

gcloud run deploy "$RUN_SERVICE" \
  --image "$STUDIO_IMAGE" \
  --region "$REGION" \
  --service-account "$RUN_SA_EMAIL" \
  --memory 2Gi --cpu 2 --timeout 900 --concurrency 1 --max-instances 5 \
  --no-allow-unauthenticated \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},VERTEX_LOCATION=${VERTEX_REGION},VERTEX_MODEL_ID=veo-3.1-fast-generate-001,VERTEX_OUTPUT_URI=gs://${BUCKET}/framehouse/,QWEN_TTS_ENDPOINT=${QWEN_URL}"
```

The app defaults to `veo-3.1-fast-generate-001`; change `VERTEX_MODEL_ID` only to a model available to your project and region. The app supports 4-, 6-, or 8-second scenes and disables Veo audio because Qwen generates the narration. The conservative `--concurrency 1` setting limits overlapping FFmpeg exports and their temporary media buffers; raise it only after measuring memory use and request latency.

For a Qwen provider that needs a bearer token, save it in Secret Manager and grant the runtime identity `roles/secretmanager.secretAccessor` on that secret. Then bind it as `QWEN_TTS_TOKEN` with `--update-secrets="QWEN_TTS_TOKEN=SECRET_NAME:SECRET_VERSION"`. Do not pass secrets in `--set-env-vars` or bake them into the image. See [Cloud Run secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets).

### Access control

The app currently has no built-in user login. Deployment above keeps Cloud Run private, which means a normal browser cannot open it without an authenticated access layer. Grant `roles/run.invoker` to authorized callers and place an appropriate user authentication layer (for example, IAP or an application login) in front of the site for production. For a temporary demo, `--allow-unauthenticated` makes it publicly reachable, but anyone with the URL could trigger paid generation. Restrict access again after the demo.

### Keep large video assets out of the build upload

The current `Dockerfile` copies `f30881536.jpg` and `edge_samples/`, not the large `f30977280.mp4` file. Keep generated media out of the image build context and use Cloud Storage for production assets.

## 5. Verify

Get the URL and check service health:

```bash
export STUDIO_URL="$(gcloud run services describe "$RUN_SERVICE" \
  --region "$REGION" --format='value(status.url)')"
TOKEN="$(gcloud auth print-identity-token)"
curl -H "Authorization: Bearer ${TOKEN}" "${STUDIO_URL}/api/health"
```

The response should report `qwen: true` and `vertex: true` once their configuration is present. Test the single-scene path (generate Qwen audio, generate a Veo clip, then **Merge voiceover · Download MP4**). For a storyboard, generate every shot's audio/video in order, then use **Assemble shots + audio · Download MP4**; this calls `POST /api/export-segments` to concatenate the clips, mux each matching narration track, and optionally include a selectable Chinese subtitle track. If a Qwen clip outlasts its planned shot, assembly holds the Veo clip's final frame rather than cutting the narration.

The multi-shot export route accepts up to 15 shots and 120 seconds, with a maximum 120 MiB JSON request body. It uses the Cloud Run container's temporary disk and FFmpeg; the deployment above provisions 2 GiB memory and serializes requests per instance to reduce OOM risk. Monitor memory/latency before increasing concurrency. `/api/video`, `/api/export`, and `/api/export-segments` are **POST** routes and are not meant to be opened as browser GET URLs; a direct GET returns `API route not found`.

Inspect logs when needed:

```bash
gcloud run services logs read "$RUN_SERVICE" --region "$REGION" --limit 100
gcloud run services logs read framehouse-qwen --region "$REGION" --limit 100
```

## Operations and costs

- Veo generation polls a long-running operation for up to 12 minutes; Cloud Run's 900-second request timeout leaves time for processing and transfer.
- Add a Cloud Storage lifecycle policy for old generated clips. Monitor bucket growth.
- FFmpeg muxing/assembly uses temporary local files and buffers media in the Framehouse container. The multi-shot browser request contains base64 media; keep it below the 120 MiB API limit. Monitor memory and request duration, and increase concurrency/resources based on measured load.
- Configure budget alerts, Cloud Run maximum instances, and Vertex quotas. Budget alerts notify but do not cap spend.
- The Qwen GPU service can incur charges when active. Start with a low maximum instance count and confirm scale-to-zero behavior and cold-start time.

## Official references

- [Deploy containers to Cloud Run](https://docs.cloud.google.com/run/docs/deploying)
- [Deploy ADK agents to Cloud Run](https://google.github.io/adk-docs/deploy/cloud-run/)
- [ADK Python runner and session behavior](https://github.com/google/adk-python/blob/main/docs/guides/runners/runner/index.md)
- [Gemini 3.7 Flash on Google Cloud](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-7-flash)
- [Cloud Run service identity](https://docs.cloud.google.com/run/docs/configuring/services/service-identity)
- [Cloud Run GPU services](https://docs.cloud.google.com/run/docs/configuring/services/gpu)
- [Cloud Run secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets)
- [Veo 3.1 model guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate-preview)
- [Qwen3-TTS official repository](https://github.com/QwenLM/Qwen3-TTS)
