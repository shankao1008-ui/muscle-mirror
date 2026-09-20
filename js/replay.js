// Side-by-side slow-motion replay of two reps using the virtual arm, with a
// scrubbable timeline and an angle-vs-time chart.

import { ArmRenderer } from "./arm.js";

export class Replay {
  constructor(els) {
    this.els = els;
    this.armA = new ArmRenderer(els.canvasA, { mode: "muscle" });
    this.armB = new ArmRenderer(els.canvasB, { mode: "muscle" });
    this.set = null;
    this.playing = false;
    this.progress = 0; // 0..1 of the longer rep
    this.speed = 0.5;
    this._raf = null;
    this._bind();
  }

  _bind() {
    const { els } = this;
    els.selA.addEventListener("change", () => this.select());
    els.selB.addEventListener("change", () => this.select());
    els.speed.addEventListener("change", () => (this.speed = +els.speed.value));
    els.play.addEventListener("click", () => (this.playing ? this.pause() : this.play()));
    els.timeline.addEventListener("input", () => {
      this.pause();
      this.progress = +els.timeline.value / 1000;
      this.render();
    });
    els.viewSeg.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        els.viewSeg.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        this.armA.setMode(b.dataset.mode); this.armB.setMode(b.dataset.mode);
        this.render();
      }),
    );
  }

  load(set, a = null, b = null) {
    this.set = set;
    const n = set.reps.length;
    for (const sel of [this.els.selA, this.els.selB]) {
      sel.innerHTML = "";
      for (let i = 1; i <= n; i++) sel.add(new Option(String(i), String(i)));
    }
    const half = Math.floor(n / 2);
    this.els.selA.value = String(a ?? Math.min(2, n));
    this.els.selB.value = String(b ?? Math.max(1, n - 1));
    this.armA.setSide(set.side); this.armB.setSide(set.side);
    this.armA.setWeight(set.weight); this.armB.setWeight(set.weight);
    void half;
    this.select();
  }

  select() {
    this.pause();
    const a = +this.els.selA.value, b = +this.els.selB.value;
    this.repA = this.set.reps[a - 1]; this.repB = this.set.reps[b - 1];
    this.els.labelA.textContent = `A：第 ${a} 次　幅度 ${this.repA.rom}°　抬起 ${(this.repA.concentric / 1000).toFixed(2)} s　放下 ${(this.repA.eccentric / 1000).toFixed(2)} s`;
    this.els.labelB.textContent = `B：第 ${b} 次　幅度 ${this.repB.rom}°　抬起 ${(this.repB.concentric / 1000).toFixed(2)} s　放下 ${(this.repB.eccentric / 1000).toFixed(2)} s`;
    this.maxDur = Math.max(this.repA.duration, this.repB.duration);
    this.progress = 0;
    this.renderDiff();
    this.render();
  }

  play() {
    this.playing = true;
    this.els.play.textContent = "❚❚ 暫停";
    let last = performance.now();
    const step = (now) => {
      if (!this.playing) return;
      const dt = (now - last) * this.speed; last = now;
      this.progress += dt / this.maxDur;
      if (this.progress >= 1) this.progress = 0;
      this.els.timeline.value = String(Math.round(this.progress * 1000));
      this.render();
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }
  pause() {
    this.playing = false;
    this.els.play.textContent = "▶ 播放";
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  frameAt(rep, tMs) {
    const fr = rep.frames;
    if (!fr.length) return { angle: rep.maxAngle, phase: "準備", elbowDrift: 0 };
    if (tMs >= rep.duration) return fr[fr.length - 1];
    let lo = 0, hi = fr.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (fr[m].t < tMs) lo = m + 1; else hi = m; }
    return fr[lo];
  }

  render() {
    if (!this.repA) return;
    const t = this.progress * this.maxDur;
    const fa = this.frameAt(this.repA, t), fb = this.frameAt(this.repB, t);
    const sub = (f, rep) => `t = ${(Math.min(t, rep.duration) / 1000).toFixed(2)} s　階段：${f.phase}　手肘位移 ${f.elbowDrift.toFixed(2)}`;
    this.armA.draw({ angle: fa.angle, phase: fa.phase, elbowDrift: fa.elbowDrift, title: `第 ${this.repA.n} 次　${Math.round(fa.angle)}°`, sub: sub(fa, this.repA) });
    this.armB.draw({ angle: fb.angle, phase: fb.phase, elbowDrift: fb.elbowDrift, title: `第 ${this.repB.n} 次　${Math.round(fb.angle)}°`, sub: sub(fb, this.repB) });
    this.renderChart(t);
  }

  renderChart(tNow) {
    const c = this.els.chart, ctx = c.getContext("2d");
    const W = (c.width = c.clientWidth * devicePixelRatio), H = (c.height = 160 * devicePixelRatio);
    ctx.clearRect(0, 0, W, H);
    const pad = 36 * devicePixelRatio;
    const x = (t) => pad + (t / this.maxDur) * (W - pad - 10);
    const y = (a) => H - 20 * devicePixelRatio - ((a - 20) / 160) * (H - 40 * devicePixelRatio);
    ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1;
    for (const a of [40, 80, 120, 160]) { ctx.beginPath(); ctx.moveTo(pad, y(a)); ctx.lineTo(W, y(a)); ctx.stroke(); }
    ctx.fillStyle = "#98a2b3"; ctx.font = `${11 * devicePixelRatio}px system-ui`; ctx.textAlign = "right";
    for (const a of [40, 80, 120, 160]) ctx.fillText(`${a}°`, pad - 6, y(a) + 4);
    const line = (rep, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2 * devicePixelRatio; ctx.beginPath();
      rep.frames.forEach((f, i) => (i ? ctx.lineTo(x(f.t), y(f.angle)) : ctx.moveTo(x(f.t), y(f.angle))));
      ctx.stroke();
    };
    line(this.repA, "#5eead4"); line(this.repB, "#f59e0b");
    ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.beginPath(); ctx.moveTo(x(tNow), 0); ctx.lineTo(x(tNow), H); ctx.stroke();
    ctx.textAlign = "left"; ctx.fillStyle = "#5eead4"; ctx.fillText(`A 第 ${this.repA.n} 次`, pad + 6, 14 * devicePixelRatio);
    ctx.fillStyle = "#f59e0b"; ctx.fillText(`B 第 ${this.repB.n} 次`, pad + 90 * devicePixelRatio, 14 * devicePixelRatio);
    ctx.fillStyle = "#98a2b3"; ctx.fillText("肘角 vs 時間", W - 110 * devicePixelRatio, 14 * devicePixelRatio);
  }

  renderDiff() {
    const a = this.repA, b = this.repB;
    const rows = [
      ["肘關節活動幅度", `${a.rom}°`, `${b.rom}°`, b.rom - a.rom, "°"],
      ["最小肘角（頂點）", `${a.minAngle}°`, `${b.minAngle}°`, b.minAngle - a.minAngle, "°"],
      ["抬起時間", s(a.concentric), s(b.concentric), (b.concentric - a.concentric) / 1000, " s"],
      ["停留時間", s(a.hold), s(b.hold), (b.hold - a.hold) / 1000, " s"],
      ["放下時間", s(a.eccentric), s(b.eccentric), (b.eccentric - a.eccentric) / 1000, " s"],
      ["手肘位移（平均）", a.elbowDriftMean.toFixed(2), b.elbowDriftMean.toFixed(2), b.elbowDriftMean - a.elbowDriftMean, ""],
      ["軀幹晃動範圍", `${a.swayRange}°`, `${b.swayRange}°`, b.swayRange - a.swayRange, "°"],
    ];
    this.els.diff.innerHTML = `<table class="cmp"><thead><tr><th>指標</th><th>A 第 ${a.n} 次</th><th>B 第 ${b.n} 次</th><th>B − A</th></tr></thead><tbody>` +
      rows.map(([l, va, vb, d, u]) => `<tr><td>${l}</td><td>${va}</td><td>${vb}</td><td class="${d > 0.005 ? "up" : d < -0.005 ? "down" : "flat"}">${d > 0 ? "+" : ""}${d.toFixed(2)}${u}</td></tr>`).join("") +
      `</tbody></table><p class="muted">「哪個階段開始與前段不同」：拖曳時間軸，觀察兩條曲線分開的位置。</p>`;
    function s(ms) { return (ms / 1000).toFixed(2) + " s"; }
  }
}
