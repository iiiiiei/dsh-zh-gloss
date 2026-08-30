#!/usr/bin/env node
/**
 * dsh-l10n-zh 真实使用模拟服务器 —— 在真实浏览器里驱动**真插件 bundle + 真词典**。
 *
 *   node tests/simulation/server.mjs [端口=8931]
 *   → 打开 http://127.0.0.1:8931/                 全量推演（S1–S13）
 *   → http://127.0.0.1:8931/?hostile=1            敌意环境（S14：locale 契约破坏 → 惰性）
 *   → 先访问 / ，再访问 /?phase=cache             首屏缓存（S15：词典扣住 2.5s 仍即时中文）
 *
 * 语义对齐真实部署：
 *   - /client.js 现读 plugin/lib/client.js（no-store，等同官方 rev 失效后的新 bundle）；
 *   - /api/l10n-zh/dicts 每次现读 plugin/dicts/*.json 并按文件名序合并（同宿主半边），
 *     另加内存 overlay 模拟"用户编辑了词典文件"；
 *   - 故障注入：词典 500 / 延迟，验证退避重试与首屏缓存。
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..", "..", "plugin");
const PORT = Number(process.argv[2] || 8931);

/** 内存词典 overlay（模拟热编辑 dicts/*.json，不触碰真实文件）。 */
const overlay = { literals: {} };
/** 故障注入状态。mode:"ok"|"500"；delayMs 为一次性延迟（响应后自动清零）。 */
const faults = { mode: "ok", delayMs: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mergedDicts() {
  const names = ["10-backend-copy.json", "literals.json", "ui.json"]; // 文件名序
  const ui = {}, literals = {}, chromeLiterals = {}, patterns = [];
  for (const f of names) {
    try {
      const doc = JSON.parse(await readFile(join(PLUGIN, "dicts", f), "utf8"));
      if (doc.ui && typeof doc.ui === "object") {
        for (const [ns, entries] of Object.entries(doc.ui)) {
          if (entries && typeof entries === "object" && !Array.isArray(entries)) ui[ns] = { ...ui[ns], ...entries };
        }
      }
      Object.assign(literals, doc.literals ?? {});
      Object.assign(chromeLiterals, doc.chromeLiterals ?? {});
      if (Array.isArray(doc.patterns)) patterns.push(...doc.patterns);
    } catch { /* 坏文件跳过（同宿主半边容错语义） */ }
  }
  Object.assign(literals, overlay.literals ?? {});
  return { version: 1, ui, literals, chromeLiterals, patterns };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      // 一次性词典延迟（首屏缓存相位用）：?delaydicts=2500
      const dd = Number(url.searchParams.get("delaydicts") || 0);
      if (dd > 0) faults.delayMs = dd;
      const html = await readFile(join(HERE, "page.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/client.js") {
      const js = await readFile(join(PLUGIN, "lib", "client.js"), "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(js);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/l10n-zh/dicts") {
      if (faults.mode === "500") { sendJson(res, 500, { ok: false, error: "simulated server fault" }); return; }
      if (faults.delayMs > 0) { await sleep(faults.delayMs); faults.delayMs = 0; } // 一次性
      sendJson(res, 200, await mergedDicts());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/l10n-zh/status") {
      const d = await mergedDicts();
      sendJson(res, 200, {
        ok: true, plugin: "dsh-l10n-zh", officialDshVersion: "0.1.1-rc.2(sim)",
        pluginBaseline: "0.1.1-rc.2", drift: false,
        literalCount: Object.keys(d.literals).length, patternCount: d.patterns.length,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/sim/overlay") {
      const body = await readBody(req);
      Object.assign(overlay.literals, body.literals ?? {});
      sendJson(res, 200, { ok: true, overlayCount: Object.keys(overlay.literals).length });
      return;
    }
    if (req.method === "POST" && url.pathname === "/sim/overlay/clear") {
      overlay.literals = {};
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/sim/faults") {
      const body = await readBody(req);
      if (body.mode) faults.mode = body.mode;
      faults.delayMs = Number(body.delayMs ?? faults.delayMs) || 0;
      sendJson(res, 200, { ok: true, faults: { ...faults } });
      return;
    }
    if (req.method === "POST" && url.pathname === "/sim/reset") {
      overlay.literals = {};
      faults.mode = "ok";
      faults.delayMs = 0;
      sendJson(res, 200, { ok: true });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[sim] http://127.0.0.1:${PORT}/            全量推演 S1–S13`);
  console.log(`[sim] http://127.0.0.1:${PORT}/?hostile=1   敌意环境 S14`);
  console.log(`[sim] 先访问 / 再访问 /?phase=cache          首屏缓存 S15`);
});
