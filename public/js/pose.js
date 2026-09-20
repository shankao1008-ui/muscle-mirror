// Pose tracking via MediaPipe Tasks Vision (runs on-device in the browser).
// Exposes: initPose(), detect(video, timestamp) -> landmarks[] | null

import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";

// MediaPipe pose landmark indices
export const LM = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24 },
};

let landmarker = null;

export async function initPose() {
  if (landmarker) return landmarker;
  const vision = await FilesetResolver.forVisionTasks(WASM);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    landmarker = await PoseLandmarker.createFromOptions(vision, opts("GPU"));
  } catch (err) {
    console.warn("GPU delegate unavailable, falling back to CPU:", err?.message || err);
    landmarker = await PoseLandmarker.createFromOptions(vision, opts("CPU"));
  }
  return landmarker;
}

let lastTs = -1;
export function detect(video, ts) {
  if (!landmarker || video.readyState < 2) return null;
  // MediaPipe requires strictly increasing timestamps.
  if (ts <= lastTs) ts = lastTs + 1;
  lastTs = ts;
  const res = landmarker.detectForVideo(video, ts);
  return res.landmarks && res.landmarks[0] ? res.landmarks[0] : null;
}

// Extract the joints we care about for one side, in pixel space.
// Returns null if the trained side is not confidently visible.
export function extractArm(landmarks, side, w, h) {
  const idx = LM[side];
  const pick = (i) => {
    const p = landmarks[i];
    return { x: p.x * w, y: p.y * h, v: p.visibility ?? 1 };
  };
  const shoulder = pick(idx.shoulder);
  const elbow = pick(idx.elbow);
  const wrist = pick(idx.wrist);
  const hip = pick(idx.hip);
  const otherShoulder = pick(LM[side === "right" ? "left" : "right"].shoulder);
  return { shoulder, elbow, wrist, hip, otherShoulder };
}
