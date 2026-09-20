// Rep engine: elbow angle, phase, rep segmentation, per-rep metrics,
// tracking quality. Pure computation — no DOM.

const TOP = 75;      // deg: below this counts as "reached the top"
const BOTTOM = 140;  // deg: above this counts as "back to extended"
const START = 128;   // deg: dropping below this starts a candidate rep

export function angleAt(a, b, c) {
  // angle at b between vectors ba and bc, degrees
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const dot = v1x * v2x + v1y * v2y;
  const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1e-6;
  return (Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180) / Math.PI;
}

export function trackingQuality(arm, w, h) {
  if (!arm) return { ok: false, level: "bad", msg: "找不到人物，請入鏡。" };
  const joints = [arm.shoulder, arm.elbow, arm.wrist];
  const minVis = Math.min(...joints.map((j) => j.v));
  const hipVis = arm.hip.v;
  const margin = 0.04;
  const nearEdge = joints.some(
    (j) => j.x < w * margin || j.x > w * (1 - margin) || j.y < h * margin || j.y > h * (1 - margin),
  );
  const armLen = Math.hypot(arm.shoulder.x - arm.elbow.x, arm.shoulder.y - arm.elbow.y);
  if (arm.wrist.v < 0.5) return { ok: false, level: "bad", msg: "手腕被遮住或不在畫面內。" };
  if (arm.elbow.v < 0.5) return { ok: false, level: "bad", msg: "手肘被遮住。" };
  if (arm.shoulder.v < 0.5) return { ok: false, level: "bad", msg: "肩膀被遮住。" };
  if (nearEdge) return { ok: false, level: "warn", msg: "請退後一些，手臂靠近畫面邊緣。" };
  if (armLen < h * 0.08) return { ok: false, level: "warn", msg: "請靠近一些，手臂在畫面中太小。" };
  if (hipVis < 0.4) return { ok: true, level: "warn", msg: "軀幹未完全入鏡，晃動估計可能不準。" };
  if (minVis < 0.7) return { ok: true, level: "warn", msg: "追蹤略不穩定。" };
  return { ok: true, level: "good", msg: "追蹤清楚" };
}

export class RepEngine {
  constructor() {
    this.reset();
    this.baseline = null; // set by calibrate()
  }

  reset() {
    this.reps = [];
    this.frames = []; // every frame during the set: {t, angle, ...}
    this.angle = null;
    this.vel = 0;
    this.phase = "準備";
    this._lastT = null;
    this._state = "idle"; // idle | inrep | ending
    this._cur = null;
    this._bottomIdx = null;
    this._recentMax = 180;
    this.active = false;
    this.startTime = null;
  }

  // Calibration: average of frames while the arm hangs relaxed.
  calibrate(samples) {
    if (!samples.length) return null;
    const avg = (k) => samples.reduce((s, x) => s + x[k], 0) / samples.length;
    this.baseline = {
      angle: avg("angle"),
      elbowDx: avg("elbowDx"),
      elbowDy: avg("elbowDy"),
      upperArm: avg("upperArm"),
      torsoAngle: avg("torsoAngle"),
    };
    return this.baseline;
  }

  // Compute frame features from arm joints (pixel space).
  static features(arm) {
    const angle = angleAt(arm.shoulder, arm.elbow, arm.wrist);
    const upperArm = Math.hypot(arm.elbow.x - arm.shoulder.x, arm.elbow.y - arm.shoulder.y) || 1;
    const elbowDx = (arm.elbow.x - arm.shoulder.x) / upperArm;
    const elbowDy = (arm.elbow.y - arm.shoulder.y) / upperArm;
    // torso lean: angle of hip->shoulder vector from vertical, degrees
    const tx = arm.shoulder.x - arm.hip.x, ty = arm.shoulder.y - arm.hip.y;
    const torsoAngle = (Math.atan2(tx, -ty) * 180) / Math.PI;
    return { angle, upperArm, elbowDx, elbowDy, torsoAngle };
  }

  // Feed one frame. t in ms. Returns event: null | {type:'rep', rep}
  update(t, arm, quality) {
    const f = RepEngine.features(arm);
    // smooth angle (EMA) + velocity
    const prev = this.angle;
    this.angle = prev == null ? f.angle : prev + (f.angle - prev) * 0.45;
    if (this._lastT != null) {
      const dt = Math.max(1, t - this._lastT) / 1000;
      const v = (this.angle - (prev ?? this.angle)) / dt;
      this.vel = this.vel + (v - this.vel) * 0.5;
    }
    this._lastT = t;

    // elbow drift: distance of elbow (relative to shoulder, normalised) from baseline
    let elbowDrift = 0;
    if (this.baseline) {
      elbowDrift = Math.hypot(f.elbowDx - this.baseline.elbowDx, f.elbowDy - this.baseline.elbowDy);
    }
    const sway = this.baseline ? f.torsoAngle - this.baseline.torsoAngle : 0;

    // phase
    if (this.angle < TOP + 10 && Math.abs(this.vel) < 25) this.phase = "停留";
    else if (this.vel < -30) this.phase = "抬起";
    else if (this.vel > 30) this.phase = "放下";
    else if (this.angle > BOTTOM) this.phase = "準備";

    if (!this.active) return null;

    const frame = {
      t: t - this.startTime,
      angle: +this.angle.toFixed(1),
      elbowDrift: +elbowDrift.toFixed(3),
      sway: +sway.toFixed(1),
      phase: this.phase,
      q: quality.ok,
    };
    this.frames.push(frame);

    // When tracking is poor, do not advance the rep state machine.
    if (!quality.ok) return null;

    const idx = this.frames.length - 1;

    if (this._state === "idle") {
      this._recentMax = Math.max(this._recentMax * 0.98 + this.angle * 0.02, this.angle);
      // Remember the last frame still resting near full extension, so the rep
      // is stamped from the moment the arm leaves the bottom, not from START.
      if (this.angle >= this._recentMax - 6) this._bottomIdx = idx;
      if (this.angle < START) this._beginRep(this._bottomIdx ?? idx);
      return null;
    }

    const c = this._cur;
    if (this._state === "inrep") {
      if (this.angle < c.minAngle) {
        c.minAngle = this.angle;
        c.tMin = frame.t;
      }
      if (this.angle < TOP) c.reachedTop = true;
      if (this.angle > BOTTOM) {
        if (!c.reachedTop) {
          this._state = "idle";
          this._recentMax = this.angle;
          this._bottomIdx = idx;
          this._cur = null;
          return { type: "partial" };
        }
        // Keep extending the rep until the arm stops opening (true end of the lower).
        this._state = "ending";
        c.peak = this.angle;
        c.endIdx = idx;
      }
      return null;
    }

    // ending: wait for the extension to plateau, time out, or the next rep to start
    // Only a meaningful increase moves the end point (EMA smoothing creeps asymptotically).
    if (this.angle > c.peak + 0.3) {
      c.peak = this.angle;
      c.endIdx = idx;
    }
    const sinceEnd = frame.t - this.frames[c.endIdx].t;
    const plateau = this.angle < c.peak - 1.5;
    const settled = Math.abs(this.vel) < 8 && sinceEnd > 100; // arm has come to rest
    const timedOut = sinceEnd > 300;
    const nextRep = this.angle < START;
    if (plateau || settled || timedOut || nextRep) {
      const rep = this._finishRep(c, c.endIdx);
      this.reps.push(rep);
      this._state = "idle";
      this._recentMax = c.peak;
      this._bottomIdx = c.endIdx;
      this._cur = null;
      if (nextRep) this._beginRep(c.endIdx);
      return { type: "rep", rep };
    }
    return null;
  }

  _beginRep(startIdx) {
    const f0 = this.frames[startIdx];
    this._state = "inrep";
    this._cur = {
      startIdx,
      tStart: f0.t,
      startAngle: Math.max(this._recentMax, f0.angle),
      minAngle: this.angle,
      tMin: this.frames[this.frames.length - 1].t,
      reachedTop: false,
    };
  }

  _finishRep(c, endIdx) {
    const frames = this.frames.slice(c.startIdx, endIdx + 1).map((f) => ({ ...f, t: f.t - c.tStart }));
    const tEnd = this.frames[endIdx].t;
    const dur = tEnd - c.tStart;
    const tMinRel = c.tMin - c.tStart;
    // hold: time spent within 10° of the minimum
    const holdFrames = frames.filter((f) => f.angle <= c.minAngle + 10);
    const hold = holdFrames.length ? holdFrames[holdFrames.length - 1].t - holdFrames[0].t : 0;
    const drifts = frames.map((f) => f.elbowDrift);
    const sways = frames.map((f) => f.sway);
    const endAngle = frames[frames.length - 1].angle;
    return {
      n: this.reps.length + 1,
      tStart: c.tStart,
      duration: dur,
      concentric: Math.max(0, tMinRel - hold / 2),
      hold,
      eccentric: Math.max(0, dur - tMinRel - hold / 2),
      minAngle: +c.minAngle.toFixed(1),
      maxAngle: +Math.max(c.startAngle, endAngle).toFixed(1),
      rom: +(Math.max(c.startAngle, endAngle) - c.minAngle).toFixed(1),
      elbowDriftMean: +(drifts.reduce((a, b) => a + b, 0) / drifts.length).toFixed(3),
      elbowDriftMax: +Math.max(...drifts).toFixed(3),
      swayRange: +(Math.max(...sways) - Math.min(...sways)).toFixed(1),
      frames,
    };
  }

  startSet(t) {
    this.reps = [];
    this.frames = [];
    this._state = "idle";
    this._cur = null;
    this._bottomIdx = null;
    this._recentMax = this.angle ?? 170;
    this.active = true;
    this.startTime = t;
  }

  endSet() {
    // A rep that reached the top and is finishing its lower still counts.
    if (this._state === "ending" && this._cur) {
      this.reps.push(this._finishRep(this._cur, this._cur.endIdx));
    }
    this._state = "idle";
    this._cur = null;
    this.active = false;
    return { reps: this.reps, frames: this.frames };
  }
}
