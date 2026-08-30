#!/usr/bin/env node
/**
 * scan-locale-gaps v2 — 调研工具：扫描 dsh 客户端包的 zh/en 字典，找出两类缺口：
 *
 *   1. 键级缺口：en 有而 zh 没有的键（中文模式回退英文）；
 *   2. 值级缺口：zh 里该键存在、但值与 en 完全相同且含拉丁字母
 *      （官方占位式"翻译"——trajectory 工具栏就是这种）。
 *
 * 配对依据是 register(ns, { zh: X, en: Y }) 调用点里成对的常量名，
 * 而不是按常量名猜，避免同包多命名空间互相污染。
 *
 * 用法：node tools/scan-locale-gaps.mjs [node_modules路径] [报告输出路径]
 * 两个参数均可省略：省略路径时使用默认 npx 缓存；传入空串同样按默认处理。
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const DEFAULT_ROOT = join(
  process.env.HOME ?? "",
  ".npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai",
);
const root = process.argv[2] ? process.argv[2] : DEFAULT_ROOT;
const outFile = process.argv[3];

/** 从 src 的 idx（指向 "{"）处提取配平的花括号字面量。 */
function objAt(src, idx) {
  let depth = 0, inStr = null, esc = false;
  for (let i = idx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  return null;
}

/** 提取所有 const <name> = {...} 字典对象。 */
function constsOf(src) {
  const out = {};
  const re = /const\s+([\w$]+)\s*=\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    if (!/^(zh|en)[\w$]*$/.test(m[1])) continue;
    const lit = objAt(src, re.lastIndex - 1);
    if (!lit) continue;
    // 信任边界：eval 仅解析本机已安装的官方包源码中的字典字面量（开发工具，
    // 非运行时代码）。勿对不可信来源的 bundle 运行本脚本。
    try { out[m[1]] = eval(`(${lit})`); } catch { /* 跳过解析失败块 */ }
  }
  return out;
}

/** 找出 register(<ns或NS常量>, { zh: X, en: Y }) 的配对。 */
function pairsOf(src, consts) {
  const pairs = [];
  const re = /register\(\s*(?:["']([^"']+)["']|[A-Za-z_$][\w$]*)\s*,\s*\{\s*zh\s*:?\s*([\w$]*)\s*,\s*en\s*:?\s*([\w$]*)\s*[},]/g;
  let m;
  while ((m = re.exec(src))) {
    const zhName = m[2] || "zh";
    const enName = m[3] || "en";
    if (consts[zhName] && consts[enName]) pairs.push({ ns: m[1] ?? "(动态NS)", zh: consts[zhName], en: consts[enName] });
  }
  return pairs;
}

const hasLatin = (s) => /[A-Za-z]/.test(s);
const lines = [];

for (const p of readdirSync(root).sort()) {
  if (!p.startsWith("dsh-client")) continue;
  const f = join(root, p, "lib/client.js");
  if (!existsSync(f)) continue;
  const src = readFileSync(f, "utf8");
  const consts = constsOf(src);
  const pairs = pairsOf(src, consts);
  if (!pairs.length) continue;
  const seen = new Set();
  for (const { ns, zh, en } of pairs) {
    for (const [key, enVal] of Object.entries(en)) {
      if (!(key in zh)) {
        lines.push(`${p} | ${ns} | 键缺失 | ${key} = ${String(enVal).slice(0, 80)}`);
        continue;
      }
      const zhVal = String(zh[key]);
      const sig = `${ns}\u0000${key}`;
      if (seen.has(sig)) continue;
      if (hasLatin(zhVal) && zhVal === String(enVal)) {
        seen.add(sig);
        lines.push(`${p} | ${ns} | 值未译 | ${key} = ${zhVal.slice(0, 80)}`);
      }
    }
  }
}

const report = lines.length ? lines.join("\n") : "未发现缺口。";
console.log(report);
console.log(`\n共 ${lines.length} 条`);
if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, report + "\n");
  console.log(`已写入报告：${outFile}`);
}
