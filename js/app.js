// Muscle Mirror — app glue.
import { initPose, detect, extractArm } from "./pose.js";
import { RepEngine, trackingQuality } from "./engine.js";
import { ArmRenderer } from "./arm.js";
import { liveCue, compareHalves, observations, localSummary, compactSet, demoSet } from "./analysis.js";
import { Replay } from "./replay.js";
import { loadSets, saveSet, clearSets, exportJSON, findComparable, comparisonCaveats } from "./store.js";

const $ = (id) => document.getElementById(id);
const EXERCISE_NAMES = { "dumbbell-curl": "啞鈴彎舉" };
const MUSCLES = { "dumbbell-curl": ["二頭肌", "前臂屈肌"] };

// ---------- state ----------
const engine = new RepEngine();
const liveArm = new ArmRenderer($("arm"), { mode: "muscle" });
let stream = null, running = false, calibrating = null, poseReady = false;
let currentSet = null;      // the set being reviewed (post-set → card)
let recorder = null, recChunks = [], recURL = null; // optional raw-video retention (memory only)
let lastQuality = { ok: false, level: "bad", msg: "" };
let replay = null;

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => showView(b.dataset.view)),
);
function showView(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "history") renderHistory();
  if (name === "replay" && replay) replay.render();
}

// ---------- setup ----------
async function listCameras() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const cams = devs.filter((d) => d.kind === "videoinput");
    $("camera").innerHTML = "";
    cams.forEach((c, i) => $("camera").add(new Option(c.label || `攝影機 ${i + 1}`, c.deviceId)));
    if (!cams.length) $("camera").add(new Option("找不到攝影機", ""));
  } catch { $("camera").add(new Option("無法列出攝影機", "")); }
}
listCameras();

$("btn-start-camera").addEventListener("click", async () => {
  const btn = $("btn-start-camera");
  btn.disabled = true; btn.textContent = "載入姿態模型…";
  try {
    if (!poseReady) { await initPose(); poseReady = true; }
    const deviceId = $("camera").value;
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 960 }, height: { ideal: 720 } },
      audio: false,
    });
    const video = $("video");
    video.srcObject = stream;
    await video.play();
    await listCameras();
    $("live").hidden = false;
    $("setup-card").querySelector(".row").hidden = true;
    liveArm.setSide($("side").value); liveArm.setWeight(+$("weight").value);
    running = true;
    loop();
    setCue("站好，手臂自然下垂，按「姿態校準」。");
  } catch (err) {
    setCue(`無法開啟攝影機：${err.message}`);
    btn.disabled = false; btn.textContent = "開啟攝影機";
  }
});

$("side").addEventListener("change", () => liveArm.setSide($("side").value));
$("weight").addEventListener("change", () => liveArm.setWeight(+$("weight").value));
$("arm-view").querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => {
    $("arm-view").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); liveArm.setMode(b.dataset.mode);
    $("arm-legend").innerHTML = {
      muscle: "顏色表示動作模型中的<strong>預期參與角色</strong>，不是量測到的活化程度。",
      skeleton: "骨骼視圖：以攝影機追蹤到的肩、肘、腕位置計算肘關節角度。",
      mechanics: "力學視圖：依輸入重量與前臂姿勢計算的<strong>簡化外力矩</strong>，不代表個別肌肉的真實力量。",
    }[b.dataset.mode];
  }),
);

// ---------- main loop ----------
let calSamples = [];
function loop() {
  if (!running) return;
  const video = $("video"), overlay = $("overlay");
  if (video.videoWidth && overlay.width !== video.videoWidth) {
    overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  }
  const now = performance.now();
  const lms = detect(video, now);
  const W = overlay.width, H = overlay.height;
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  let arm = null;
  if (lms) {
    arm = extractArm(lms, $("side").value, W, H);
    drawSkeleton(ctx, arm, W);
  }
  lastQuality = trackingQuality(arm, W, H);
  setQuality(lastQuality);

  if (calibrating) {
    if (arm && lastQuality.ok) calSamples.push(RepEngine.features(arm));
    const left = Math.max(0, calibrating - now);
    setCue(arm ? `校準中… ${(left / 1000).toFixed(1)} s，請保持手臂自然下垂。` : `校準中… ${(left / 1000).toFixed(1)} s，${lastQuality.msg}`);
    if (left <= 0) finishCalibration();
  }
  if (arm) {
    const ev = engine.update(now, arm, lastQuality);
    if (ev?.type === "rep") onRep(ev.rep);
    if (ev?.type === "partial") setCue("這一下沒有達到足夠幅度，未計入。");
    $("stat-angle").textContent = engine.angle != null ? `${Math.round(engine.angle)}°` : "—";
    $("stat-phase").textContent = lastQuality.ok ? engine.phase : "暫停評估";
    liveArm.draw({
      angle: engine.angle ?? 170, phase: engine.phase,
      elbowDrift: engine.baseline && engine.frames.length ? engine.frames[engine.frames.length - 1].elbowDrift : 0,
    });
  } else {
    liveArm.draw({ angle: 170, phase: "準備", title: "等待入鏡", sub: "找不到人物" });
  }
  if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(() => loop());
  else requestAnimationFrame(loop);
}

function drawSkeleton(ctx, arm, W) {
  const mx = (p) => ({ x: W - p.x, y: p.y }); // video is mirrored; mirror overlay to match
  const s = mx(arm.shoulder), e = mx(arm.elbow), w = mx(arm.wrist), h = mx(arm.hip), os = mx(arm.otherShoulder);
  ctx.lineWidth = 6; ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(94,234,212,0.35)";
  ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(h.x, h.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(os.x, os.y); ctx.stroke();
  ctx.strokeStyle = "#5eead4";
  ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y); ctx.lineTo(w.x, w.y); ctx.stroke();
  for (const [p, name] of [[s, "肩"], [e, "肘"], [w, "腕"]]) {
    ctx.fillStyle = p.v > 0.5 ? "#f59e0b" : "#f87171";
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "600 16px system-ui"; ctx.fillText(name, p.x + 12, p.y - 10);
  }
  if (engine.angle != null) {
    ctx.fillStyle = "#5eead4"; ctx.font = "700 26px system-ui";
    ctx.fillText(`${Math.round(engine.angle)}°`, e.x + 14, e.y + 30);
  }
}

function setQuality(q) {
  const b = $("track-quality");
  b.textContent = q.level === "good" ? "追蹤清楚" : q.ok ? "追蹤可用" : "辨識不足：暫停評估";
  b.className = `badge ${q.level}`;
  $("track-hint").textContent = q.level === "good" ? "" : q.msg;
}

let cueTimer = null;
function setCue(text, flash = false) {
  const el = $("cue");
  el.textContent = text; el.classList.toggle("flash", flash);
  if (cueTimer) clearTimeout(cueTimer);
  if (flash) cueTimer = setTimeout(() => el.classList.remove("flash"), 900);
}

// ---------- calibration ----------
$("btn-calibrate").addEventListener("click", () => {
  calSamples = []; calibrating = performance.now() + 3000;
  $("btn-calibrate").disabled = true;
});
function finishCalibration() {
  calibrating = null; $("btn-calibrate").disabled = false;
  if (calSamples.length < 20) { setCue("校準樣本不足，請確認追蹤清楚後再試一次。"); return; }
  const b = engine.calibrate(calSamples);
  b.upperArmRatio = b.upperArm / ($("overlay").height || 1); // camera-distance proxy for later comparisons
  setCue(`校準完成（放鬆肘角約 ${Math.round(b.angle)}°）。按「開始本組」。`, true);
  $("btn-start-set").disabled = false;
}

// ---------- set control ----------
$("btn-start-set").addEventListener("click", () => {
  engine.startSet(performance.now());
  $("stat-reps").textContent = "0"; $("stat-rom").textContent = "—"; $("stat-tempo").textContent = "—";
  $("btn-start-set").disabled = true; $("btn-end-set").disabled = false; $("btn-calibrate").disabled = true;
  $("post-set").hidden = true; $("record-card").hidden = true;
  startRecording();
  setCue("開始。目前第 0 次。", true);
});

function startRecording() {
  stopRecording();
  if (!$("keep-video").checked || !stream || typeof MediaRecorder === "undefined") return;
  try {
    recChunks = [];
    recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("video/webm") ? "video/webm" : "" });
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.start(1000);
  } catch (err) { console.warn("錄影無法啟動：", err.message); recorder = null; }
}
function stopRecording() {
  return new Promise((resolve) => {
    if (!recorder || recorder.state === "inactive") { recorder = null; return resolve(null); }
    recorder.onstop = () => {
      const blob = new Blob(recChunks, { type: recorder.mimeType || "video/webm" });
      recorder = null;
      resolve(blob.size ? blob : null);
    };
    recorder.stop();
  });
}
function offerVideoDownload(blob) {
  const slot = $("video-download");
  if (recURL) { URL.revokeObjectURL(recURL); recURL = null; }
  if (!blob) { slot.hidden = true; slot.innerHTML = ""; return; }
  recURL = URL.createObjectURL(blob);
  slot.hidden = false;
  slot.innerHTML = `<a class="ghost" download="muscle-mirror-${Date.now()}.webm" href="${recURL}"><button type="button" class="ghost">下載本組原始影片（${(blob.size / 1e6).toFixed(1)} MB，僅存在此頁面記憶體）</button></a>`;
}
$("btn-end-set").addEventListener("click", async () => {
  const { reps } = engine.endSet();
  $("btn-end-set").disabled = true; $("btn-start-set").disabled = false; $("btn-calibrate").disabled = false;
  const b = engine.baseline || {};
  currentSet = {
    id: "set-" + Date.now(), demo: false,
    exercise: $("exercise").value, exerciseName: EXERCISE_NAMES[$("exercise").value],
    side: $("side").value, weight: +$("weight").value, date: new Date().toISOString(), reps,
    capture: { upperArmRatio: b.upperArmRatio, torsoAngle: b.torsoAngle, restAngle: b.angle },
  };
  setCue(`本組結束，完成 ${reps.length} 次。`);
  const blob = await stopRecording();
  showPostSet(currentSet);
  offerVideoDownload(blob);
});

function onRep(rep) {
  $("stat-reps").textContent = String(rep.n);
  $("stat-rom").textContent = `${rep.rom}°`;
  $("stat-tempo").textContent = `${(rep.concentric / 1000).toFixed(1)}↑ ${(rep.eccentric / 1000).toFixed(1)}↓`;
  setCue(liveCue(engine.reps), true);
}

// ---------- demo ----------
$("btn-demo").addEventListener("click", () => {
  currentSet = demoSet(+$("weight").value, $("side").value);
  showPostSet(currentSet);
  offerVideoDownload(null);
});

// ---------- post-set ----------
$("rpe").addEventListener("input", () => ($("rpe-out").value = $("rpe").value));
function showPostSet(set) {
  $("post-set").hidden = false; $("record-card").hidden = true;
  $("post-set-meta").innerHTML = `${set.side === "right" ? "右手" : "左手"}${set.exerciseName}｜${set.weight} kg｜${set.reps.length} 次` +
    (set.demo ? `<span class="demo-flag">示範資料（合成，非實測）</span>` : "");
  $("compare-table").innerHTML = renderCompare(set.reps);
  $("post-set").scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderCompare(reps) {
  const c = compareHalves(reps);
  if (!c.ok) return `<p class="na">${c.reason}</p>`;
  const cls = (r) => (r > 0.08 ? "up" : r < -0.08 ? "down" : "flat");
  return `<table class="cmp"><thead><tr><th>資訊</th><th>前段（第 ${c.A[0]}–${c.A[c.A.length - 1]} 次）</th><th>後段（第 ${c.B[0]}–${c.B[c.B.length - 1]} 次）</th><th>變化</th></tr></thead><tbody>` +
    c.rows.map((r) => `<tr><td>${r.label}</td><td>${r.fa}${r.unit}</td><td>${r.fb}${r.unit}</td><td class="${cls(r.rel)}">${r.rel > 0 ? "+" : ""}${Math.round(r.rel * 100)}%</td></tr>`).join("") +
    `</tbody></table><p class="muted">這些是影像中可觀察到的變化。速度變慢也可能是刻意放慢節奏，請在下方註記。</p>`;
}

$("btn-discard").addEventListener("click", () => { $("post-set").hidden = true; currentSet = null; });
$("btn-save").addEventListener("click", async () => {
  if (!currentSet) return;
  currentSet.rpe = +$("rpe").value; currentSet.rir = +$("rir").value; currentSet.note = $("note").value.trim();
  currentSet.observations = observations(currentSet.reps).map((o) => o.text);
  currentSet.localSummary = localSummary(currentSet);
  saveSet(currentSet);
  $("post-set").hidden = true;
  renderCard(currentSet);
  $("tab-replay").disabled = false;
  replay = replay || makeReplay();
  replay.load(currentSet);
  await fetchFableSummary(currentSet);
});

// ---------- record card ----------
function renderCard(set) {
  $("record-card").hidden = false;
  const obs = observations(set.reps);
  const items = [
    { text: `完成次數：${set.reps.length} 次` },
    ...obs,
    { text: `自評用力程度：${set.rpe}／10` },
    { text: `自評剩餘次數：${set.rir} 次` },
  ];
  if (set.note) items.push({ text: `註記：${set.note}` });
  $("record-body").innerHTML =
    `<p class="title">${set.side === "right" ? "右手" : "左手"}${set.exerciseName}｜${set.weight} kg｜${set.reps.length} 次` +
    (set.demo ? `<span class="demo-flag">示範資料（合成，非實測）</span>` : "") + `</p>` +
    `<ul>` + items.map((it) => `<li><span>${it.text}</span>${it.reps ? `<button data-a="${it.reps[0]}" data-b="${it.reps[1]}">回放 ${it.reps[0]} vs ${it.reps[1]}</button>` : ""}</li>`).join("") + `</ul>`;
  $("record-body").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => openReplay(+b.dataset.a, +b.dataset.b)),
  );
  $("summary-text").textContent = set.localSummary;
  $("summary-source").textContent = "本機規則摘要"; $("summary-source").className = "badge neutral";
  $("ask-answer").hidden = true;
  $("record-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function fetchFableSummary(set) {
  $("summary-source").textContent = "Fable 生成中…";
  try {
    const r = await fetch("/api/summary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: compactSet(set) }) });
    const data = await r.json();
    if (data.ok && data.text) {
      $("summary-text").textContent = data.text;
      $("summary-source").textContent = `Fable 摘要（${data.model}）`; $("summary-source").className = "badge good";
      set.fableSummary = data.text;
    } else {
      $("summary-source").textContent = `本機規則摘要（${data.error || "Fable 不可用"}）`;
    }
  } catch {
    $("summary-source").textContent = "本機規則摘要（此部署未連接 Fable 伺服器）";
  }
}

$("btn-ask").addEventListener("click", async () => {
  const q = $("ask-input").value.trim();
  if (!q || !currentSet) return;
  const out = $("ask-answer"); out.hidden = false; out.textContent = "Fable 思考中…";
  try {
    const r = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: compactSet(currentSet), question: q }) });
    const data = await r.json();
    out.textContent = data.ok ? data.text : `Fable 不可用（${data.error}）。可先用「回放比較」直接查看兩次動作的差異表。`;
  } catch { out.textContent = "此部署未連接 Fable 伺服器，無法詢問。可先用「回放比較」直接查看兩次動作的差異表。"; }
});
$("ask-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-ask").click(); });

$("btn-open-replay").addEventListener("click", () => openReplay());
$("btn-new-set").addEventListener("click", () => {
  $("record-card").hidden = true;
  if (!running) $("setup-card").scrollIntoView({ behavior: "smooth" });
});

// ---------- replay ----------
function makeReplay() {
  return new Replay({
    canvasA: $("arm-a"), canvasB: $("arm-b"), selA: $("rep-a"), selB: $("rep-b"),
    speed: $("replay-speed"), play: $("btn-play"), timeline: $("timeline"), chart: $("angle-chart"),
    labelA: $("label-a"), labelB: $("label-b"), diff: $("replay-diff"), viewSeg: $("replay-view"),
  });
}
function openReplay(a, b) {
  if (!currentSet) return;
  replay = replay || makeReplay();
  $("tab-replay").disabled = false;
  showView("replay");
  replay.load(currentSet, a, b);
}

// ---------- history ----------
function renderHistory() {
  const all = loadSets();
  const list = $("history-list");
  if (!all.length) {
    list.innerHTML = `<p class="muted">還沒有紀錄。完成一組並儲存後會出現在這裡。</p>`;
    $("history-compare").innerHTML = ""; $("muscle-map").innerHTML = ""; return;
  }
  // comparison against the most comparable earlier set
  const latest = all.find((s) => !s.demo) || all[0];
  const prev = findComparable(latest, all.filter((s) => s.id !== latest.id));
  const romOf = (s) => s.reps.length ? (s.reps.reduce((a, r) => a + r.rom, 0) / s.reps.length).toFixed(1) : "—";
  const caveats = prev ? comparisonCaveats(prev, latest) : [];
  $("history-compare").innerHTML = prev
    ? `<strong>相同條件比較</strong>（${latest.exerciseName}・${latest.side === "right" ? "右手" : "左手"}・${latest.weight} kg）：` +
      `上次 ${prev.reps.length} 次 → 本次 ${latest.reps.length} 次；平均活動幅度 ${romOf(prev)}° → ${romOf(latest)}°；` +
      `自評用力 ${prev.rpe}/10 → ${latest.rpe}/10。` +
      (caveats.length ? `<br><span class="muted">注意：${caveats.join("、")}，比較僅供參考。</span>` : `<br><span class="muted">拍攝距離、角度與節奏條件相近。</span>`)
    : `<span class="muted">尚無相同動作、相同側、相同重量的先前紀錄可比較。</span>`;
  // muscle map: which target muscles were scheduled this week (sets count)
  const weekAgo = Date.now() - 7 * 86400e3;
  const counts = {};
  for (const s of all) if (new Date(s.date).getTime() > weekAgo && !s.demo) for (const m of MUSCLES[s.exercise] || []) counts[m] = (counts[m] || 0) + 1;
  $("muscle-map").innerHTML = `<div class="muscle-chip"><span class="muted">本週安排過訓練的目標肌群</span></div>` +
    (Object.keys(counts).length
      ? Object.entries(counts).map(([m, n]) => `<div class="muscle-chip">${m}<b>${n} 組</b></div>`).join("")
      : `<div class="muscle-chip muted">本週尚無實測紀錄</div>`);
  list.innerHTML = all.map((s) => `<div class="hcard" data-id="${s.id}">
      <div class="t">${s.side === "right" ? "右手" : "左手"}${s.exerciseName}｜${s.weight} kg｜${s.reps.length} 次 ${s.demo ? '<span class="demo-flag">示範</span>' : ""}</div>
      <div class="m">${new Date(s.date).toLocaleString("zh-TW")}</div>
      <div class="m">用力 ${s.rpe}/10・剩餘 ${s.rir} 次・平均幅度 ${romOf(s)}°</div>
      ${(s.observations || []).slice(0, 2).map((o) => `<div>• ${o}</div>`).join("")}
    </div>`).join("");
  list.querySelectorAll(".hcard").forEach((el) => el.addEventListener("click", () => {
    currentSet = all.find((s) => s.id === el.dataset.id);
    showView("train"); renderCard(currentSet);
    $("tab-replay").disabled = false; replay = replay || makeReplay(); replay.load(currentSet);
  }));
}
$("btn-export").addEventListener("click", exportJSON);
$("btn-clear").addEventListener("click", () => { if (confirm("確定清除所有本機紀錄？")) { clearSets(); renderHistory(); } });

liveArm.draw({ angle: 170, phase: "準備", title: "等待攝影機", sub: "開啟攝影機後同步顯示" });
window.addEventListener("resize", () => { if (!running) liveArm.draw({ angle: 170, phase: "準備", title: "等待攝影機", sub: "開啟攝影機後同步顯示" }); if (replay) replay.render(); });
if (new URLSearchParams(location.search).get("demo") === "1") $("btn-demo").click();
