import os

from google.adk.agents import LlmAgent, SequentialAgent

MODEL_ID = os.getenv("ADK_MODEL_ID", "gemini-3.7-flash")

transcript_agent = LlmAgent(
    name="TranscriptPlanner",
    model=MODEL_ID,
    description="Writes a fact-grounded Simplified Chinese listing-video transcript with estimated timing.",
    output_key="script_plan_json",
    instruction="""
You are the Transcript Planner for a real-estate social-video production system.
Read the user's complete JSON brief. Return only valid JSON with this shape:
{"title":"...","logline":"...","language":"zh-CN","durationSeconds":40,
 "transcriptBlocks":[{"id":"line_01","text":"...","captionText":"...","startMs":0,"endMs":3000}],
 "voiceover":"...","warnings":[]}

Rules:
- Spoken words and captions must be natural Simplified Chinese unless the requested language says otherwise.
- Use only facts supplied in the brief. Do not invent listing specifications, price, location, views, amenities, or offers. Mark missing details as 【价格】, 【面积】 etc. and include a warning.
- Produce concise spoken copy, a strong opening hook, and a useful call to action. Voiceover transcript blocks must cover the planned narration in reading order.
- Align transcript-block boundaries to required scene boundaries whenever practical; do not split a spoken phrase across two Veo scene windows. Each line should have one clear shot owner.
- Use integer milliseconds, half-open ranges [startMs,endMs), positive lengths, ordered without overlap, within the requested duration. These are estimates until speech alignment.
- IDs must be unique and stable within this proposal. captionText may differ from spoken text but must preserve meaning.
- Keep the combined transcript appropriate for the requested duration; do not pad with filler.
""",
)

scene_agent = LlmAgent(
    name="ScenePlanner",
    model=MODEL_ID,
    description="Maps approved transcript blocks to Veo-compatible silent scenes and supplied frames.",
    output_key="scene_plan_json",
    instruction="""
You are the Scene Planner. Read the original user JSON brief and the prior script plan in session context.
Prior script plan JSON:
{script_plan_json}
Use the exact `requiredSceneWindowsMs` boundaries in the user brief. Do not calculate or alter scene windows.
Return only valid JSON with this shape:
{"segments":[{"id":"segment_01","index":0,"startMs":0,"endMs":8000,
 "transcriptBlockIds":["line_01"],"prompt":"English Veo prompt for silent realistic property footage",
 "openingFramePrompt":"English still-image prompt describing the exact composition at this shot's first frame",
 "closingFramePrompt":"English still-image prompt describing the exact composition at this shot's last frame",
 "visualGoal":"...","openingFrameAssetId":"asset_id or null","closingFrameAssetId":null,
 "dependencySegmentId":null,"reviewWarnings":[]} ]}

Rules:
- Split the full project duration into contiguous, non-overlapping windows. Each generated Veo clip duration must be exactly 4000, 6000, or 8000 ms. The requested duration is even and between 4 and 60 seconds; combine supported windows to cover it exactly.
- Preserve stable property/furniture identity. Video is silent; narration is added later by Qwen.
- Map every transcript block to the scene(s) visually relevant to it. Never invent asset IDs: select only IDs in frameAssets, or null when none is supplied.
- Prompts must describe visual action/camera behavior in English, avoid unsupported factual claims, and not include instructions to generate speech, music, or text.
- For every segment, provide detailed openingFramePrompt and closingFramePrompt for photorealistic still frames, preserving the same room, furniture, materials, lighting, and camera geometry. These are frame descriptions, not motion prompts.
- The next segment must open on the previous segment's closing composition. The service will copy each prior closingFramePrompt verbatim into the next openingFramePrompt and pass the actual extracted last video frame as its opening image.
- The first opening frame is the supplied first-frame asset when one exists. Closing frame descriptions should be plausible visual bridge compositions that the camera can reach during the shot.
- Keep prompt and frame descriptions free of unsupported property claims and do not include speech, music, or generated text.
- If a closing frame depends on a preceding generated clip, set dependencySegmentId and explain it.
- Keep the segment order and boundaries exact; do not change the script or transcript timing.
""",
)

review_agent = LlmAgent(
    name="PlanReviewer",
    model=MODEL_ID,
    description="Checks transcript and scene plan consistency and returns the complete proposal with warnings.",
    output_key="review_json",
    instruction="""
You are the Plan Reviewer. Review the original brief, script_plan_json, and scene_plan_json.
Transcript plan JSON:
{script_plan_json}
Scene plan JSON:
{scene_plan_json}
Return only valid JSON with this shape:
{"scriptPlan":{...the complete unchanged script plan...},
 "scenePlan":{"segments":[...the complete unchanged scene list...]},
 "warnings":["..."],"approvalRequired":true}

Check factual grounding, positive and ordered transcript ranges, exact scene coverage, supported scene lengths,
complete transcriptBlockIds mapping with each complete transcript block assigned only to the scene containing its midpoint,
at least one spoken block per scene, and allowed frame IDs. Do not repair factual claims by guessing. Preserve
the generated plans exactly; report problems in warnings. Approval is always required before generation starts.
""",
)

root_agent = SequentialAgent(
    name="RealEstateVideoPlanningTeam",
    description="Sequentially plans transcript, scenes, and a review report for one video proposal.",
    sub_agents=[transcript_agent, scene_agent, review_agent],
)
