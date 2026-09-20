// Persistence: motion data + virtual replay frames are kept by default in
// localStorage. Raw video is never stored by this prototype.

const KEY = "muscle-mirror:sets:v1";

export function loadSets() {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}
export function saveSet(set) {
  const all = loadSets();
  all.unshift(set);
  localStorage.setItem(KEY, JSON.stringify(all));
  return all;
}
export function clearSets() { localStorage.removeItem(KEY); }
export function exportJSON() {
  const blob = new Blob([JSON.stringify(loadSets(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `muscle-mirror-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Find the best comparable prior set: same exercise, side, weight (excluding demo).
export function findComparable(set, all) {
  return all.find(
    (s) => s.id !== set.id && !s.demo && s.exercise === set.exercise && s.side === set.side && Math.abs(s.weight - set.weight) < 0.01,
  );
}

// Were two sets captured under similar conditions (camera distance/angle) and
// performed at a similar tempo? Returns a list of caveats (empty = comparable).
export function comparisonCaveats(a, b) {
  const out = [];
  if (a.capture && b.capture) {
    const ra = a.capture.upperArmRatio, rb = b.capture.upperArmRatio;
    if (ra && rb && Math.abs(ra - rb) / Math.max(ra, rb) > 0.25) out.push("拍攝距離可能不同");
    if (Math.abs((a.capture.torsoAngle ?? 0) - (b.capture.torsoAngle ?? 0)) > 12) out.push("拍攝角度或站姿可能不同");
  } else {
    out.push("其中一組缺少拍攝條件紀錄");
  }
  const tempo = (s) => s.reps.length ? s.reps.reduce((x, r) => x + r.concentric + r.eccentric, 0) / s.reps.length : 0;
  const ta = tempo(a), tb = tempo(b);
  if (ta && tb && Math.abs(ta - tb) / Math.max(ta, tb) > 0.3) out.push("節奏條件不同");
  return out;
}
