const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let savedDraft = null;
try { savedDraft = JSON.parse(localStorage.getItem("framehouse-draft") || "null"); } catch {}
if (savedDraft?.transcript) $("#transcript").value = savedDraft.transcript;
if (savedDraft?.videoPrompt) $("#videoPrompt").value = savedDraft.videoPrompt;

const state = {
  api: { qwen: false, vertex: false, demo: true },
  audioBlob: null,
  audioUrl: null,
  audioReady: false,
  videoBlob: null,
  videoUrl: null,
  firstFrame: null,
  lastFrame: null,
  selectedVoice: "Xiaoyi",
  currentStep: "audio",
  originalScript: $("#transcript").value.trim(),
  isDemoVideo: true,
};

const transcript = $("#transcript");
const voiceAudio = $("#voiceAudio");
const previewVideo = $("#previewVideo");
const toast = $("#toast");
let toastTimer;

function showToast(message) {
  $("#toastMessage").textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function feedback(id, message, type = "success") {
  const node = $(id);
  node.textContent = message;
  node.classList.toggle("error", type === "error");
  node.hidden = false;
}

function clearFeedback(id) {
  $(id).hidden = true;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.dataset.originalLabel ||= button.innerHTML;
  button.innerHTML = busy ? `<span class="busy-dot"></span>${label}` : button.dataset.originalLabel;
}

function secondsLabel(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function updateTranscript() {
  $("#charCount").textContent = `${transcript.value.length.toLocaleString()} / 1,200`;
  if (transcript.value.trim() !== state.originalScript) {
    state.audioReady = false;
    $("#audioNote").innerHTML = '<span class="note-icon">i</span> Transcript changed. Generate a fresh voiceover before creating the scene.';
    $("#previewState").textContent = "VOICEOVER NEEDED";
  }
  $("#saveLabel").textContent = "Unsaved changes";
}

function saveDraft() {
  const draft = {
    transcript: transcript.value,
    videoPrompt: $("#videoPrompt").value,
    voice: state.selectedVoice,
    aspectRatio: $("#aspectRatio").value,
    duration: $("#sceneDuration").value,
    platform: $("#platformButton").childNodes[0].textContent.trim(),
  };
  try {
    localStorage.setItem("framehouse-draft", JSON.stringify(draft));
    $("#saveLabel").textContent = "All changes saved";
    showToast("Draft saved in this browser");
  } catch {
    showToast("Couldn’t save this draft in your browser");
  }
}

function setStep(step) {
  state.currentStep = step;
  $$(".step").forEach((button) => button.classList.toggle("active", button.dataset.step === step));
  $("#editorColumn")?.setAttribute("hidden", "");
  $("#motionPanel").hidden = step !== "motion";
  $("#finishPanel").hidden = step !== "finish";
  const heading = step === "audio" ? "Start with your words" : step === "motion" ? "Give the scene a direction" : "Make it ready to share";
  document.title = `${heading} — Framehouse`;
  if (step === "audio") {
    $(".editor-column").hidden = false;
  } else {
    $(".editor-column").hidden = true;
  }
  $("#previewStage").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function refreshApiStatus() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return;
    state.api = await response.json();
    const live = state.api.vertex;
    $("#modelFootnote").textContent = live ? "Vertex AI connected · Veo 3.1 Fast" : "Demo preview · Cloud models aren’t connected yet.";
    $("#veoConnection").innerHTML = live ? '<i style="background:#89ad51"></i> VERTEX AI CONNECTED' : '<i></i> DEMO PREVIEW';
    $$(".status-demo")[0].textContent = state.api.qwen ? "CONNECTED" : "NOT CONNECTED";
    $$(".status-demo")[0].classList.toggle("status-live", state.api.qwen);
    $$(".status-demo")[1].textContent = live ? "CONNECTED" : "NOT CONNECTED";
    $$(".status-demo")[1].classList.toggle("status-live", live);
    $(".demo-tag").innerHTML = `<i></i> ${state.api.qwen || live ? "Connected workspace" : "Demo project"}`;
  } catch {
    // The static UI remains usable as a sample workspace when no local server is running.
  }
}

async function apiError(response) {
  let message = `Request failed (${response.status})`;
  try {
    const payload = await response.json();
    message = payload.error || payload.message || message;
  } catch {
    // Use the HTTP status when the server did not return JSON.
  }
  return new Error(message);
}

async function generateAudio() {
  const button = $("#generateAudio");
  clearFeedback("#audioFeedback");
  if (!transcript.value.trim()) {
    feedback("#audioFeedback", "Add a transcript before generating the voiceover.", "error");
    transcript.focus();
    return;
  }
  if (!state.api.qwen) {
    feedback("#audioFeedback", "Qwen3-TTS is not connected. You can still play the Xiaoyi reference sample while setting up the voice endpoint.", "error");
    openModal("audio");
    return;
  }
  setBusy(button, true, "Creating your voiceover…");
  try {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: transcript.value.trim(), voice: state.selectedVoice }),
    });
    if (!response.ok) throw await apiError(response);
    const mime = response.headers.get("content-type") || "audio/mpeg";
    state.audioBlob = await response.blob();
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(state.audioBlob);
    voiceAudio.src = state.audioUrl;
    voiceAudio.load();
    state.audioReady = true;
    state.originalScript = transcript.value.trim();
    $("#audioTrackTitle").textContent = `New voiceover · ${state.selectedVoice}`;
    $("#audioNote").innerHTML = '<span class="note-icon">✓</span> Voiceover generated from your transcript. Listen once before creating the scene.';
    $("#previewState").textContent = "VOICEOVER READY";
    $("#previewCaption").textContent = transcript.value.trim().slice(0, 42);
    feedback("#audioFeedback", "Voiceover ready. Give the scene a direction to continue.");
    showToast("Voiceover is ready");
  } catch (error) {
    feedback("#audioFeedback", error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Couldn’t read that image file."));
    reader.readAsDataURL(file);
  });
}

async function selectFrame(file, which) {
  if (!file) return;
  if (!/^image\/(jpeg|png)$/.test(file.type)) {
    showToast("Choose a JPG or PNG image");
    return;
  }
  const dataUrl = await fileToDataUrl(file);
  if (which === "first") {
    state.firstFrame = dataUrl;
    $("#firstFrameThumb").src = dataUrl;
    $("#frameOverlay").src = dataUrl;
    $("#frameOverlay").hidden = false;
    $("#previewVideo").pause();
    $("#previewStage").classList.add("show-frame");
    $("#emptyOverlay").classList.add("visible");
    $("#emptyOverlay strong").textContent = "Opening frame updated";
    $("#emptyOverlay span:last-child").textContent = "Generate a new scene to animate this photo";
    const info = $(".first-frame .frame-tile-text small");
    info.textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
  } else {
    state.lastFrame = dataUrl;
    $("#lastFrameInput").dataset.name = file.name;
    $("#lastFrameSummary").textContent = `Closing frame · ${file.name}`;
    $("#addLastFrame").innerHTML = `<img class="last-frame-thumb" src="${dataUrl}" alt="" /><span class="frame-tile-text"><strong>Closing frame</strong><small>${file.name}</small></span><span class="remove-frame" id="removeLastFrame" role="button" tabindex="0" aria-label="Remove closing frame">×</span>`;
    $("#addLastFrame").classList.add("has-frame");
    $("#removeLastFrame").addEventListener("click", (event) => {
      event.stopPropagation();
      clearLastFrame();
    });
  }
  showToast(which === "first" ? "Opening frame updated" : "Closing frame added");
}

function clearLastFrame() {
  state.lastFrame = null;
  $("#lastFrameInput").value = "";
  $("#lastFrameSummary").textContent = "+ Add closing frame";
  $("#addLastFrame").classList.remove("has-frame");
  $("#addLastFrame").innerHTML = '<span class="add-frame-icon">+</span><span class="frame-tile-text"><strong>Add a closing frame</strong><small>Optional · guides the final moment</small></span><span class="optional-pill">OPTIONAL</span>';
}

function base64Part(dataUrl) {
  if (!dataUrl) return null;
  const [meta, data] = dataUrl.split(",");
  return { mimeType: meta.match(/data:([^;]+)/)?.[1] || "image/jpeg", data };
}

async function generateScene() {
  clearFeedback("#videoFeedback");
  if (!state.audioReady) {
    feedback("#videoFeedback", "Create and review the voiceover first. The transcript and narration should be ready before the scene.", "error");
    setStep("audio");
    return;
  }
  if (!state.api.vertex) {
    feedback("#videoFeedback", "Vertex AI isn’t connected. The supplied sofa clip is available as a preview; connect Veo 3.1 to generate motion from your frames.", "error");
    openModal("video");
    return;
  }
  const button = $("#generateVideo");
  setBusy(button, true, "Generating with Veo… this can take a minute");
  try {
    const audioBase64 = state.audioBlob ? await blobToBase64(state.audioBlob) : null;
    const response = await fetch("/api/video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: $("#videoPrompt").value.trim(),
        transcript: transcript.value.trim(),
        firstFrame: base64Part(state.firstFrame || await imageToDataUrl("/f30881536.jpg")),
        lastFrame: base64Part(state.lastFrame),
        audioBase64,
        durationSeconds: Number($("#sceneDuration").value),
        aspectRatio: $("#aspectRatio").value,
        resolution: $("#resolution").value,
      }),
    });
    if (!response.ok) throw await apiError(response);
    state.videoBlob = await response.blob();
    if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
    state.videoUrl = URL.createObjectURL(state.videoBlob);
    previewVideo.src = state.videoUrl;
    previewVideo.load();
    state.isDemoVideo = false;
    $("#emptyOverlay").classList.remove("visible");
    $("#previewLabel").textContent = "Generated scene";
    $("#previewState").textContent = "SCENE READY";
    $("#modelFootnote").textContent = "Generated with Vertex AI · Veo 3.1 Fast";
    $("#aspectBadge").textContent = $("#aspectRatio").value;
    $("#formatMeta").textContent = $("#aspectRatio").value === "9:16" ? "Vertical · 9:16" : "Landscape · 16:9";
    $("#lengthMeta").textContent = `${$("#sceneDuration").value} sec scene`;
    $("#exportDuration").textContent = `~${secondsLabel(Number($("#sceneDuration").value))}`;
    feedback("#videoFeedback", "Your new scene is ready. Review it, make an edit, or continue to export.");
    setStep("finish");
    showToast("New Veo scene is ready");
  } catch (error) {
    feedback("#videoFeedback", error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function imageToDataUrl(path) {
  return fetch(path).then((response) => response.blob()).then(fileToDataUrl);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("Couldn’t prepare the voiceover for video generation."));
    reader.readAsDataURL(blob);
  });
}

async function exportVideo() {
  const button = $("#downloadVideo");
  clearFeedback("#exportFeedback");
  if (!state.videoBlob) {
    if (state.isDemoVideo) {
      const anchor = document.createElement("a");
      anchor.href = "/edge_samples/demo_listing_reel.mp4";
      anchor.download = "framehouse-demo-listing-reel.mp4";
      anchor.click();
      feedback("#exportFeedback", "Downloaded the included demo reel. Generate a Veo scene and voiceover to export your own cut.");
      return;
    }
    feedback("#exportFeedback", "Generate a video scene before exporting.", "error");
    return;
  }
  if (!state.audioBlob) {
    feedback("#exportFeedback", "Generate a voiceover before exporting the narrated reel.", "error");
    return;
  }
  setBusy(button, true, "Preparing MP4…");
  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoBase64: await blobToBase64(state.videoBlob), audioBase64: await blobToBase64(state.audioBlob), transcript: transcript.value.trim(), subtitles: $("#subtitles").checked, loopVideo: $("#loopScene").checked }),
    });
    if (!response.ok) throw await apiError(response);
    const mp4 = await response.blob();
    const url = URL.createObjectURL(mp4);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "framehouse-listing-reel.mp4";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    feedback("#exportFeedback", "Your MP4 is ready and downloaded.");
    showToast("MP4 exported");
  } catch (error) {
    feedback("#exportFeedback", error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function openModal(kind = "all") {
  if (kind === "audio") {
    $("#modalTitle").textContent = "Connect Qwen3-TTS";
    $("#modalBody").textContent = "Connect a Qwen3-TTS voice-cloning endpoint to generate fresh narration from your transcript. The included Xiaoyi clips are ready to preview.";
  } else if (kind === "video") {
    $("#modalTitle").textContent = "Connect Vertex AI";
    $("#modalBody").textContent = "Connect Vertex AI to animate your opening frame, optional closing frame, and scene direction with Veo 3.1 Fast.";
  } else {
    $("#modalTitle").textContent = "Connect your creative models";
    $("#modalBody").textContent = "Live generation needs a Qwen3-TTS endpoint and Vertex AI access. Your local workspace is using the included sample media for preview.";
  }
  $("#modalBackdrop").hidden = false;
}

function closeModal() {
  $("#modalBackdrop").hidden = true;
}

function setVoice(name, audioPath) {
  state.selectedVoice = name;
  voiceAudio.src = `/edge_samples/${audioPath}`;
  voiceAudio.load();
  $("#audioTrackTitle").textContent = `Voice reference · ${name}`;
  $(".voice-selected-copy strong").textContent = name;
  $$(".voice-option").forEach((option) => {
    const active = option.dataset.name === name;
    option.classList.toggle("selected", active);
    const mark = option.querySelector("span:last-child");
    if (mark && mark.tagName !== "SMALL") mark.textContent = active ? "✓" : "";
  });
  $("#voiceMenu").hidden = true;
  $("#saveLabel").textContent = "Unsaved changes";
}

function toggleAudio() {
  if (voiceAudio.paused) {
    voiceAudio.play().catch(() => showToast("Audio preview could not be played"));
  } else {
    voiceAudio.pause();
  }
}

function openDrawer() {
  $("#editDrawer").classList.add("open");
  $("#editDrawer").setAttribute("aria-hidden", "false");
  $("#editPrompt").focus();
}

function closeDrawer() {
  $("#editDrawer").classList.remove("open");
  $("#editDrawer").setAttribute("aria-hidden", "true");
}

async function applyEdit() {
  clearFeedback("#editFeedback");
  if (!state.api.vertex) {
    feedback("#editFeedback", "Connect Vertex AI to generate a new Veo take. Your current sample preview is unchanged.", "error");
    return;
  }
  $("#videoPrompt").value = $("#editPrompt").value.trim();
  closeDrawer();
  setStep("motion");
  await generateScene();
}

transcript.addEventListener("input", updateTranscript);
$("#generateAudio").addEventListener("click", generateAudio);
$("#playAudio").addEventListener("click", toggleAudio);
$("#voiceAudio").addEventListener("play", () => { $("#playAudio").innerHTML = '<span class="pause-symbol">Ⅱ</span>'; $(".waveform").classList.add("playing"); });
$("#voiceAudio").addEventListener("pause", () => { $("#playAudio").innerHTML = '<span class="play-triangle">▶</span>'; $(".waveform").classList.remove("playing"); });
$("#voiceAudio").addEventListener("loadedmetadata", () => { $("#audioDuration").textContent = secondsLabel(voiceAudio.duration); });
$("#voiceAudio").addEventListener("timeupdate", () => {
  const duration = voiceAudio.duration || 0;
  $(".waveform").style.backgroundSize = `${duration ? (voiceAudio.currentTime / duration) * 100 : 0}% 100%`;
});
$("#voiceDropdown").addEventListener("click", () => { $("#voiceMenu").hidden = !$("#voiceMenu").hidden; });
$("#voiceSamples").addEventListener("click", () => { $("#voiceMenu").hidden = !$("#voiceMenu").hidden; });
$$(".voice-option").forEach((option) => option.addEventListener("click", () => setVoice(option.dataset.name, option.dataset.audio)));
$("#firstFrameInput").addEventListener("change", (event) => selectFrame(event.target.files[0], "first"));
$("#lastFrameInput").addEventListener("change", (event) => selectFrame(event.target.files[0], "last"));
$("#addLastFrame").addEventListener("click", (event) => { if (event.target.id !== "removeLastFrame") $("#lastFrameInput").click(); });
$("#addLastFrame").addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); $("#lastFrameInput").click(); } });
$("#generateVideo").addEventListener("click", generateScene);
$("#exportVideo").addEventListener("click", () => setStep("finish"));
$("#downloadVideo").addEventListener("click", exportVideo);
$("#editVideo").addEventListener("click", openDrawer);
$("#closeDrawer").addEventListener("click", closeDrawer);
$("#applyEdit").addEventListener("click", applyEdit);
$("#backToAudio").addEventListener("click", () => setStep("audio"));
$("#backToMotion").addEventListener("click", () => setStep("motion"));
$$('.step[data-step="audio"]').forEach((button) => button.addEventListener("click", () => setStep("audio")));
$$('.step[data-step="motion"]').forEach((button) => button.addEventListener("click", () => setStep("motion")));
$$('.step[data-step="finish"]').forEach((button) => button.addEventListener("click", () => setStep("finish")));
$("#aspectRatio").addEventListener("change", (event) => {
  const value = event.target.value;
  $("#aspectBadge").textContent = value;
  $("#formatMeta").textContent = value === "9:16" ? "Vertical · 9:16" : "Landscape · 16:9";
  $("#previewStage").classList.toggle("landscape", value === "16:9");
  $("#saveLabel").textContent = "Unsaved changes";
});
$("#sceneDuration").addEventListener("change", (event) => {
  $("#lengthMeta").textContent = `${event.target.value} sec scene`;
  $("#exportDuration").textContent = `~${secondsLabel(Number(event.target.value))}`;
  $("#saveLabel").textContent = "Unsaved changes";
});
$("#safeMargins").addEventListener("change", (event) => { $("#previewStage").classList.toggle("hide-safe", !event.target.checked); });
$("#playVideo").addEventListener("click", () => {
  if (previewVideo.paused) previewVideo.play().catch(() => showToast("Preview could not be played"));
  else previewVideo.pause();
});
previewVideo.addEventListener("play", () => { $("#playVideo").textContent = "Ⅱ"; $("#emptyOverlay").classList.remove("visible"); });
previewVideo.addEventListener("pause", () => { $("#playVideo").textContent = "▶"; });
previewVideo.addEventListener("timeupdate", () => {
  const duration = previewVideo.duration || 0;
  $("#videoTime").innerHTML = `${secondsLabel(previewVideo.currentTime)} <i>/</i> ${secondsLabel(duration)}`;
  $("#videoProgress").style.width = `${duration ? (previewVideo.currentTime / duration) * 100 : 0}%`;
});
$("#muteVideo").addEventListener("click", () => { previewVideo.muted = !previewVideo.muted; $("#muteVideo").textContent = previewVideo.muted ? "◖̸" : "◖"; });
$("#expandPreview").addEventListener("click", () => {
  if (previewVideo.requestFullscreen) previewVideo.requestFullscreen();
  else showToast("Fullscreen preview is unavailable in this browser");
});
$("#platformButton").addEventListener("click", () => {
  const current = $("#platformButton").childNodes[0].textContent.trim();
  const next = current === "Rednote" ? "Instagram" : current === "Instagram" ? "Facebook" : "Rednote";
  $("#platformButton").childNodes[0].textContent = `${next} `;
  $("#saveLabel").textContent = "Unsaved changes";
  showToast(`Format preview set for ${next}`);
});
$("#saveDraft").addEventListener("click", saveDraft);
$("#tipsButton").addEventListener("click", () => openModal("all"));
$("#helpButton").addEventListener("click", () => openModal("all"));
$("#modalClose").addEventListener("click", closeModal);
$("#modalDone").addEventListener("click", closeModal);
$("#modalBackdrop").addEventListener("click", (event) => { if (event.target === $("#modalBackdrop")) closeModal(); });
$("#scriptIdeas").addEventListener("click", () => {
  transcript.value = "想住在一个回家就能放松的地方吗？这间位于新加坡东海岸的明亮住宅，空间舒适，生活配套也很方便。无论是自在的客厅，还是好好休息的卧室，每个角落都适合慢慢布置成你喜欢的样子。想了解更多细节，欢迎预约看房。";
  updateTranscript();
  transcript.focus();
  showToast("A Mandarin listing script is ready to personalise");
});
$("#audioMore").addEventListener("click", () => showToast("Choose a voice or generate a new take"));
$("#videoPrompt").addEventListener("input", () => { $("#saveLabel").textContent = "Unsaved changes"; });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { closeModal(); closeDrawer(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    transcript.focus();
  }
});

updateTranscript();
if (savedDraft?.voice) {
  const voice = $$(".voice-option").find((option) => option.dataset.name === savedDraft.voice);
  if (voice) setVoice(voice.dataset.name, voice.dataset.audio);
}
if (savedDraft?.aspectRatio) $("#aspectRatio").value = savedDraft.aspectRatio;
if (savedDraft?.duration) $("#sceneDuration").value = savedDraft.duration;
if (savedDraft?.platform) $("#platformButton").childNodes[0].textContent = `${savedDraft.platform} `;
$("#aspectRatio").dispatchEvent(new Event("change"));
$("#sceneDuration").dispatchEvent(new Event("change"));
$("#saveLabel").textContent = "All changes saved";
refreshApiStatus();
