import hashlib
import json
import os
import re
import uuid
from functools import lru_cache
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from google.adk.apps import App
from google.adk.runners import InMemoryRunner
from google.genai import types

from production_agent import root_agent

APP_NAME = "framehouse_production_planner"
app = FastAPI(title="Framehouse ADK Planner", version="1.0.0")


class FrameAsset(BaseModel):
    assetId: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=500)


class PlanRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=160)
    baseProjectVersion: int = Field(ge=1)
    idea: str = Field(min_length=1, max_length=4000)
    brief: str = Field(default="", max_length=4000)
    facts: list[str] = Field(default_factory=list, max_length=40)
    platform: str = Field(default="rednote", max_length=40)
    language: str = Field(default="zh-CN", max_length=20)
    durationSeconds: int = Field(default=40, ge=4, le=60)
    frameAssets: list[FrameAsset] = Field(default_factory=list, max_length=24)
    voiceProfileId: str = Field(default="default", max_length=100)


def parse_json(value: Any, label: str) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        raise HTTPException(status_code=502, detail=f"{label} agent returned no JSON output.")
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", value.strip(), flags=re.IGNORECASE)
    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail=f"{label} agent returned invalid JSON.") from exc
    if not isinstance(result, dict):
        raise HTTPException(status_code=502, detail=f"{label} agent output must be a JSON object.")
    return result


def scene_windows(duration_seconds: int) -> list[dict[str, int]]:
    @lru_cache(maxsize=None)
    def partition(remaining: int) -> tuple[int, ...] | None:
        if remaining == 0:
            return ()
        for seconds in (8, 6, 4):
            if remaining >= seconds:
                tail = partition(remaining - seconds)
                if tail is not None:
                    return (seconds, *tail)
        return None

    lengths = partition(duration_seconds)
    if lengths is None:
        raise HTTPException(status_code=400, detail="Duration cannot be represented by supported Veo scene lengths.")
    windows = []
    start_ms = 0
    for index, seconds in enumerate(lengths):
        end_ms = start_ms + seconds * 1000
        windows.append({"index": index, "startMs": start_ms, "endMs": end_ms})
        start_ms = end_ms
    return windows


def validate_plan(plan: dict[str, Any], request: PlanRequest) -> None:
    script = plan.get("scriptPlan")
    scene_plan = plan.get("scenePlan")
    if not isinstance(script, dict) or not isinstance(scene_plan, dict):
        raise HTTPException(status_code=502, detail="Plan reviewer did not return scriptPlan and scenePlan.")
    blocks = script.get("transcriptBlocks")
    segments = scene_plan.get("segments")
    if not isinstance(blocks, list) or not blocks or not isinstance(segments, list) or not segments:
        raise HTTPException(status_code=502, detail="The generated plan is missing transcript blocks or scenes.")

    seen_block_ids: set[str] = set()
    block_ranges: dict[str, tuple[int, int]] = {}
    previous_end = 0
    for block in blocks:
        if not isinstance(block, dict):
            raise HTTPException(status_code=502, detail="Transcript block is malformed.")
        block_id = block.get("id")
        start, end = block.get("startMs"), block.get("endMs")
        if not isinstance(block_id, str) or block_id in seen_block_ids:
            raise HTTPException(status_code=502, detail="Transcript block IDs must be unique strings.")
        if not isinstance(start, int) or not isinstance(end, int) or start < previous_end or end <= start:
            raise HTTPException(status_code=502, detail="Transcript timing must be positive and ordered without overlap.")
        if end > request.durationSeconds * 1000:
            raise HTTPException(status_code=502, detail="Transcript timing exceeds the requested video duration.")
        if not isinstance(block.get("text"), str) or not block["text"].strip():
            raise HTTPException(status_code=502, detail="Transcript text cannot be empty.")
        seen_block_ids.add(block_id)
        block_ranges[block_id] = (start, end)
        previous_end = end

    supplied_assets = {item.assetId for item in request.frameAssets}
    transcript_coverage: set[str] = set()
    seen_segment_ids: set[str] = set()
    previous_end = 0
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            raise HTTPException(status_code=502, detail="Scene segment is malformed.")
        start, end = segment.get("startMs"), segment.get("endMs")
        if not isinstance(start, int) or not isinstance(end, int) or start != previous_end or end <= start:
            raise HTTPException(status_code=502, detail="Scene windows must cover the timeline contiguously without overlap.")
        if end - start not in (4000, 6000, 8000):
            raise HTTPException(status_code=502, detail="Veo scenes must be 4, 6, or 8 seconds long.")
        if segment.get("index") != index:
            raise HTTPException(status_code=502, detail="Scene indices must be contiguous and ordered.")
        segment_id = segment.get("id")
        if not isinstance(segment_id, str) or not segment_id or segment_id in seen_segment_ids:
            raise HTTPException(status_code=502, detail="Scene IDs must be unique non-empty strings.")
        seen_segment_ids.add(segment_id)
        for key in ("openingFrameAssetId", "closingFrameAssetId"):
            asset_id = segment.get(key)
            if asset_id is not None and (not isinstance(asset_id, str) or asset_id not in supplied_assets):
                raise HTTPException(status_code=502, detail=f"Scene references an unknown {key}.")
        ids = segment.get("transcriptBlockIds")
        if not isinstance(ids, list) or not ids or any(not isinstance(block_id, str) or block_id not in seen_block_ids for block_id in ids):
            raise HTTPException(status_code=502, detail="Scene references an unknown transcript block.")
        for block_id in ids:
            block_start, block_end = block_ranges[block_id]
            midpoint = (block_start + block_end) // 2
            if midpoint < start or midpoint >= end:
                raise HTTPException(status_code=502, detail="Map each complete transcript block to the single scene containing its midpoint.")
        transcript_coverage.update(ids)
        if not isinstance(segment.get("prompt"), str) or not segment["prompt"].strip():
            raise HTTPException(status_code=502, detail="Every scene requires a Veo prompt.")
        for key in ("openingFramePrompt", "closingFramePrompt"):
            if not isinstance(segment.get(key), str) or not segment[key].strip():
                raise HTTPException(status_code=502, detail=f"Every scene requires a {key}.")
        if index and segment["openingFramePrompt"] != segments[index - 1]["closingFramePrompt"]:
            raise HTTPException(status_code=502, detail="Adjacent scene frame prompts must share the same boundary composition.")
        previous_end = end

    if previous_end != request.durationSeconds * 1000:
        raise HTTPException(status_code=502, detail="Scene windows do not cover the requested duration exactly.")
    if transcript_coverage != seen_block_ids:
        raise HTTPException(status_code=502, detail="Every transcript block must be mapped to at least one scene.")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "framehouse-adk-planner", "model": os.getenv("ADK_MODEL_ID", "gemini-3.7-flash")}


@app.post("/v1/production-plan")
async def create_production_plan(request: PlanRequest) -> dict[str, Any]:
    if request.durationSeconds % 2:
        raise HTTPException(status_code=400, detail="Duration must be even so supported Veo scene lengths can cover it exactly.")

    request_payload = request.model_dump(mode="json")
    request_payload["requiredSceneWindowsMs"] = scene_windows(request.durationSeconds)
    request_json = json.dumps(request_payload, ensure_ascii=False, sort_keys=True)
    user_id = "project_" + re.sub(r"[^A-Za-z0-9_-]", "_", request.projectId)[:80]
    session_id = str(uuid.uuid4())
    runner = InMemoryRunner(app=App(name=APP_NAME, root_agent=root_agent))
    await runner.session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
        state={"request_json": request_json},
    )
    try:
        message = types.Content(role="user", parts=[types.Part.from_text(text=request_json)])
        async for _event in runner.run_async(user_id=user_id, session_id=session_id, new_message=message):
            pass
        session = await runner.session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="ADK planning workflow failed. Check the service logs for its request ID.") from exc

    if session is None:
        raise HTTPException(status_code=502, detail="ADK planning session could not be read after completion.")
    script = parse_json(session.state.get("script_plan_json"), "Transcript Planner")
    scene_plan = parse_json(session.state.get("scene_plan_json"), "Scene Planner")
    review = parse_json(session.state.get("review_json"), "Plan Reviewer")
    proposal = {
        "schemaVersion": 1,
        "proposalId": str(uuid.uuid4()),
        "projectId": request.projectId,
        "baseProjectVersion": request.baseProjectVersion,
        "inputHash": hashlib.sha256(request_json.encode("utf-8")).hexdigest(),
        "modelId": os.getenv("ADK_MODEL_ID", "gemini-3.7-flash"),
        "voiceProfileId": request.voiceProfileId,
        "durationSeconds": request.durationSeconds,
        "workflow": ["transcript_planner", "scene_planner", "plan_reviewer"],
        "scriptPlan": review.get("scriptPlan", script),
        "scenePlan": review.get("scenePlan", scene_plan),
        "warnings": (review.get("warnings", []) if isinstance(review.get("warnings", []), list) else [str(review["warnings"])])
        + (script.get("warnings", []) if isinstance(script.get("warnings", []), list) else [str(script["warnings"])]),
        "approvalRequired": True,
    }
    # Guarantee an identical planned image composition at every shot boundary.
    # During rendering, the browser also extracts the prior clip's actual final frame
    # and sends it as the next Veo request's firstFrame.
    scene_plan_value = proposal.get("scenePlan")
    segments = scene_plan_value.get("segments", []) if isinstance(scene_plan_value, dict) else []
    for index, segment in enumerate(segments if isinstance(segments, list) else []):
        if not isinstance(segment, dict):
            continue
        visual = str(segment.get("visualGoal") or segment.get("prompt") or "A natural listing-room composition").strip()
        segment.setdefault("openingFramePrompt", f"Photorealistic still frame of the same property and furniture. {visual}")
        segment.setdefault("closingFramePrompt", f"Photorealistic still frame at the end of this shot, maintaining the same property, furniture, materials, and lighting. {visual}")
        segment.setdefault("videoPrompt", segment.get("prompt", ""))
        if index:
            segment["openingFramePrompt"] = segments[index - 1]["closingFramePrompt"]
            segment["dependencySegmentId"] = segments[index - 1].get("id")
    for block in proposal["scriptPlan"]["transcriptBlocks"]:
        block.setdefault("timingSource", "estimated")
    validate_plan(proposal, request)
    return proposal
