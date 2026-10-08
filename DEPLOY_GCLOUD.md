# Deploy Framehouse to Google Cloud

This guide deploys the Framehouse web app/API on Cloud Run, uses Vertex AI Veo 3.1 to generate video, and calls a separately hosted Qwen3-TTS service for narration.

## Architecture

```text
Browser → Framehouse (Cloud Run) → Qwen3-TTS HTTP service
                              ├→ Vertex AI Veo 3.1
                              └→ Cloud Storage (temporary Veo output)
```

The Node app, website, `/api/tts`, `/api/video`, `/api/export`, and FFmpeg muxing are in this repository. Veo is a managed Vertex model, not a container you deploy. Qwen3-TTS is an open model and must run as a separate inference service. See the [official Qwen3-TTS repository](https://github.com/QwenLM/Qwen3-TTS) for model setup.

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

## 3. Build and deploy Framehouse

From this repository directory, build the image and deploy the web app/API:

```bash
export STUDIO_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/framehouse/studio:latest"
gcloud builds submit --tag "$STUDIO_IMAGE" .

gcloud run deploy "$RUN_SERVICE" \
  --image "$STUDIO_IMAGE" \
  --region "$REGION" \
  --service-account "$RUN_SA_EMAIL" \
  --memory 2Gi --cpu 2 --timeout 900 --concurrency 4 --max-instances 5 \
  --no-allow-unauthenticated \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},VERTEX_LOCATION=${VERTEX_REGION},VERTEX_MODEL_ID=veo-3.1-generate-001,VERTEX_OUTPUT_URI=gs://${BUCKET}/framehouse/,QWEN_TTS_ENDPOINT=${QWEN_URL}"
```

`veo-3.1-generate-001` is the model ID currently used by this app. To use Veo 3.1 Fast, verify your access/settings in the [Veo model guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate-preview), then set `VERTEX_MODEL_ID=veo-3.1-fast-generate-001`. The app supports 4-, 6-, or 8-second scenes and disables Veo audio because Qwen generates the narration.

For a Qwen provider that needs a bearer token, save it in Secret Manager and grant the runtime identity `roles/secretmanager.secretAccessor` on that secret. Then bind it as `QWEN_TTS_TOKEN` with `--update-secrets="QWEN_TTS_TOKEN=SECRET_NAME:SECRET_VERSION"`. Do not pass secrets in `--set-env-vars` or bake them into the image. See [Cloud Run secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets).

### Access control

The app currently has no built-in user login. Deployment above keeps Cloud Run private, which means a normal browser cannot open it without an authenticated access layer. Grant `roles/run.invoker` to authorized callers and place an appropriate user authentication layer (for example, IAP or an application login) in front of the site for production. For a temporary demo, `--allow-unauthenticated` makes it publicly reachable, but anyone with the URL could trigger paid generation. Restrict access again after the demo.

### Keep large video assets out of the build upload

The current `Dockerfile` copies `f30977280.mp4` even though the demo player uses `edge_samples/demo_listing_reel.mp4`. The unused file is about 46 MB. Before `gcloud builds submit`, change this Dockerfile line:

```dockerfile
COPY f30881536.jpg f30977280.mp4 ./
```

to:

```dockerfile
COPY f30881536.jpg ./
```

Do not exclude `f30977280.mp4` via `.gcloudignore` while the Dockerfile still copies it, or the image build will fail. The repository's `.gitignore` excludes this large file from Git already.

## 4. Verify

Get the URL and check service health:

```bash
export STUDIO_URL="$(gcloud run services describe "$RUN_SERVICE" \
  --region "$REGION" --format='value(status.url)')"
TOKEN="$(gcloud auth print-identity-token)"
curl -H "Authorization: Bearer ${TOKEN}" "${STUDIO_URL}/api/health"
```

The response should report `qwen: true` and `vertex: true` once their configuration is present. Test audio generation, Veo video generation from an opening frame, then MP4 export. Inspect logs when needed:

```bash
gcloud run services logs read "$RUN_SERVICE" --region "$REGION" --limit 100
gcloud run services logs read framehouse-qwen --region "$REGION" --limit 100
```

## Operations and costs

- Veo generation polls a long-running operation for up to 12 minutes; Cloud Run's 900-second request timeout leaves time for processing and transfer.
- Add a Cloud Storage lifecycle policy for old generated clips. Monitor bucket growth.
- FFmpeg muxing buffers media in the Framehouse container. Monitor memory and concurrency; increase resources based on measured load.
- Configure budget alerts, Cloud Run maximum instances, and Vertex quotas. Budget alerts notify but do not cap spend.
- The Qwen GPU service can incur charges when active. Start with a low maximum instance count and confirm scale-to-zero behavior and cold-start time.

## Official references

- [Deploy containers to Cloud Run](https://docs.cloud.google.com/run/docs/deploying)
- [Cloud Run service identity](https://docs.cloud.google.com/run/docs/configuring/services/service-identity)
- [Cloud Run GPU services](https://docs.cloud.google.com/run/docs/configuring/services/gpu)
- [Cloud Run secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets)
- [Veo 3.1 model guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate-preview)
- [Qwen3-TTS official repository](https://github.com/QwenLM/Qwen3-TTS)
