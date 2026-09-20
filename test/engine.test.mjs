// Run: node --test
// Feeds synthetic shoulder/elbow/wrist trajectories through RepEngine and
// checks rep counting, partial rejection, quality gating and metrics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RepEngine, angleAt, trackingQuality } from "../public/js/engine.js";

const W = 960, H = 720;
const shoulder = { x: 400, y: 200, v: 0.95 };
const hip = { x: 400, y: 500, v: 0.9 };
const otherShoulder = { x: 250, y: 200, v: 0.9 };
const UPPER = 150, FORE = 140;

// Build the arm for a given elbow angle (deg). Upper arm hangs straight down;
// forearm swings forward (screen-right) as the elbow flexes.
function armAt(angleDeg, opts = {}) {
  const elbow = { x: shoulder.x + (opts.elbowShift || 0), y: shoulder.y + UPPER, v: 0.95 };
  const a = (angleDeg * Math.PI) / 180;
  // angle between (shoulder - elbow) pointing up and (wrist - elbow)
  const wrist = { x: elbow.x + Math.sin(a) * FORE, y: elbow.y - Math.cos(a) * FORE, v: opts.wristVis ?? 0.95 };
  return { shoulder, elbow, wrist, hip, otherShoulder };
}

const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
function* repTrajectory(top, bottom, conMs, holdMs, eccMs, dt = 33) {
  const total = conMs + holdMs + eccMs;
  for (let t = 0; t <= total; t += dt) {
    if (t < conMs) yield bottom - (bottom - top) * ease(t / conMs);
    else if (t < conMs + holdMs) yield top;
    else yield top + (bottom - top) * ease((t - conMs - holdMs) / eccMs);
  }
}

function run(engine, angles, t0, opts = {}) {
  const events = [];
  let t = t0;
  for (const ang of angles) {
    const arm = armAt(ang, opts);
    const q = opts.quality || trackingQuality(arm, W, H);
    const ev = engine.update(t, arm, q);
    if (ev) events.push(ev);
    t += 33;
  }
  return { events, t };
}

function calibrated() {
  const e = new RepEngine();
  const samples = Array.from({ length: 30 }, () => RepEngine.features(armAt(172)));
  e.calibrate(samples);
  return e;
}

test("angleAt returns the interior elbow angle", () => {
  const arm = armAt(60);
  assert.ok(Math.abs(angleAt(arm.shoulder, arm.elbow, arm.wrist) - 60) < 0.01);
  const ext = armAt(175);
  assert.ok(Math.abs(angleAt(ext.shoulder, ext.elbow, ext.wrist) - 175) < 0.01);
});

test("counts 8 full reps with sensible metrics", () => {
  const e = calibrated();
  e.startSet(0);
  let t = 0;
  // settle at bottom first
  ({ t } = run(e, Array(15).fill(172), t));
  for (let i = 0; i < 8; i++) {
    ({ t } = run(e, [...repTrajectory(45, 172, 900, 250, 1200)], t));
    ({ t } = run(e, Array(12).fill(172), t)); // pause between reps
  }
  const { reps } = e.endSet();
  assert.equal(reps.length, 8);
  const r = reps[3];
  assert.ok(r.rom > 110 && r.rom < 135, `rom ${r.rom}`);
  assert.ok(r.minAngle < 55, `minAngle ${r.minAngle}`);
  assert.ok(r.concentric > 650 && r.concentric < 1100, `concentric ${r.concentric}`);
  assert.ok(r.eccentric > 900 && r.eccentric < 1450, `eccentric ${r.eccentric}`);
  assert.ok(r.duration > 2200 && r.duration < 2700, `duration ${r.duration}`);
  assert.ok(r.maxAngle > 165, `maxAngle ${r.maxAngle}`);
  assert.ok(r.elbowDriftMean < 0.02, `drift ${r.elbowDriftMean}`);
  assert.ok(r.frames.length > 50);
  assert.deepEqual(reps.map((x) => x.n), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("endSet finalises a rep that is still finishing its lower", () => {
  const e = calibrated();
  e.startSet(0);
  let t = 0;
  ({ t } = run(e, Array(15).fill(172), t));
  // trajectory ends exactly at the bottom with no settle frames afterwards
  ({ t } = run(e, [...repTrajectory(45, 172, 800, 200, 900)], t));
  const { reps } = e.endSet();
  assert.equal(reps.length, 1);
  assert.ok(reps[0].rom > 110);
});

test("counts back-to-back reps with no pause at the bottom", () => {
  const e = calibrated();
  e.startSet(0);
  let t = 0;
  ({ t } = run(e, Array(15).fill(172), t));
  for (let i = 0; i < 5; i++) ({ t } = run(e, [...repTrajectory(50, 170, 700, 100, 800)], t));
  ({ t } = run(e, Array(20).fill(172), t));
  const { reps } = e.endSet();
  assert.equal(reps.length, 5);
  for (const r of reps) assert.ok(r.rom > 100, `rom ${r.rom}`);
});

test("rejects a partial rep that does not reach the top", () => {
  const e = calibrated();
  e.startSet(0);
  let t = 0;
  ({ t } = run(e, Array(15).fill(172), t));
  const partial = run(e, [...repTrajectory(100, 172, 800, 100, 800)], t);
  t = partial.t;
  assert.ok(partial.events.some((ev) => ev.type === "partial"), "partial event expected");
  const full = run(e, [...repTrajectory(45, 172, 800, 200, 900), ...Array(12).fill(172)], t);
  assert.equal(full.events.filter((ev) => ev.type === "rep").length, 1);
  assert.equal(e.reps.length, 1);
});

test("does not advance rep state while tracking quality is poor", () => {
  const e = calibrated();
  e.startSet(0);
  let t = 0;
  ({ t } = run(e, Array(15).fill(172), t));
  const before = e.frames.length;
  const bad = { ok: false, level: "bad", msg: "手腕被遮住" };
  const r = run(e, [...repTrajectory(45, 172, 800, 200, 900)], t, { quality: bad });
  assert.equal(r.events.length, 0);
  assert.equal(e.reps.length, 0);
  // frames are still logged (for replay continuity) but flagged
  assert.ok(e.frames.length > before);
  assert.ok(e.frames.slice(before).every((f) => f.q === false));
});

test("elbow drift is measured relative to the calibrated baseline", () => {
  const e = calibrated();
  e.startSet(0);
  let t = 0;
  ({ t } = run(e, Array(15).fill(172), t));
  ({ t } = run(e, [...repTrajectory(45, 172, 800, 200, 900)], t, { elbowShift: 40 }));
  assert.equal(e.reps.length, 1);
  assert.ok(e.reps[0].elbowDriftMean > 0.15, `drift ${e.reps[0].elbowDriftMean}`);
});

test("trackingQuality flags hidden wrist and near-edge joints", () => {
  assert.equal(trackingQuality(null, W, H).ok, false);
  const hidden = trackingQuality(armAt(170, { wristVis: 0.2 }), W, H);
  assert.equal(hidden.ok, false);
  assert.match(hidden.msg, /手腕/);
  const good = trackingQuality(armAt(170), W, H);
  assert.equal(good.ok, true);
  assert.equal(good.level, "good");
  const edge = trackingQuality({ ...armAt(170), wrist: { x: 5, y: 300, v: 0.9 } }, W, H);
  assert.equal(edge.ok, false);
  assert.match(edge.msg, /退後/);
});
