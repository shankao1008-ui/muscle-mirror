// Muscle Mirror — static server + optional Fable (Claude) summary/Q&A routes.
//
// Fable never sees video frames. It only receives the structured motion data
// computed in the browser (angles, timings, per-rep metrics, self-ratings) and
// writes a grounded summary or answers a question about the set.
//
// If no Anthropic credential is available, /api/* returns 503 and the browser
// falls back to its built-in rule-based summary (clearly labelled as such).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
const PORT = Number(process.env.PORT || 5173);
const MODEL = process.env.MM_MODEL || "claude-fable-5-1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const hasCredential = Boolean(
  process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    fs.existsSync(path.join(process.env.HOME || "", ".config/anthropic")),
);
const client = hasCredential ? new Anthropic() : null;

const SYSTEM = `你是 Muscle Mirror 健身 App 裡的分析助理 Fable。
你只會收到程式從攝影機骨架追蹤計算出的「結構化動作數據」，不會看到影片，也沒有肌電量測。
規則：
1. 只描述數據裡可觀察到的變化（活動幅度、節奏、手肘位移、軀幹晃動、次數、使用者自評）。
2. 不宣稱肌肉活化百分比、增肌效果、肌肉是否「有出力」、恢復程度。這些沒有量測。
3. 速度變慢、幅度變小可能是刻意調整，也可能與疲勞有關；用「可能」，並把使用者的註記納入考量。
4. 引用具體次數（例如「第 2 次與第 9 次」），讓使用者能回放檢查。
5. 資訊不足或本組不適合比較時，直接說缺少什麼，不要補出結論。
6. 使用繁體中文，簡短，3–5 句。避免條列過長。`;

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function textOf(response) {
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function callFable(userContent) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    messages: [{ role: "user", content: userContent }],
  });
  if (response.stop_reason === "refusal") {
    return { ok: false, error: "模型拒絕回答此請求。" };
  }
  return { ok: true, text: textOf(response), model: response.model };
}

async function handleApi(req, res, url) {
  if (!client) {
    return json(res, 503, {
      ok: false,
      error: "尚未設定 Anthropic 憑證，改用本機規則摘要。",
    });
  }
  try {
    const body = await readBody(req);
    if (url.pathname === "/api/summary") {
      const content =
        "以下是一組訓練的結構化數據（JSON）。請寫出組後摘要。\n\n" +
        JSON.stringify(body.set, null, 1);
      return json(res, 200, await callFable(content));
    }
    if (url.pathname === "/api/ask") {
      const content =
        "以下是一組訓練的結構化數據（JSON）：\n\n" +
        JSON.stringify(body.set, null, 1) +
        "\n\n使用者的問題：" +
        String(body.question || "").slice(0, 500);
      return json(res, 200, await callFable(content));
    }
    return json(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return json(res, 503, { ok: false, error: "Anthropic 憑證無效。" });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return json(res, 429, { ok: false, error: "請求過於頻繁，稍後再試。" });
    }
    if (err instanceof Anthropic.APIError) {
      return json(res, 502, { ok: false, error: `API 錯誤 ${err.status}` });
    }
    return json(res, 500, { ok: false, error: String(err.message || err) });
  }
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "POST") return json(res, 405, { ok: false });
      return handleApi(req, res, url);
    }
    serveStatic(req, res, url);
  })
  .listen(PORT, () => {
    console.log(`Muscle Mirror  →  http://localhost:${PORT}`);
    console.log(
      hasCredential
        ? `Fable summaries: enabled (${MODEL})`
        : "Fable summaries: disabled (no ANTHROPIC_API_KEY) — using local rule-based summary",
    );
  });
