# Multi-Agent Production Workflow — Design Proposal

Status: proposal for implementation planning. This document describes a target design, not features already present in the application. The current implementation baseline is summarized in [`PROJECT_ARCHITECTURE.md`](PROJECT_ARCHITECTURE.md).

## 1. Goal

Extend Video Agent from a one-scene demo into an editable, multi-scene video production workspace. A creator first selects a brainstormed idea; specialist agents then create a timed transcript, generate narration in a consistent voice, plan and render silent video scenes, and assemble a captioned final MP4. The creator can inspect and revise each segment and reassemble without regenerating unaffected work.

Example: a 40-second listing video is represented as five 8-second scenes. Each scene has a precise timeline range, one or more transcript blocks, a Qwen narration asset, a Veo prompt, opening/closing frame assets, and a generated silent video asset.

## 2. Design principles

1. **One canonical timeline.** Transcript, audio, video, captions, and edits refer to the same integer-millisecond project timeline. Do not let each provider invent its own unrelated timing.
2. **Agents propose; validators and the user decide.** LLM output is untrusted structured input. Validate schemas, durations, factual claims, frame references, and media constraints before execution.
3. **Stable IDs and immutable versions.** Every project, segment, transcript block, prompt revision, generated asset, and task has an ID/version. Never silently overwrite a previously accepted output.
4. **Regenerate only what changed.** A transcript edit should not automatically regenerate Veo unless visual direction depends on it; a prompt edit should not regenerate Qwen audio.
5. **Model work is asynchronous and resumable.** Persist jobs and outputs; do not hold one browser request open while multiple Veo clips render.
6. **Keep deterministic work out of LLM agents.** FFmpeg assembly, duration checks, file validation, and timeline math are ordinary services with tests, not model decisions.
7. **Respect user assets and rights.** Preserve which uploaded or generated frame each scene uses, and require appropriate consent/rights for cloned voices and likenesses.
8. **Use Hypit as an editor/runtime candidate, not as the agent orchestrator.** Keep planning, provider jobs, and project authorization in Video Agent; evaluate Hypit for composition/timeline editing and render handoff.

## 3. Proposed workflow

```text
Brainstorm results
       │ creator selects an idea and confirms the production brief
       ▼
Transcript & screenplay agent ──► timed transcript blocks
       │                                  │
       └──────────────┬───────────────────┘
                      ▼
               Video planning agent ──► segment plan + frame plan
                      │                         │
                ┌─────┴─────┐             ┌─────┴─────┐
                ▼           ▼             ▼           ▼
             Qwen audio   per-segment   Veo scene 1  Veo scene N
             generation   asset jobs       ...         ...
                └─────────────┬───────────────────────┘
                              ▼
                  timeline/media validation
                              ▼
          Hypit composition render (if approved) / FFmpeg fallback
                              ▼
                 preview → segment edits → reassemble
```

### Stage A — Select and freeze the brainstormed idea

The existing Ideas step supplies research, trends, and three ideas. The creator selects one, edits the brief/claims, confirms platform, desired total duration, voice profile, aspect ratio, and available photos. Store the selected idea as an immutable input snapshot (`IdeaSelection`); later model calls reference its ID/version rather than relying on browser state.

### Stage B — Generate timed transcript and screenplay

The Transcript Agent receives the selected idea, creator-provided facts, target platform, duration, presenter choice, and media inventory. It returns:

- a spoken transcript in the requested language and tone;
- an ordered list of phrase/utterance blocks, each with a stable ID and estimated `[startMs, endMs)`;
- a hook and beat structure (for example, hook by 3 seconds and a new point every 5 seconds);
- on-screen caption text per block (may default to the spoken text);
- optional presenter and screenplay directions;
- provenance for concrete claims (user brief/photo/source) and explicit placeholders for unknown prices, offers, warranties, or property facts.

The user reviews and edits the copy before production. Timing values are proposals until audio is rendered and measured. Validate that ranges are positive, ordered, non-overlapping unless explicitly allowed, and fit the requested duration. Avoid false precision: generated timing is not actual speech alignment.

### Stage C — Plan scenes and assign transcript ranges

The Video Planning Agent takes the approved transcript and the target duration. It divides the timeline into scene windows compatible with the configured Veo model. The initial product default is 8 seconds per scene; shorter 4- or 6-second scenes can be used where supported. It maps every transcript block to exactly one or more scene windows and supplies:

- `segmentId`, sequence index, and `[startMs, endMs)`;
- the transcript block IDs covered by the scene;
- one concise English Veo motion prompt, preserving property/furniture identity and listing facts;
- opening and closing frame asset IDs plus their provenance;
- continuity notes, shot intent, and review warnings.

For a 40-second project at 8 seconds per scene, the default boundaries are `[0,8000)`, `[8000,16000)`, `[16000,24000)`, `[24000,32000)`, `[32000,40000)`. A validator checks there are no gaps/overlaps, that the total matches the plan, and that each window uses a model-supported duration.

The planner should choose frames from creator uploads or approved keyframes. Do not let an LLM fabricate an asset ID. If a later scene uses the preceding Veo clip's extracted final frame, make that dependency explicit: generation becomes sequential at that boundary. If each scene already has an approved opening/closing keyframe, independent scene generation may run in parallel. Reusing a still as the next clip's first frame is a continuity aid, not a guarantee of seamless motion.

### Stage D — Generate audio consistently by transcript range

Generate a separate narration asset for each scene's ordered transcript range (or an explicitly grouped range), so an edit can regenerate only affected audio. Every job in the project uses one immutable `VoiceProfile`:

- voice reference audio asset and, when supported by the serving adapter, cached speaker/clone prompt embedding;
- fixed voice ID, language, voice instruction, model/version, and generation settings;
- consistent normalization/loudness target and sample format.

The Qwen service must accept the same reference/voice conditioning for every segment. Reusing only a string such as `"Xiaoyi"` is not proof of voice consistency; verify the Qwen adapter's actual voice-cloning behavior. Keep the reference sample and any extracted embedding private and access-controlled.

After synthesis, measure each audio duration. Use forced alignment or reliable speech timestamps to map transcript blocks to actual audio offsets. If exact alignment is unavailable in the first release, show estimated timings and label them as estimates. Do not silently stretch speech aggressively to force a fit. A small, bounded tempo adjustment may be offered with a visible warning; otherwise adjust the scene timeline and re-run timeline validation.

### Stage E — Generate silent Veo segments

Create one Veo job per planned scene using its prompt, opening frame, optional closing frame, aspect ratio, and supported duration. Disable Veo audio for all segments. Keep Qwen narration as the single authoritative voice track.

For each job, persist the provider operation ID, request snapshot, selected frame IDs, model ID, status, output asset ID, elapsed time, and any provider error. Extract a poster and (where required for continuity) the final frame from the returned clip. Validate playable media, video dimensions, duration, and frame rate before marking the scene ready.

### Stage F — Review and deterministic composition/render

When the required scene/audio assets exist, materialize the approved timeline into Hypit for editing/rendering if its integration and license gates pass; otherwise use the native/FFmpeg assembly service. The render path should remain deterministic for a fixed edit revision. It should:

1. order scenes by timeline sequence and normalize codec, frame rate, dimensions, and aspect ratio;
2. trim/pad only according to the accepted timeline policy, then concatenate scenes in order;
3. place each narration clip at its timeline offset, joining clips with controlled silence/fades if needed and mixing to one narration track;
4. render on-screen captions from the same timed transcript blocks, positioned within platform-safe lower margins;
5. optionally include a selectable subtitle track in addition to burned-in captions;
6. set final duration from the approved audio/timeline policy, encode MP4 (H.264/AAC), and validate the output;
7. save a new `ExportVersion` and return a preview/download URL.

The current exporter has one scene/audio pair and uses approximate transcript-based subtitle chunks. The multi-segment design needs a proper multi-input timeline renderer; do not extend the current endpoint by passing a giant base64 JSON object for the entire project.

## 4. Agent responsibilities and contracts

Agents should be narrow, stateless workers that receive a versioned input snapshot and return validated structured output. An Orchestrator owns workflow state, persistence, authorization, retries, and dispatch. Agents do not call each other directly or mutate shared project records.

| Worker | Input | Output | Must not do |
|---|---|---|---|
| Brainstorm/Research Agent (existing `/api/ideas`) | brief, platform, permitted photos, optional draft | materials review, sourced trends, selectable idea candidates | claim a trend without source/provenance; generate media |
| Transcript/Screenplay Agent | selected idea, creator facts, target duration/language/presenter, media inventory | timed transcript blocks, hook/beats, captions, screenplay, motion hints | invent factual listing details; choose unprovided asset IDs |
| Video Planning Agent | approved transcript timeline, total duration, frame inventory, model constraints | scene windows, transcript mapping, prompts, frame assignments, dependency graph | render video; silently change approved copy or timing |
| Audio Generation Worker (Qwen adapter) | transcript range, immutable voice profile, settings | audio asset, measured duration, alignment metadata, provider metadata | choose a different voice per segment or alter transcript without returning the change |
| Video Generation Worker (Veo adapter) | scene plan, approved frames, Veo settings | silent video asset, poster/final frame, dimensions/duration, operation metadata | generate narration; change neighboring segments |
| Composition/Assembly + QC Worker | approved timeline and immutable audio/video/caption versions | final MP4, QC report, export metadata | invent editorial content; overwrite source assets |

“Agent” does not require a free-running multi-agent framework. The initial implementation can use typed Gemini calls for planning and ordinary Cloud Run workers for media generation; add agent autonomy only when a measurable use case requires it.

## 5. Canonical project/timeline data model

Persist normalized project metadata separately from binary assets. Use integer milliseconds and half-open ranges `[startMs, endMs)` everywhere. IDs are stable UUIDs; every generated or edited object carries a version and input hash.

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "project_…",
    "version": 12,
    "selectedIdeaId": "idea_…",
    "language": "zh-CN",
    "platform": "rednote",
    "durationMs": 40000,
    "aspectRatio": "9:16",
    "voiceProfileId": "voice_…"
  },
  "transcriptBlocks": [
    {
      "id": "line_…",
      "text": "口播文案片段",
      "captionText": "画面字幕",
      "startMs": 0,
      "endMs": 3200,
      "timingSource": "forced_alignment",
      "version": 2
    }
  ],
  "segments": [
    {
      "id": "segment_01",
      "index": 0,
      "startMs": 0,
      "endMs": 8000,
      "transcriptBlockIds": ["line_…"],
      "prompt": "Slow camera push toward the living room…",
      "openingFrameAssetId": "asset_…",
      "closingFrameAssetId": "asset_…",
      "audioAssetId": "asset_…",
      "videoAssetId": "asset_…",
      "status": "review_ready",
      "version": 3
    }
  ]
}
```

This is illustrative, not a final database schema. Keep provider payloads and large base64 media out of the project record. Store assets in private object storage and reference them by ID, checksum, MIME type, dimensions, duration, owner, and retention metadata.

## 6. UI proposal

Keep the existing staged workflow, but make the production/review stage a storyboard editor:

- **Project header:** selected idea, target platform, duration, aspect ratio, voice profile, save/version state.
- **Timeline rail:** total duration with transcript/caption blocks and scene boundaries on one shared ruler; indicate gaps, overflow, and unaligned audio.
- **Segment list/cards:** one card per scene with sequence/time range, video preview/poster, transcript editor, audio player/waveform, Veo prompt, opening/closing frame thumbnails, generation state, and per-asset regenerate buttons.
- **Segment details:** edit spoken text and captions separately; audition audio; scrub/loop the scene; replace/select frames; edit motion prompt; inspect generation/version history.
- **Run controls:** generate all missing assets, generate selected segment, pause/cancel supported tasks, retry failed tasks, assemble/reassemble final video.
- **Final review:** synchronized preview, caption-safe-area preview, caption toggle/style controls, export options, QC warnings, and download.
- **Unsaved/dependency indicators:** show which downstream items became stale after an edit and why, with explicit regenerate action.

Editing rules:

| Change | Mark stale | Keep valid |
|---|---|---|
| One transcript block's text | Its scene audio, caption timing, final assembly; transcript-dependent prompt only if prompt includes that content | Unrelated scene video/audio and approved idea |
| Voice profile/reference | All audio clips and final assembly | Transcript, scene plan, Veo videos |
| One scene's motion prompt | That scene video and final assembly | Transcript, audio, other scene videos |
| Opening/closing keyframe | That scene video; adjacent scene video if the shared boundary frame changed | Transcript/audio, unrelated scenes |
| Scene order/duration | Timeline validation, affected audio placement, scene plan, captions, assembly; likely affected Veo generations | Brainstorm idea and unrelated source uploads |
| Caption text/style only | Caption render and final assembly | Speech audio and Veo clips |

Never delete an old accepted version when an edit invalidates it. Keep it available as a rollback/version option until retention rules expire it.

## 7. Hypit-powered segment editor proposal

### Recommended role

Evaluate [Hypit](https://github.com/hypit-ai/hypit) as the **video segment editing and composition surface** after Video Agent's transcript, audio, and silent Veo assets are ready. Hypit describes an editable video source, timeline-aware Studio, reusable components, captions, and render/build outputs. Its word-anchored timing and component-owned edit controls are relevant to transcript-to-caption mapping and per-segment adjustment. See the [Studio overview](https://hypit.ai/quickstart/preview/), [Studio Companion contract](https://github.com/hypit-ai/hypit/blob/main/packages/studio-adapter/README.md), and [package architecture](https://github.com/hypit-ai/hypit/blob/main/docs/guide/packages.md).

Hypit is **not** a drop-in React timeline widget or a replacement for the planning/audio/video agents. Its Studio is a browser editor for a Hypit project opened by its runtime/CLI. The project needs a Video Agent ↔ Hypit adapter, and whether Studio can be embedded or should open as a linked editing surface must be proven in a prototype. Do not couple the existing UI to Hypit's internal DOM or undocumented endpoints.

### Proposed responsibility boundary

| Concern | System of record / owner |
|---|---|
| User, workspace, selected brainstorm idea, approved facts, provider jobs and credentials | Video Agent backend |
| Transcript block IDs/text and alignment results; voice profile; Qwen audio versions; Veo prompts/jobs/source frames/video versions | Video Agent backend and private asset storage |
| Scene arrangement, visual track/layer layout, caption presentation, transition/overlay parameters, preview and composition render | Hypit project Source/Studio, subject to the bridge below |
| Final accepted timeline snapshot and export lineage | A Video Agent `EditRevision` created from a validated Hypit save/build manifest |

Use Hypit as the editing/rendering system for accepted assets, while Video Agent remains the agent/job system. Do not invoke Qwen or Veo from Hypit in the first integration slice: the existing agent pipeline generates these assets and hands immutable asset references to the editor. Provider integration through Hypit packages can be evaluated later if it offers a concrete advantage.

### Asset and edit handoff

1. After Video Agent planning and generation, materialize a Hypit project bundle from one immutable Video Agent project version: Hypit Source/Run files, a manifest mapping stable Video Agent IDs to Hypit items, and authorized scene/audio/frame/caption assets.
2. Represent each scene as an editable visual item with its `segmentId`, planned `[startMs, endMs)` window, source video asset, poster, and transition/continuity properties. Represent narration and transcript/caption cues on semantically linked audio/text tracks; retain transcript-block IDs so caption or timing changes can be traced to the agent plan.
3. Open the bundle in Hypit Studio. The user reviews the whole timeline and edits scene order/placement, trims, captions, and supported presentation controls. Use Hypit Studio Companions for component-specific labels, previews, and Inspector fields rather than hand-editing Hypit internals.
4. On save/build, export a versioned edit manifest containing the Hypit project/source revision, base Video Agent project version, stable segment/transcript IDs, accepted timing and presentation settings, output asset references, and validation results.
5. Video Agent validates the manifest and commits an immutable `EditRevision`. If an edit changes speech wording or audio timing, mark the affected Qwen asset and captions stale and ask the audio/timing workers to refresh them. Visual-only changes must not invalidate narration. Unsupported or unmapped Hypit changes remain in the Hypit revision and must not silently rewrite the agent data model.
6. Render the composition through one chosen renderer for that revision. During the pilot, compare Hypit's MP4 against the current FFmpeg assembly using the same approved media; production must have one authoritative export path to avoid divergent captions, timing, or codecs.

The bridge manifest is the important seam. Use stable IDs, versioned schemas, checksums, and explicit mappings; never infer correspondence from filenames, array order, or matching timestamps alone. Stage assets through private Cloud Storage references rather than embedding large base64 clips in Hypit Source.

### UI composition

The existing Video Agent pages remain responsible for ideas, transcript approval, voice profile, generation progress, and provider errors. Once required segment assets are ready, show an **Edit segments** action that opens the Hypit Studio revision for the selected project. When an embedded/hosted integration is proven, display Studio as a workspace panel; otherwise open the supported Studio URL in a dedicated tab and provide a return-to-project handoff.

Keep a Video Agent segment overview adjacent to the editor: five scene cards for a 40-second example, each showing time range, transcript excerpt, Qwen audio status, Veo preview/status, and current accepted version. Selecting a card should select the corresponding Hypit timeline entity where the supported integration permits it. Per-segment actions (“regenerate audio”, “regenerate video”, “edit prompt”) remain Video Agent actions; Hypit handles timeline/composition edits. After regeneration, import the new asset as a new Hypit item version and preserve the old cut for rollback.

Do not promise a one-click round trip until the adapter supports and tests the required edits: timeline trim/move, scene reorder, transcript/caption text, frame replacement, and version restore. A first pilot may be read-only for agent-owned transcript/audio values while Hypit edits visual arrangement and caption styling.

### License gate

Hypit's published [license](https://github.com/hypit-ai/hypit/blob/main/LICENSE) is a modified Apache 2.0 license. It permits use for an organization's own work, including commercial work, but restricts operating a multi-tenant service for third parties or commercially redistributing Hypit/derivative work without a commercial license. Because Video Agent is intended for multiple house agents, **obtain written commercial authorization before including Hypit in the hosted product or distributing a derivative**. Until that is resolved, the design is conditional: prototype only in an allowed single-organization environment, or implement a native segment editor using timeline/Companion concepts without copying Hypit code. This is an engineering risk flag, not legal advice.

### Hypit pilot acceptance criteria

- Build a 40-second/five-scene composition from Video Agent assets; scene IDs, transcript block IDs, time windows, and asset checksums survive export/import exactly.
- Confirm the five 8-second scenes remain silent while Qwen narration and captions follow the approved audio timeline.
- Edit one scene's trim/presentation and a caption; confirm no unrelated Qwen or Veo job is rerun.
- Replace one generated scene with a new Veo version; confirm rollback to the prior version works.
- Export an MP4 with synchronized narration, bottom-safe burned captions, optional selectable subtitles, and requested aspect ratio; compare timing and quality with the current FFmpeg exporter.
- Prove safe project isolation, authenticated asset access, a supported Cloud Run-compatible rendering/runtime boundary (or a documented separate editor runtime), and acceptable cold-start/render time.
- Clear license approval for the actual deployment/distribution model before production integration.

## 8. ADK-based agent layer and Google Cloud deployment plan

### Recommendation and scope

Use Google's Agent Development Kit (ADK) for the **bounded reasoning and planning layer**, deployed as a Python service on Cloud Run. It is a good fit because the project already uses Gemini and targets Google Cloud, and ADK has a documented Cloud Run deployment path. ADK is not the durable workflow engine, project database, media store, or provider runtime. Keep those responsibilities in explicit application services so a long Veo/Qwen job can survive request termination, deployment, retry, and user navigation.

The desired split is:

```text
Browser / existing Node.js app
        │ authenticated project API; job IDs and status
        ▼
Node API + durable workflow coordinator ───── Project DB
        │                                      Cloud Storage (assets)
        ├──► ADK planning service (Cloud Run, Python)
        │      Gemini agents: brainstorm → transcript → scene plan → plan review
        │      returns schema-validated proposals; no direct media mutation
        ├──► Qwen TTS worker/service (separate endpoint; GPU as needed)
        ├──► Veo generation worker (Vertex AI async operations)
        ├──► Hypit adapter/editor (conditional on license and runtime prototype)
        └──► FFmpeg assembly/QC job (Cloud Run Job or suitable worker)
                  ▲
             durable queue/workflow; persisted task state, retries, dependencies
```

The current Node.js app can remain the user-facing API and gradually delegate only planning endpoints to ADK. A later migration of the API is optional; introducing ADK does not require rewriting the frontend or existing provider adapters. Google documents ADK deployment to Cloud Run and separately recommends choosing among Cloud Run services, worker pools, and jobs according to the workload; use those as runtime options, not as substitutes for persisted workflow state. See [Deploy an ADK agent to Cloud Run](https://docs.cloud.google.com/run/docs/ai/build-and-deploy-ai-agents/deploy-adk-agent?hl=en) and [Cloud Run AI agents](https://docs.cloud.google.com/run/docs/ai-agents).

### ADK agent topology

Start with one ADK app/root agent that exposes a small sequential planning workflow and typed tools. Keep specialist roles as focused sub-agents or clearly separated agent instructions/functions; do not create an agent for every API call. The model may propose content, but tools and application code enforce permissions, schema, timeline, spend, and state transitions.

| ADK role | Inputs | Output / allowed tools | Boundary |
|---|---|---|---|
| Idea planner (optional first migration of `/api/ideas`) | Brief, platform, user-supplied facts and authorized image descriptions | Idea candidates and source/provenance records; approved research/search tool if enabled | Cannot invent listing facts, access arbitrary URLs, or launch paid media jobs |
| Transcript planner | Frozen selected idea, confirmed facts, language, target duration, voice/presenter constraints | Versioned `ScriptPlan` and estimated transcript blocks; schema/timing validation tool | Cannot change selected facts or write project state directly |
| Scene planner | Approved script version, asset inventory, Veo duration/ratio constraints | Versioned scene plan, transcript-to-scene map, prompts, frame references, dependency graph | Asset IDs must come from supplied inventory; cannot call Veo |
| Plan reviewer / critic | Candidate plan plus validation findings | Specific warnings or bounded repair proposal | Cannot silently approve its own plan; creator approval remains explicit |

For v1, run the planning stages sequentially with explicit review checkpoints. Parallelize only independent work after the plan is approved: Qwen audio for independent scenes, and Veo scenes whose opening/closing frames are already fixed. If a scene depends on a previous generated end frame, represent that as a workflow dependency rather than asking the ADK agent to poll or wait for it.

### Tool and API contracts

ADK tools should be narrow, typed, and side-effect-aware. Prefer read-only tools for asset inventory and project snapshots. Any mutation-like operation should either create a proposal/version or submit a durable job through the coordinator after authorization; it must not mutate an accepted version in place.

- `get_project_snapshot(project_id, version)` returns only the caller-authorized, immutable planning inputs.
- `list_eligible_assets(project_id)` returns stable IDs and metadata, never storage credentials or broad bucket listings.
- `validate_script_plan(plan)` and `validate_scene_plan(plan)` run deterministic schema, duration, coverage, frame-reference, and policy checks.
- `save_plan_proposal(project_id, base_version, plan)` creates a draft proposal with an input hash; it does not mark it accepted.
- `accept_plan(project_id, proposal_id, expected_version)` is an application/API action requiring the user's approval and optimistic concurrency check.
- `enqueue_generation(project_id, accepted_plan_version, segment_ids)` creates idempotent Qwen/Veo tasks in the durable workflow system; it does not synchronously wait for media output.

The ADK response contract should include `schemaVersion`, `projectId`, `baseProjectVersion`, `inputHash`, `proposalId`, structured payload, warnings, and model/prompt version metadata. Validate every response server-side even if the agent used a schema-constrained generation mode. Reject stale proposals when the project version changed during generation. Never expose provider credentials, unrestricted shell/code execution, raw Cloud Storage write access, or arbitrary network fetch as agent tools.

### State, sessions, and long-running work

Treat ADK session/context as conversational convenience only. Canonical project state, accepted versions, job status, cancellation, retries, and output asset references belong in the application database and object storage. Do not rely on an ADK session or an open HTTP request to resume Veo generation or FFmpeg rendering.

The coordinator should persist a workflow instance and task records with stable IDs, input hashes, attempt count, lease/heartbeat, provider operation ID, timestamps, output asset IDs, and structured error class. Use a durable queue/workflow service to dispatch work. Cloud Tasks is suitable for controlled HTTP task dispatch; Pub/Sub is suitable for event/fan-out patterns; Cloud Workflows can coordinate service calls and waits. Select after checking current service limits and cancellation/visibility needs. Whichever is chosen, persist authoritative state in the project store and make handlers idempotent; queue delivery alone is not the source of truth.

Suggested task graph:

```text
approved ScriptPlan + ScenePlan
       ├── Qwen audio tasks (one per scene or configured transcript range) ──┐
       └── Veo silent-video tasks (respect frame dependencies) ─────────────┤
                                                                          ▼
                                                               readiness + QC gate
                                                                          ▼
                                                           Hypit edit handoff / render
                                                                          ▼
                                                            FFmpeg fallback/export
```

Veo's long-running operation ID and Qwen request ID must be recoverable from persisted tasks. Polling or provider callbacks update the task record; the browser polls/subscribes to the app's job status, not the provider directly. Retry only transient failures with bounded backoff; do not automatically retry safety rejections, invalid inputs, or permission failures. A retry with identical input should either return the existing successful output or safely create a new attempt, never duplicate an accepted asset silently.

### Cloud Run service layout

Recommended initial deployment boundaries:

1. **Web/API (existing Node.js Cloud Run service):** serves the UI, authenticates/authorizes project operations, issues upload URLs, creates proposals/jobs, and exposes status. Keep it responsive; return `202` plus project/job IDs for long work.
2. **ADK planner (Python Cloud Run service):** private ingress or authenticated service-to-service access; handles bounded Gemini planning requests and returns structured proposals. Set request timeouts and concurrency appropriate to model latency. Do not put large media bodies in prompts; pass authorized asset metadata/references and use image input only when needed.
3. **Provider workers:** Qwen remains a separately scalable endpoint, potentially GPU-backed; Veo uses Vertex AI operations and Cloud Storage output; workers persist operation IDs and report status. Keep provider adapters behind stable internal contracts.
4. **Assembly/QC:** run FFmpeg in a Cloud Run Job for run-to-completion exports, or a dedicated worker if progress/cancellation semantics require it. Fetch only the project's authorized assets and write a new export version to private Cloud Storage.
5. **Data and secrets:** private Cloud Storage for uploads and generated media; a transactional database for projects, timeline revisions, jobs, and ownership; Secret Manager for secrets; service accounts with least privilege. Use signed/resumable uploads rather than large base64 payloads through the API.

Cloud Run services are stateless between requests, so use database/object storage for all durable state. Apply service-to-service authentication between the Node API, ADK service, and private workers; keep the ADK endpoint inaccessible to unauthenticated public callers. Use separate runtime identities and least-privilege access to Vertex, buckets, and secrets. Establish per-user/project quotas and cost controls before enabling public generation.

### Operational and quality requirements

- Pin ADK and model/client dependencies; record framework, model ID, prompt template version, and tool schema version on each proposal.
- Put explicit timeouts and output-token limits on planning calls. Use bounded repair loops (for example, one schema repair), then return validation errors for user correction rather than looping indefinitely.
- Add evaluation fixtures for Chinese listing scripts, timing/scene coverage, grounded property claims, and Veo prompt quality. Run deterministic validators separately from model-based evaluations.
- Trace by `projectId`, `workflowId`, `taskId`, and provider operation ID. Redact transcript/audio sample contents and secrets from logs.
- Track cost and latency per planning call and per generated segment; add concurrency limits and cancellation semantics.
- Keep human approval between brainstorm selection, script acceptance, scene-plan acceptance, and final export. A later autopilot mode can be an explicit user setting with the same validators and spend limits.
- Maintain a provider-neutral internal contract so a future switch from ADK to another orchestration library does not change project records or generation workers.

### Implementation sequence

1. **Define contracts first:** introduce versioned JSON schemas and deterministic validators for `ScriptPlan`, `ScenePlan`, and ADK tool inputs/outputs; add fixture-based tests.
2. **Add persistence and job IDs:** create project/version/task records and private asset references before introducing asynchronous providers. Migrate browser-local drafts carefully; keep current demo path functional.
3. **Prototype ADK privately:** implement transcript and scene planning in a small Python ADK service on Cloud Run; call it from the existing Node API using authenticated service identity. Compare outputs against current `/api/script` behavior and require user review.
4. **Move generation to durable tasks:** make Qwen/Veo handlers idempotent, persist provider operation IDs, return job IDs immediately, and expose per-segment status.
5. **Add assembly and editor handoff:** run export as a durable job; keep Hypit behind its adapter and license/runtime gates already described in Section 7.
6. **Evaluate before expanding agents:** measure planning quality, retries, latency, and cost. Add separate agents or parallel planning only where evaluations show a benefit.

## 9. Orchestration, persistence, and job state

The following summarizes the durable backend boundary around the ADK planning service (detailed above):

```text
Browser ─► authenticated API/orchestrator ─► project DB + object storage
                        │
                        ├─► ADK planning service (Gemini; proposal only)
                        ├─► audio jobs (Qwen)
                        ├─► scene jobs (Veo)
                        ├─► Hypit project/manifest adapter
                        │       └─► Hypit Studio + composition renderer (conditional)
                        └─► assembly/QC job (FFmpeg fallback / pilot comparator)
       ◄── job status/events or polling ─────┘
```

Use a durable project store (relational database is a good fit for ordered timelines, ownership, versions, and job dependencies) and private Cloud Storage for source/generated files. Dispatch long-running work through a durable queue/workflow mechanism. Each job should be idempotent using a hash of its input version, support bounded retries, and write a new immutable output version. Report progress at job and segment level to the UI. Verify current Cloud Run/Vertex service limits during implementation; this proposal intentionally does not bind the design to one queue product. If Hypit is approved, run it behind a narrow adapter/runtime boundary with per-project workspace isolation; do not let Studio bypass Video Agent ownership or asset authorization.

Suggested project state machine:

```text
IDEA_SELECTED → SCRIPT_REVIEW → PLAN_REVIEW → GENERATING
     → SEGMENT_REVIEW → ASSEMBLING → EXPORT_READY
                          ↘ FAILED / CANCELLED (retryable per task)
```

Each segment has its own state (`planned`, `audio_queued`, `audio_ready`, `video_queued`, `video_ready`, `review_ready`, `failed`, `stale`). Project state is derived from child states and accepted versions, not set optimistically by the browser.

## 10. Failure handling and quality gates

- Validate model JSON against a versioned schema; reject missing IDs/ranges and unknown frame references.
- Check scene durations against model-supported lengths; confirm the partition exactly covers the requested timeline.
- Cap and validate media size/type/dimensions before upload and again in workers.
- Preserve partial successes. A failed scene should not discard completed narration or other scenes.
- Distinguish provider errors (quota, safety filter, timeout, permission) from invalid plan data and user cancellation; show actionable, non-secret error details.
- Validate every generated asset before marking complete: decodable, expected codec/container, expected aspect/dimensions, duration within tolerance, non-empty audio, and readable object permissions.
- Run final QC for total duration, audio/video drift, clipping/black frames, missing captions, scene boundary discontinuities, and platform-safe text placement.
- Keep logs free of raw voice samples, complete transcripts, credentials, and unnecessary personal data. Use request/job IDs and asset IDs for correlation.

## 11. Rollout plan

### Phase 0 — Product/schema and Hypit feasibility prototype

Define the timeline schema and provider contracts; implement a local mocked workflow with deterministic fixture assets. In a separate Hypit project, test importing a 40s/five-scene composition, editing/export, the bridge manifest, deployment/runtime boundary, and license fit. Validate timing edits, stale-state handling, and reassembly before paying for model runs. If licensing or runtime integration fails, retain the adapter seam and build a native editor instead.

### Phase 1 — Sequential generation and editor handoff

Use one selected idea → timed transcript → five 8s scenes → consistent Qwen audio → silent Veo scenes → Hypit editing/render if approved (otherwise FFmpeg/native editor). Start with one project at a time and one active generation per segment. Persist project/job metadata and assets; support retry, revision handoff, and export.

### Phase 2 — Segment editing/version history

Add per-segment edit/regenerate, accepted version selection, dependency invalidation, parallel rendering for independent scenes, and resumable job progress.

### Phase 3 — Quality and scale

Add forced alignment, audio normalization, richer transitions, concurrency/cost controls, authentication/tenant isolation, observability, and more aspect-ratio/platform templates.

## 12. Decisions to resolve before implementation

1. Is the generated transcript always Simplified Chinese, or should language be a project-level choice?
2. Should Qwen synthesize one audio file per scene (more natural prosody) or per transcript block (more granular edits)? Recommended first release: one file per scene, while retaining phrase-level transcript/alignment metadata.
3. Is Hypit licensing compatible with the planned hosted multi-tenant product, and is written commercial permission available?
4. Can Hypit Studio fit the intended deployment UX, or should it be a separate linked editing surface?
5. Which system owns final timeline edits: Video Agent's canonical timeline, Hypit Source, or a versioned bridge snapshot? Recommended: Video Agent owns project/jobs/assets; Hypit owns the editor composition; a validated `EditRevision` joins them.
6. Is voice cloning from the Xiaoyi sample authorized for production, and where should reference audio/embeddings be stored?
7. Which alignment mechanism is acceptable for v1: forced alignment, provider timestamps, or estimated timing visibly labeled as approximate?
8. Should captions be burned into the pixels, included as a selectable subtitle track, or both? Recommended: both, with burned captions on by default for social publishing.
9. Which frame policy should v1 use between scenes: supplied per-scene keyframes, user-selected uploaded photos, extracted prior end frame, or a combination?
10. How should total runtime respond when actual synthesized speech exceeds the planned duration: adjust scene timing, change narration pace, or revise copy? Recommended: flag and ask for a choice; never truncate silently.
11. What maximum total duration, file size, generation concurrency, retention period, and monthly spend should the product enforce?
