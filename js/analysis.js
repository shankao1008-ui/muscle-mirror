// Analysis: live cues, first-half vs second-half comparison, observations,
// rule-based summary (fallback when Fable is unavailable), demo data.

const fmtS = (ms) => (ms / 1000).toFixed(2) + " s";
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// One cue at a time; describes what was observed, never what a muscle "did".
export function liveCue(reps) {
  const rep = reps[reps.length - 1];
  const prev = reps.slice(Math.max(0, reps.length - 4), reps.length - 1);
  if (prev.length < 2) return `目前第 ${rep.n} 次。`;
  const pRom = mean(prev.map((r) => r.rom));
  const pCon = mean(prev.map((r) => r.concentric));
  const pDrift = mean(prev.map((r) => r.elbowDriftMean));
  if (rep.rom < pRom * 0.85) return `第 ${rep.n} 次：這次活動幅度比前幾次小。`;
  if (rep.elbowDriftMean > pDrift + 0.06) return `第 ${rep.n} 次：手肘位置比前幾次移動更多。`;
  if (rep.concentric > pCon * 1.35) return `第 ${rep.n} 次：這次抬起時間比前幾次長。`;
  if (rep.concentric < pCon * 0.7) return `第 ${rep.n} 次：這次抬起比前幾次快。`;
  return `目前第 ${rep.n} 次。`;
}

// Compare first half vs second half of a set.
export function compareHalves(reps) {
  if (reps.length < 4) {
    return { ok: false, reason: `只有 ${reps.length} 次，少於 4 次，本組不適合比較。` };
  }
  const half = Math.floor(reps.length / 2);
  const A = reps.slice(0, half), B = reps.slice(reps.length - half);
  const metric = (key, label, unit, fmt = (x) => x.toFixed(1)) => {
    const a = mean(A.map((r) => r[key])), b = mean(B.map((r) => r[key]));
    const rel = a ? (b - a) / Math.abs(a) : 0;
    return { key, label, unit, a, b, rel, fa: fmt(a), fb: fmt(b) };
  };
  const rows = [
    metric("rom", "活動幅度（角度範圍）", "°"),
    metric("concentric", "抬起時間", "", fmtS),
    metric("hold", "停留時間", "", fmtS),
    metric("eccentric", "放下時間", "", fmtS),
    metric("elbowDriftMean", "手肘位移（相對上臂長）", "", (x) => x.toFixed(2)),
    metric("swayRange", "軀幹晃動範圍", "°"),
  ];
  return { ok: true, half, rows, A: A.map((r) => r.n), B: B.map((r) => r.n) };
}

// Pick a representative early/late rep for replay (e.g. 2 vs 9 in a 10-rep set).
export function replayPair(cmp) {
  const a = cmp.A[Math.min(1, cmp.A.length - 1)];
  const b = cmp.B[Math.max(0, cmp.B.length - 2)];
  return [a, b];
}

// Human-readable observations, each tied to specific reps so they can be replayed.
export function observations(reps) {
  const out = [];
  if (!reps.length) return out;
  const cmp = compareHalves(reps);
  if (cmp.ok) {
    const pair = replayPair(cmp);
    const con = cmp.rows.find((r) => r.key === "concentric");
    const ecc = cmp.rows.find((r) => r.key === "eccentric");
    const rom = cmp.rows.find((r) => r.key === "rom");
    if (con.rel > 0.15) out.push({ text: `後段抬起時間比前段增加（${con.fa} → ${con.fb}）`, reps: pair });
    if (con.rel < -0.15) out.push({ text: `後段抬起時間比前段縮短（${con.fa} → ${con.fb}）`, reps: pair });
    if (ecc.rel < -0.2) out.push({ text: `後段放下時間比前段縮短（${ecc.fa} → ${ecc.fb}）`, reps: pair });
    if (rom.rel < -0.08) out.push({ text: `後段活動幅度比前段縮小（${rom.fa}° → ${rom.fb}°）`, reps: pair });
  }
  // trailing reps with reduced ROM
  const base = mean(reps.slice(0, Math.max(2, Math.floor(reps.length / 2))).map((r) => r.rom));
  let k = 0;
  for (let i = reps.length - 1; i >= 0 && reps[i].rom < base * 0.88; i--) k++;
  if (k > 0 && k < reps.length) out.push({ text: `最後 ${k} 次活動幅度縮小`, reps: [reps[0].n, reps[reps.length - 1].n] });
  // elbow drift onset
  const dBase = mean(reps.slice(0, Math.max(2, Math.floor(reps.length / 2))).map((r) => r.elbowDriftMean));
  const onset = reps.find((r) => r.elbowDriftMean > dBase + 0.06 && r.n > 2);
  if (onset && reps.slice(onset.n - 1).filter((r) => r.elbowDriftMean > dBase + 0.06).length >= 2) {
    out.push({ text: `第 ${onset.n} 次起，手肘位移增加`, reps: [Math.max(1, onset.n - 2), onset.n] });
  }
  const sBase = mean(reps.slice(0, Math.max(2, Math.floor(reps.length / 2))).map((r) => r.swayRange));
  const sw = reps.find((r) => r.swayRange > sBase + 4 && r.n > 2);
  if (sw) out.push({ text: `第 ${sw.n} 次起，軀幹晃動增加`, reps: [Math.max(1, sw.n - 2), sw.n] });
  return out;
}

// Rule-based summary used when Fable is not reachable.
export function localSummary(set) {
  const reps = set.reps;
  if (!reps.length) return "本組沒有偵測到完整動作，無法整理摘要。";
  const cmp = compareHalves(reps);
  if (!cmp.ok) return `完成 ${reps.length} 次。${cmp.reason} 需要至少 4 次完整動作，才能比較前段與後段。`;
  const obs = observations(reps).map((o) => o.text);
  const parts = [`本組完成 ${reps.length} 次。`];
  if (obs.length) parts.push(`觀察到：${obs.join("；")}。`);
  else parts.push("前段與後段的節奏、幅度與姿勢差異不大。");
  const rpe = set.rpe, rir = set.rir;
  if (obs.length && rpe >= 7) parts.push(`加上你回報吃力程度 ${rpe}/10、預估剩餘 ${rir} 次，這些變化可能與疲勞有關。`);
  else if (obs.length) parts.push(`你回報吃力程度 ${rpe}/10，變化也可能是刻意調整節奏。`);
  if (set.note) parts.push(`你的註記「${set.note}」已一併保留。`);
  const [a, b] = replayPair(cmp);
  parts.push(`可以回放第 ${a} 次與第 ${b} 次，查看差異。`);
  return parts.join("");
}

// Strip heavy per-frame data before sending to Fable or storing summaries.
export function compactSet(set) {
  return {
    ...set,
    reps: set.reps.map(({ frames, ...r }) => r),
    frames: undefined,
  };
}

// ---- Demo data (synthetic, clearly labelled) ----
export function demoSet(weight = 6, side = "right") {
  const reps = [];
  let t = 0;
  for (let n = 1; n <= 10; n++) {
    const fatigue = Math.max(0, (n - 6) / 4); // 0 → 1 across last reps
    const con = 900 + 500 * fatigue + rnd(80);
    const hold = 250 + rnd(60);
    const ecc = 1200 - 250 * fatigue + rnd(80);
    const minAngle = 48 + 22 * fatigue + rnd(3);
    const maxAngle = 168 - 6 * fatigue + rnd(2);
    const drift = 0.04 + 0.12 * fatigue + rnd(0.01);
    const sway = 2 + 5 * fatigue + rnd(0.6);
    const frames = synthFrames(con, hold, ecc, minAngle, maxAngle, drift, sway);
    const dur = con + hold + ecc;
    reps.push({
      n, tStart: t, duration: dur, concentric: con, hold, eccentric: ecc,
      minAngle: +minAngle.toFixed(1), maxAngle: +maxAngle.toFixed(1), rom: +(maxAngle - minAngle).toFixed(1),
      elbowDriftMean: +drift.toFixed(3), elbowDriftMax: +(drift * 1.4).toFixed(3), swayRange: +sway.toFixed(1), frames,
    });
    t += dur + 600;
  }
  return {
    id: "demo-" + Date.now(),
    demo: true,
    exercise: "dumbbell-curl",
    exerciseName: "啞鈴彎舉",
    side, weight,
    date: new Date().toISOString(),
    reps,
  };
}
function rnd(s) { return (Math.random() - 0.5) * 2 * s; }
function synthFrames(con, hold, ecc, minA, maxA, drift, sway) {
  const frames = []; const dt = 33; const total = con + hold + ecc;
  for (let t = 0; t <= total; t += dt) {
    let a;
    if (t < con) a = maxA - (maxA - minA) * ease(t / con);
    else if (t < con + hold) a = minA;
    else a = minA + (maxA - minA) * ease((t - con - hold) / ecc);
    const p = t < con ? "抬起" : t < con + hold ? "停留" : "放下";
    const prog = Math.sin((Math.PI * t) / total);
    frames.push({ t, angle: +a.toFixed(1), elbowDrift: +(drift * prog).toFixed(3), sway: +(sway * prog).toFixed(1), phase: p, q: true });
  }
  return frames;
}
function ease(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
