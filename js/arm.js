// Virtual arm renderer — layered anatomical illustration driven by the
// measured elbow angle. Three views: muscle | skeleton | mechanics.
//
// Everything drawn here is a SIMULATION. Muscle colour intensity encodes the
// expected role of each muscle in the movement model for the current phase.
// It is not a measurement of activation, force, or size.

const G = 9.81;
const FOREARM_M = 0.27; // metres, assumed forearm+hand lever length for the torque sketch

const V = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  mul: (a, k) => ({ x: a.x * k, y: a.y * k }),
  len: (a) => Math.hypot(a.x, a.y),
  dot: (a, b) => a.x * b.x + a.y * b.y,
  norm: (a) => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; },
  perp: (a) => ({ x: -a.y, y: a.x }),
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
  rot: (a, r) => ({ x: a.x * Math.cos(r) - a.y * Math.sin(r), y: a.x * Math.sin(r) + a.y * Math.cos(r) }),
};

const C = {
  bg0: "#0b1018", bg1: "#141b26",
  grid: "rgba(120,140,170,0.07)",
  bone: "#eae3d3", boneShade: "#b8ab92", boneLine: "rgba(60,50,40,0.45)",
  tendon: "#e6dfcc",
  skin: "rgba(255,255,255,0.05)",
  label: "rgba(230,236,244,0.94)", sub: "rgba(150,163,182,0.92)", leader: "rgba(200,210,225,0.45)",
  accent: "#5eead4", warn: "#f59e0b", blue: "#7aa2f7", red: "#ef6f6c",
};

// Muscle colour ramp (idle → fully expected participation).
function muscleColor(k, alpha = 1) {
  const lo = [116, 74, 72], mid = [176, 64, 58], hi = [232, 104, 92];
  const t = Math.max(0, Math.min(1, k));
  const m = t < 0.5 ? mix(lo, mid, t * 2) : mix(mid, hi, (t - 0.5) * 2);
  return `rgba(${m[0]},${m[1]},${m[2]},${alpha})`;
}
function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
function shade(rgba, f) { // darken/lighten an rgba() string
  const m = rgba.match(/[\d.]+/g).map(Number);
  const k = f < 0 ? 1 + f : 1;
  const add = f > 0 ? 255 * f : 0;
  return `rgba(${Math.round(m[0] * k + add * (1 - m[0] / 255))},${Math.round(m[1] * k + add * (1 - m[1] / 255))},${Math.round(m[2] * k + add * (1 - m[2] / 255))},${m[3] ?? 1})`;
}

// Expected participation (0..1) per muscle for a curl, by phase. Model, not measurement.
export function expectedRoles(phase, loaded = true) {
  const con = phase === "抬起", hold = phase === "停留", ecc = phase === "放下";
  return {
    biceps: con ? 1 : hold ? 0.85 : ecc ? 0.65 : 0.18,
    brachialis: con ? 0.9 : hold ? 0.8 : ecc ? 0.6 : 0.18,
    brachioradialis: con ? 0.6 : hold ? 0.5 : ecc ? 0.4 : 0.12,
    flexors: loaded ? 0.38 : 0.12,
    extensors: loaded ? 0.22 : 0.08,
    triceps: ecc ? 0.28 : con ? 0.1 : 0.08,
    deltoid: con || hold ? 0.28 : 0.15,
  };
}
const ROLE_TEXT = {
  biceps: { zh: "肱二頭肌", la: "Biceps brachii", role: (p) => p === "抬起" ? "主動肌・向心收縮" : p === "停留" ? "主動肌・等長維持" : p === "放下" ? "主動肌・離心控制" : "主動肌（預期）" },
  brachialis: { zh: "肱肌", la: "Brachialis", role: () => "主動肌・深層屈肘" },
  brachioradialis: { zh: "肱橈肌", la: "Brachioradialis", role: () => "協同肌" },
  flexors: { zh: "前臂屈肌群", la: "Forearm flexors", role: () => "協同・握持穩定" },
  extensors: { zh: "前臂伸肌群", la: "Forearm extensors", role: () => "腕部穩定" },
  triceps: { zh: "肱三頭肌", la: "Triceps brachii", role: (p) => p === "放下" ? "拮抗肌・控制放下" : "拮抗肌" },
  deltoid: { zh: "三角肌", la: "Deltoid", role: () => "肩部穩定" },
};

export class ArmRenderer {
  constructor(canvas, opts = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d");
    this.mode = opts.mode || "muscle";
    this.side = opts.side || "right";
    this.weightKg = opts.weightKg ?? 6;
    this.showLabels = opts.showLabels ?? true;
    this.aspect = opts.aspect ?? 0.8; // W / H
  }
  setMode(m) { this.mode = m; }
  setSide(s) { this.side = s; }
  setWeight(w) { this.weightKg = w; }

  _fit() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const cssW = this.c.clientWidth || this.c.width / dpr || 420;
    const cssH = this.c.clientHeight || Math.round(cssW / this.aspect);
    const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
    if (this.c.width !== pw || this.c.height !== ph) { this.c.width = pw; this.c.height = ph; }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = cssW; this.H = cssH;
  }

  // state: {angle (deg), phase, elbowDrift, title?, sub?, loaded?}
  draw(state) {
    this._fit();
    const { ctx, W, H } = this;
    const angle = Math.max(28, Math.min(178, state.angle ?? 170));
    const flex = 1 - (angle - 28) / 150; // 0 extended → 1 flexed
    const phase = state.phase || "準備";
    const mirror = this.side === "left" ? -1 : 1;
    const roles = expectedRoles(phase, state.loaded ?? true);

    this._background();

    // ---- geometry ----
    const upper = H * 0.34, fore = H * 0.30;
    const R = H * 0.062, r = H * 0.046; // limb radii
    const S = { x: W * 0.5 - mirror * W * 0.07, y: H * 0.21 };
    const driftPx = Math.min(0.35, state.elbowDrift || 0) * upper * 0.8;
    const E = { x: S.x + mirror * driftPx, y: S.y + Math.sqrt(Math.max(0, upper * upper - driftPx * driftPx)) };
    const uU = V.norm(V.sub(E, S));
    let nU = V.perp(uU); if (nU.x * mirror < 0) nU = V.mul(nU, -1); // anterior side of the upper arm
    const back = V.mul(uU, -1); // direction E→S
    const th = (angle * Math.PI) / 180;
    const c1 = V.rot(back, th), c2 = V.rot(back, -th);
    const uF = V.dot(c1, nU) >= V.dot(c2, nU) ? c1 : c2; // forearm folds toward the front
    const Wr = V.add(E, V.mul(uF, fore));
    const bis = V.add(back, uF);
    let nF = V.perp(uF);
    if (V.len(bis) > 0.05 ? V.dot(nF, bis) < 0 : V.dot(nF, nU) < 0) nF = V.mul(nF, -1); // anterior forearm
    const pU = (t, off = 0) => V.add(V.add(S, V.mul(uU, upper * t)), V.mul(nU, R * off));
    const pF = (t, off = 0) => V.add(V.add(E, V.mul(uF, fore * t)), V.mul(nF, r * off));
    const g = { S, E, Wr, uU, nU, uF, nF, pU, pF, R, r, flex, upper, fore, mirror };

    this._torso(g);

    if (this.mode === "skeleton") {
      this._bones(g, 1);
      this._angleArc(g, angle);
      this._hand(g, 0.35);
      if (this.showLabels) this._boneLabels(g);
    } else if (this.mode === "mechanics") {
      this._bones(g, 0.9);
      this._hand(g, 0.5);
      this._mechanics(g, angle, uF);
    } else {
      this._bones(g, 0.28);
      const anchors = this._muscles(g, roles, phase);
      this._hand(g, 1);
      if (this.showLabels) this._muscleLabels(g, anchors, roles, phase);
      this._roleScale();
    }

    this._hud(state, angle, phase);
  }

  // ---------- background & HUD ----------
  _background() {
    const { ctx, W, H } = this;
    const grad = ctx.createRadialGradient(W * 0.5, H * 0.35, H * 0.1, W * 0.5, H * 0.5, H * 0.9);
    grad.addColorStop(0, C.bg1); grad.addColorStop(1, C.bg0);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    const step = Math.max(24, Math.round(H / 16));
    ctx.beginPath();
    for (let x = (W % step) / 2; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 0; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }

  _hud(state, angle, phase) {
    const { ctx, W } = this;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = C.label; ctx.font = "700 22px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillText(state.title ?? `${Math.round(angle)}°`, 18, 34);
    ctx.fillStyle = C.sub; ctx.font = "500 12.5px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(state.sub ?? `肘關節角度 · 階段：${phase}`, 18, 54);
    // simulation stamp
    ctx.textAlign = "right";
    const label = "模擬 SIMULATION";
    ctx.font = "700 10.5px ui-sans-serif, system-ui, sans-serif";
    const tw = ctx.measureText(label).width + 16;
    ctx.strokeStyle = C.warn; ctx.lineWidth = 1; ctx.fillStyle = "rgba(245,158,11,0.10)";
    roundRect(ctx, W - 18 - tw, 18, tw, 20, 5); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.warn; ctx.fillText(label, W - 26, 32);
    ctx.textAlign = "left";
  }

  _torso(g) {
    const { ctx, W, H } = this;
    const { S, mirror, R } = g;
    // lateral torso silhouette behind the shoulder
    ctx.save();
    ctx.fillStyle = C.skin;
    ctx.beginPath();
    const x0 = S.x - mirror * R * 0.9;
    ctx.moveTo(x0, S.y - R * 1.6);
    ctx.bezierCurveTo(x0 - mirror * W * 0.16, S.y - R * 0.6, x0 - mirror * W * 0.2, H * 0.55, x0 - mirror * W * 0.16, H * 0.9);
    ctx.lineTo(x0 + mirror * R * 0.3, H * 0.9);
    ctx.bezierCurveTo(x0 + mirror * R * 0.1, H * 0.6, x0 + mirror * R * 0.4, S.y + R * 1.5, x0 + mirror * R * 0.6, S.y - R * 1.2);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // ---------- bones ----------
  _bones(g, alpha) {
    const { ctx } = this;
    const { pU, pF, R, r } = g;
    ctx.save(); ctx.globalAlpha = alpha;
    // humerus
    this._boneShaft(pU(0.06), pU(0.94), R * 0.42, R * 0.36);
    this._boneKnob(pU(-0.02, -0.05), R * 0.5);               // head
    this._boneKnob(pU(0.98, 0.28), R * 0.26);                // capitulum (anterior)
    this._boneKnob(pU(0.99, -0.26), R * 0.28);               // medial epicondyle (posterior in this view)
    // ulna with olecranon hook behind the elbow
    this._boneShaft(pF(0.02, -0.28), pF(1.0, -0.12), r * 0.3, r * 0.22);
    this._boneKnob(pF(-0.06, -0.32), r * 0.3);
    // radius
    this._boneShaft(pF(0.1, 0.3), pF(1.0, 0.2), r * 0.22, r * 0.28);
    this._boneKnob(pF(0.1, 0.3), r * 0.24);
    // carpals
    for (const [t, o] of [[1.05, 0.15], [1.05, -0.12], [1.12, 0.02]]) this._boneKnob(pF(t, o), r * 0.15);
    ctx.restore();
  }
  _boneShaft(a, b, w0, w1) {
    const { ctx } = this;
    const u = V.norm(V.sub(b, a)), n = V.perp(u);
    const grad = ctx.createLinearGradient(a.x - n.x * w0, a.y - n.y * w0, a.x + n.x * w0, a.y + n.y * w0);
    grad.addColorStop(0, C.boneShade); grad.addColorStop(0.45, C.bone); grad.addColorStop(1, C.boneShade);
    ctx.fillStyle = grad; ctx.strokeStyle = C.boneLine; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a.x + n.x * w0, a.y + n.y * w0);
    ctx.bezierCurveTo(V.lerp(a, b, 0.3).x + n.x * w0 * 0.7, V.lerp(a, b, 0.3).y + n.y * w0 * 0.7, V.lerp(a, b, 0.7).x + n.x * w1 * 0.7, V.lerp(a, b, 0.7).y + n.y * w1 * 0.7, b.x + n.x * w1, b.y + n.y * w1);
    ctx.arc(b.x, b.y, w1, Math.atan2(n.y, n.x), Math.atan2(-n.y, -n.x), false);
    ctx.bezierCurveTo(V.lerp(a, b, 0.7).x - n.x * w1 * 0.7, V.lerp(a, b, 0.7).y - n.y * w1 * 0.7, V.lerp(a, b, 0.3).x - n.x * w0 * 0.7, V.lerp(a, b, 0.3).y - n.y * w0 * 0.7, a.x - n.x * w0, a.y - n.y * w0);
    ctx.arc(a.x, a.y, w0, Math.atan2(-n.y, -n.x), Math.atan2(n.y, n.x), false);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  _boneKnob(p, rad) {
    const { ctx } = this;
    const grad = ctx.createRadialGradient(p.x - rad * 0.3, p.y - rad * 0.3, rad * 0.1, p.x, p.y, rad);
    grad.addColorStop(0, "#f6f1e6"); grad.addColorStop(1, C.boneShade);
    ctx.fillStyle = grad; ctx.strokeStyle = C.boneLine; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  _boneLabels(g) {
    const items = [
      { zh: "肱骨", la: "Humerus", p: g.pU(0.45, -0.2), side: -1 },
      { zh: "肩關節", la: "Glenohumeral joint", p: g.pU(0, 0), side: 1 },
      { zh: "肘關節（樞紐）", la: "Elbow · hinge", p: g.E, side: -1 },
      { zh: "尺骨", la: "Ulna", p: g.pF(0.55, -0.25), side: -1 },
      { zh: "橈骨", la: "Radius", p: g.pF(0.55, 0.3), side: 1 },
    ];
    this._leaderLabels(items.map((i) => ({ ...i, sub: i.la })));
  }
  _angleArc(g, angle) {
    const { ctx } = this;
    const { E, uU, uF, R } = g;
    const a1 = Math.atan2(-uU.y, -uU.x), a2 = Math.atan2(uF.y, uF.x);
    let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(E.x, E.y, R * 1.1, a1, a1 + d, d < 0); ctx.stroke();
    const mid = a1 + d / 2;
    ctx.fillStyle = C.accent; ctx.font = "700 15px ui-sans-serif, system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`${Math.round(angle)}°`, E.x + Math.cos(mid) * R * 1.75, E.y + Math.sin(mid) * R * 1.75 + 5);
    ctx.textAlign = "left";
  }

  // ---------- muscles ----------
  _muscles(g, roles, phase) {
    const { pU, pF, R, r, flex } = g;
    const A = {};
    // posterior forearm (extensors) — deepest in this view
    A.extensors = this._spindle(pF(0.04, -0.34), pF(0.9, -0.18), { w: r * 0.55, shift: -r * 0.12, k: roles.extensors, tendon: [0.1, 0.22] });
    // triceps
    A.triceps = this._spindle(pU(0.03, -0.5), pU(1.0, -0.32), { w: R * (0.68 - 0.1 * flex), shift: -R * 0.12, k: roles.triceps, tendon: [0.08, 0.26], center: 0.42 });
    // brachialis (deep, distal anterior humerus) + tendon to the ulna
    A.brachialis = this._spindle(pU(0.42, 0.3), pU(0.98, 0.34), { w: R * 0.5, shift: R * 0.05, k: roles.brachialis, tendon: [0.12, 0.08], center: 0.55 });
    this._tendon(pU(0.98, 0.34), pF(0.1, 0.3), r * 0.2);
    // forearm flexors (anterior forearm)
    A.flexors = this._spindle(pF(0.03, 0.26), pF(0.9, 0.14), { w: r * 0.72, shift: r * 0.14, k: roles.flexors, tendon: [0.08, 0.25], center: 0.42 });
    // brachioradialis — lateral, crosses the elbow
    A.brachioradialis = this._spindle(pU(0.88, 0.48), pF(0.92, 0.36), { w: r * 0.5, shift: r * 0.05, k: roles.brachioradialis, tendon: [0.05, 0.35], center: 0.35 });
    // biceps brachii: belly on the upper arm, distal tendon across the crease to the radial tuberosity
    const bicepsEnd = pU(0.9 - 0.06 * flex, 0.42);
    this._tendon(bicepsEnd, pF(0.15, 0.28), r * 0.22);
    A.biceps = this._spindle(pU(0.02, 0.42), bicepsEnd, {
      w: R * (0.6 + 0.48 * flex), shift: R * (0.16 + 0.38 * flex), k: roles.biceps,
      tendon: [0.2, 0.1], center: 0.5 - 0.06 * flex, fibres: 7,
    });
    // deltoid cap over the shoulder
    A.deltoid = this._spindle(pU(-0.2, 0.05), pU(0.4, 0.02), { w: R * 1.05, shift: 0, k: roles.deltoid, tendon: [0.05, 0.18], center: 0.3, fibres: 6 });
    return A;
  }

  // Spindle-shaped muscle belly between a and b. Returns an anchor point for labelling.
  _spindle(a, b, o) {
    const { ctx } = this;
    const d = V.sub(b, a), L = V.len(d), u = V.norm(d);
    let n = V.perp(u);
    // orient n so that positive shift goes to the "outer" (anterior/posterior) side chosen by sign of shift
    const center = o.center ?? 0.5, w = o.w, shift = o.shift ?? 0, k = o.k ?? 0.2;
    const off = (f) => V.add(V.mul(n, shift + w * f), { x: 0, y: 0 });
    const path = () => {
      const c1 = V.add(V.add(a, V.mul(u, L * Math.max(0.05, center - 0.25))), off(1));
      const c2 = V.add(V.add(a, V.mul(u, L * Math.min(0.95, center + 0.25))), off(1));
      const c3 = V.add(V.add(a, V.mul(u, L * Math.min(0.95, center + 0.25))), off(-1));
      const c4 = V.add(V.add(a, V.mul(u, L * Math.max(0.05, center - 0.25))), off(-1));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
      ctx.bezierCurveTo(c3.x, c3.y, c4.x, c4.y, a.x, a.y);
      ctx.closePath();
    };
    // tendons (drawn under the belly, visible at the tapered ends)
    const [tA, tB] = o.tendon || [0.1, 0.1];
    this._tendon(a, V.add(V.lerp(a, b, tA), V.mul(n, shift * 0.6)), w * 0.35);
    this._tendon(V.add(V.lerp(a, b, 1 - tB), V.mul(n, shift * 0.6)), b, w * 0.35);

    const base = muscleColor(k);
    const mid = V.add(V.lerp(a, b, center), V.mul(n, shift));
    const g1 = V.add(mid, V.mul(n, -w * 0.8)), g2 = V.add(mid, V.mul(n, w * 0.8));
    const grad = ctx.createLinearGradient(g1.x, g1.y, g2.x, g2.y);
    grad.addColorStop(0, shade(base, -0.45));
    grad.addColorStop(0.3, base);
    grad.addColorStop(0.55, shade(base, 0.18));
    grad.addColorStop(1, shade(base, -0.35));
    ctx.save();
    if (k > 0.45) { ctx.shadowColor = `rgba(239,111,108,${(k - 0.45) * 0.9})`; ctx.shadowBlur = 10 + 22 * k; }
    path(); ctx.fillStyle = grad; ctx.fill();
    ctx.restore();
    // fibre striations following the belly curvature
    ctx.save(); path(); ctx.clip();
    const N = o.fibres ?? 5;
    for (let i = 0; i < N; i++) {
      const f = ((i + 0.5) / N) * 2 - 1;
      const p1 = V.add(V.add(a, V.mul(u, L * Math.max(0.05, center - 0.25))), off(f * 0.95));
      const p2 = V.add(V.add(a, V.mul(u, L * Math.min(0.95, center + 0.25))), off(f * 0.95));
      ctx.strokeStyle = i % 2 ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.16)";
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, b.x, b.y); ctx.stroke();
    }
    // specular ridge
    const s1 = V.add(V.add(a, V.mul(u, L * Math.max(0.05, center - 0.25))), off(0.35));
    const s2 = V.add(V.add(a, V.mul(u, L * Math.min(0.95, center + 0.25))), off(0.35));
    ctx.strokeStyle = "rgba(255,255,255,0.14)"; ctx.lineWidth = w * 0.22;
    ctx.beginPath(); ctx.moveTo(V.lerp(a, b, 0.15).x, V.lerp(a, b, 0.15).y); ctx.bezierCurveTo(s1.x, s1.y, s2.x, s2.y, V.lerp(a, b, 0.85).x, V.lerp(a, b, 0.85).y); ctx.stroke();
    ctx.restore();
    // outline
    ctx.save(); path(); ctx.strokeStyle = "rgba(40,14,12,0.55)"; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
    return mid;
  }
  _tendon(a, b, w) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = C.tendon; ctx.lineWidth = w; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = "rgba(90,80,60,0.35)"; ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // ---------- hand & dumbbell (side view: plates seen end-on) ----------
  _hand(g, alpha) {
    const { ctx } = this;
    const { pF, uF, nF, r } = g;
    ctx.save(); ctx.globalAlpha = alpha;
    const hc = pF(1.1, 0.02);
    const ang = Math.atan2(uF.y, uF.x);
    // fist
    ctx.fillStyle = "#4a5568"; ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.lineWidth = 1;
    ctx.save(); ctx.translate(hc.x, hc.y); ctx.rotate(ang);
    roundRect(ctx, -r * 0.55, -r * 0.9, r * 1.35, r * 1.8, r * 0.45); ctx.fill(); ctx.stroke();
    // knuckle lines
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(r * 0.2, i * r * 0.45 - r * 0.1); ctx.lineTo(r * 0.75, i * r * 0.45 - r * 0.1); ctx.stroke(); }
    ctx.restore();
    // dumbbell plate (end-on), slightly in front of the fist
    const pc = pF(1.12, 0.05);
    const pr = r * 1.15 + Math.min(12, this.weightKg * 0.6);
    const grad = ctx.createRadialGradient(pc.x - pr * 0.3, pc.y - pr * 0.3, pr * 0.1, pc.x, pc.y, pr);
    grad.addColorStop(0, "#5b6474"); grad.addColorStop(0.7, "#2f3745"); grad.addColorStop(1, "#1a1f27");
    ctx.fillStyle = grad; ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(pc.x, pc.y, pr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.beginPath(); ctx.arc(pc.x, pc.y, pr * 0.72, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#8a94a6"; ctx.beginPath(); ctx.arc(pc.x, pc.y, pr * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(226,232,240,0.9)"; ctx.font = "700 11px ui-sans-serif, system-ui, sans-serif";
    const right = pc.x < this.W * 0.6;
    ctx.textAlign = right ? "left" : "right";
    ctx.fillText(`${this.weightKg} kg`, pc.x + (right ? pr + 8 : -pr - 8), pc.y + 4);
    ctx.textAlign = "left";
    void nF;
    ctx.restore();
  }

  // ---------- labels ----------
  _muscleLabels(g, anchors, roles, phase) {
    const items = [
      { key: "deltoid", side: -1 }, { key: "triceps", side: -1 }, { key: "extensors", side: -1 },
      { key: "biceps", side: 1 }, { key: "brachialis", side: 1 }, { key: "brachioradialis", side: 1 }, { key: "flexors", side: 1 },
    ].map((it) => ({
      p: anchors[it.key], side: it.side * g.mirror,
      zh: ROLE_TEXT[it.key].zh, sub: `${ROLE_TEXT[it.key].la} · ${ROLE_TEXT[it.key].role(phase)}`,
      k: roles[it.key],
    }));
    this._leaderLabels(items);
  }
  _leaderLabels(items) {
    const { ctx, W, H } = this;
    const margin = 14, colW = W * 0.3, gap = 30;
    for (const side of [-1, 1]) {
      const list = items.filter((i) => i.side === side).sort((a, b) => a.p.y - b.p.y);
      // stagger to avoid overlap
      let y = Math.max(78, list.length ? list[0].p.y - 10 : 0);
      for (const it of list) { it.ly = Math.max(y, it.p.y - 12); y = it.ly + gap; }
      const over = list.length ? list[list.length - 1].ly + 12 - (H - 70) : 0;
      if (over > 0) for (const it of list) it.ly -= over;
      for (const it of list) {
        const lx = side < 0 ? margin : W - margin;
        const bend = side < 0 ? Math.min(margin + colW, it.p.x - 14) : Math.max(W - margin - colW, it.p.x + 14);
        ctx.strokeStyle = C.leader; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(it.p.x, it.p.y); ctx.lineTo(bend, it.ly); ctx.lineTo(lx, it.ly); ctx.stroke();
        ctx.fillStyle = it.k != null ? muscleColor(it.k) : C.accent;
        ctx.beginPath(); ctx.arc(it.p.x, it.p.y, 3, 0, Math.PI * 2); ctx.fill();
        // text with translucent backing so it stays legible over the limb
        ctx.font = "700 12.5px ui-sans-serif, system-ui, sans-serif";
        const w1 = ctx.measureText(it.zh).width;
        ctx.font = "500 10px ui-sans-serif, system-ui, sans-serif";
        const w2 = ctx.measureText(it.sub).width;
        const bw = Math.max(w1, w2) + 10, bx = side < 0 ? lx - 4 : lx - bw + 4;
        ctx.fillStyle = "rgba(11,16,24,0.72)";
        roundRect(ctx, bx, it.ly - 17, bw, 30, 4); ctx.fill();
        ctx.textAlign = side < 0 ? "left" : "right";
        ctx.fillStyle = C.label; ctx.font = "700 12.5px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(it.zh, lx, it.ly - 4);
        ctx.fillStyle = C.sub; ctx.font = "500 10px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(it.sub, lx, it.ly + 9);
      }
    }
    ctx.textAlign = "left";
  }
  _roleScale() {
    const { ctx, W, H } = this;
    const x = 18, y = H - 30, w = Math.min(180, W * 0.42), h = 8;
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    for (let i = 0; i <= 4; i++) grad.addColorStop(i / 4, muscleColor(i / 4));
    ctx.fillStyle = grad; roundRect(ctx, x, y, w, h, 4); ctx.fill();
    ctx.fillStyle = C.sub; ctx.font = "500 10.5px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("低", x, y - 5); ctx.textAlign = "right"; ctx.fillText("高", x + w, y - 5); ctx.textAlign = "left";
    ctx.fillText("預期參與程度（動作模型）— 非量測活化", x + w + 10, y + 8);
  }

  // ---------- mechanics (free-body diagram) ----------
  _mechanics(g, angle, uF) {
    const { ctx, W, H } = this;
    const { E, pF, r, R } = g;
    const pc = pF(1.12, 0.05); // load centre (dumbbell)
    const cosPhi = Math.abs(Math.cos(Math.atan2(uF.y, uF.x)));
    const phiDeg = Math.round((Math.acos(Math.min(1, cosPhi)) * 180) / Math.PI);
    const lever = FOREARM_M * cosPhi;
    const torque = this.weightKg * G * lever;
    const maxT = this.weightKg * G * FOREARM_M || 1;
    const frac = torque / maxT;

    // pivot marker
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2; ctx.fillStyle = "rgba(94,234,212,0.15)";
    ctx.beginPath(); ctx.arc(E.x, E.y, R * 0.35, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(E.x, E.y, 3, 0, Math.PI * 2); ctx.fillStyle = C.accent; ctx.fill();

    // lever arm (horizontal distance from pivot to the load line)
    ctx.setLineDash([5, 5]); ctx.strokeStyle = "rgba(94,234,212,0.85)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(E.x, E.y); ctx.lineTo(pc.x, E.y); ctx.stroke();
    ctx.strokeStyle = "rgba(245,158,11,0.5)";
    ctx.beginPath(); ctx.moveTo(pc.x, E.y - 6); ctx.lineTo(pc.x, pc.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.accent; ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`d = L·cos φ ≈ ${(lever * 100).toFixed(0)} cm`, (E.x + pc.x) / 2, E.y - 8);

    // gravity vector on the load
    const gl = 34 + 46 * Math.min(1, this.weightKg / 20);
    arrow(ctx, pc, { x: pc.x, y: pc.y + gl }, C.warn, 3);
    ctx.fillStyle = C.warn;
    const roomRight = pc.x < W - 110;
    ctx.textAlign = roomRight ? "left" : "right";
    ctx.fillText(`F = m·g = ${(this.weightKg * G).toFixed(0)} N`, pc.x + (roomRight ? 10 : -10), pc.y + gl);
    ctx.textAlign = "left";

    // φ: forearm angle from horizontal
    const a0 = uF.x >= 0 ? 0 : Math.PI, a1 = Math.atan2(uF.y, uF.x);
    ctx.strokeStyle = "rgba(226,232,240,0.6)"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(E.x, E.y, R * 0.9, Math.min(a0, a1), Math.max(a0, a1)); ctx.stroke();
    ctx.fillStyle = "rgba(226,232,240,0.85)";
    ctx.fillText(`φ = ${phiDeg}°`, E.x + R * 1.0 * (uF.x >= 0 ? 1 : -1) - (uF.x >= 0 ? 0 : 44), E.y + (a1 < 0 ? -R * 0.9 : R * 1.05));

    // torque arc at the pivot (flexor moment needed to balance)
    ctx.strokeStyle = `rgba(239,111,108,${0.45 + 0.55 * frac})`; ctx.lineWidth = 5 + 8 * frac; ctx.lineCap = "round";
    const start = Math.PI * 0.6, sweep = Math.PI * (0.25 + 0.9 * frac);
    ctx.beginPath(); ctx.arc(E.x, E.y, R * 1.45, start, start + sweep * (g.mirror > 0 ? 1 : -1), g.mirror < 0); ctx.stroke();
    ctx.lineCap = "butt";

    // readout panel
    const px = 18, py = 68, pw = Math.min(250, W * 0.6);
    ctx.fillStyle = "rgba(15,20,28,0.78)"; ctx.strokeStyle = "rgba(94,234,212,0.35)"; ctx.lineWidth = 1;
    roundRect(ctx, px, py, pw, 92, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.label; ctx.font = "700 18px ui-sans-serif, system-ui, sans-serif"; ctx.textAlign = "left";
    ctx.fillText(`外力矩 τ ≈ ${torque.toFixed(1)} N·m`, px + 12, py + 26);
    ctx.fillStyle = C.sub; ctx.font = "500 11px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(`τ = m·g·L·cos φ`, px + 12, py + 46);
    ctx.fillText(`= ${this.weightKg} × 9.81 × ${FOREARM_M} × cos ${phiDeg}°`, px + 12, py + 61);
    ctx.fillStyle = "rgba(245,158,11,0.9)";
    ctx.fillText("簡化外部負荷示意，不代表肌肉真實出力", px + 12, py + 80);

    // inset: torque vs elbow angle
    const iw = Math.min(200, W * 0.46), ih = 86, ix = W - iw - 16, iy = H - ih - 18;
    ctx.fillStyle = "rgba(15,20,28,0.78)"; ctx.strokeStyle = "rgba(120,140,170,0.3)";
    roundRect(ctx, ix, iy, iw, ih, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.sub; ctx.font = "500 10px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("外力矩 vs 肘角（同一站姿）", ix + 10, iy + 14);
    const X = (a) => ix + 10 + ((a - 28) / 150) * (iw - 20), Y = (t) => iy + ih - 12 - (t / maxT) * (ih - 34);
    ctx.strokeStyle = "rgba(239,111,108,0.9)"; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let a = 28; a <= 178; a += 3) {
      const t = this._torqueAt(g, a);
      a === 28 ? ctx.moveTo(X(a), Y(t)) : ctx.lineTo(X(a), Y(t));
    }
    ctx.stroke();
    ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(X(angle), Y(torque), 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.sub; ctx.fillText("30°", ix + 8, iy + ih - 2); ctx.textAlign = "right"; ctx.fillText("180°", ix + iw - 8, iy + ih - 2); ctx.textAlign = "left";
  }
  _torqueAt(g, angleDeg) {
    const back = V.mul(g.uU, -1);
    const th = (angleDeg * Math.PI) / 180;
    const c1 = V.rot(back, th), c2 = V.rot(back, -th);
    const uF = V.dot(c1, g.nU) >= V.dot(c2, g.nU) ? c1 : c2;
    return this.weightKg * G * FOREARM_M * Math.abs(Math.cos(Math.atan2(uF.y, uF.x)));
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
function arrow(ctx, a, b, color, w) {
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  const u = V.norm(V.sub(b, a)), n = V.perp(u);
  ctx.beginPath(); ctx.moveTo(b.x + u.x * 8, b.y + u.y * 8);
  ctx.lineTo(b.x - u.x * 4 + n.x * 6, b.y - u.y * 4 + n.y * 6);
  ctx.lineTo(b.x - u.x * 4 - n.x * 6, b.y - u.y * 4 - n.y * 6); ctx.closePath(); ctx.fill();
}
