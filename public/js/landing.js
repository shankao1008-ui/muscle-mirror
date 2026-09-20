// Landing page: animated hero arm (synthetic curl cycle) + three static views.
import { ArmRenderer } from "./arm.js";

const $ = (id) => document.getElementById(id);
const hero = new ArmRenderer($("hero-arm"), { mode: "muscle", weightKg: 6 });
const views = [
  new ArmRenderer($("view-muscle"), { mode: "muscle", weightKg: 6 }),
  new ArmRenderer($("view-skeleton"), { mode: "skeleton", weightKg: 6 }),
  new ArmRenderer($("view-mechanics"), { mode: "mechanics", weightKg: 6 }),
];

$("hero-view").querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => {
    $("hero-view").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); hero.setMode(b.dataset.mode);
  }),
);

// Curl cycle (ms): concentric, hold, eccentric, rest. Later reps slow down a
// little and lose range, mirroring the kind of change the app surfaces.
const CON = 1000, HOLD = 400, ECC = 1300, REST = 700;
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
let reps = 0, lastCycle = -1;
function sample(tMs) {
  const cycle = Math.floor(tMs / (CON + HOLD + ECC + REST));
  const fatigue = Math.min(1, (cycle % 8) / 7);
  const con = CON * (1 + 0.35 * fatigue), ecc = ECC * (1 - 0.15 * fatigue);
  const total = con + HOLD + ecc + REST;
  const t = tMs % (CON + HOLD + ECC + REST) * (total / (CON + HOLD + ECC + REST));
  const top = 48 + 16 * fatigue, bottom = 168;
  let angle, phase;
  if (t < con) { angle = bottom - (bottom - top) * ease(t / con); phase = "抬起"; }
  else if (t < con + HOLD) { angle = top; phase = "停留"; }
  else if (t < con + HOLD + ecc) { angle = top + (bottom - top) * ease((t - con - HOLD) / ecc); phase = "放下"; }
  else { angle = bottom; phase = "準備"; }
  if (cycle !== lastCycle) { lastCycle = cycle; reps = (cycle % 8) + (cycle % 8 === 0 ? 0 : 0); }
  return { angle, phase, con, ecc, rep: (cycle % 8) + (t >= con + HOLD + ecc ? 1 : 0) };
}

let start = performance.now(), visible = true;
function frame(now) {
  if (visible) {
    const s = sample(now - start);
    hero.draw({ angle: s.angle, phase: s.phase, elbowDrift: 0.02 + 0.08 * Math.min(1, ((Math.floor((now - start) / 3400)) % 8) / 7) });
    $("hero-angle").textContent = `${Math.round(s.angle)}°`;
    $("hero-phase").textContent = s.phase;
    $("hero-reps").textContent = String(s.rep);
    $("hero-tempo").textContent = `${(s.con / 1000).toFixed(1)}↑ ${(s.ecc / 1000).toFixed(1)}↓`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
document.addEventListener("visibilitychange", () => (visible = !document.hidden));

function drawViews() {
  views[0].draw({ angle: 78, phase: "抬起" });
  views[1].draw({ angle: 78, phase: "抬起" });
  views[2].draw({ angle: 78, phase: "抬起" });
}
drawViews();
window.addEventListener("resize", drawViews);
