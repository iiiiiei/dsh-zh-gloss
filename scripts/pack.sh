#!/usr/bin/env bash
# pack.sh — 校验并打包 dsh-l10n-zh 插件
# 产物：dist/dsh-l10n-zh/（可直接拷入 ~/.dsh/profiles/node_modules/）
#       dist/dsh-l10n-zh-<version>.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/4 语法校验"
node --check plugin/lib/index.js
node --check plugin/lib/client.js

echo "==> 2/4 词典 JSON 校验"
node -e '
const fs = require("fs");
const files = fs.readdirSync("plugin/dicts").filter((f) => f.endsWith(".json")).sort();
if (!files.length) throw new Error("plugin/dicts 下没有任何词典");
for (const f of files) {
  const p = "plugin/dicts/" + f;
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  if (doc.ui) {
    for (const [ns, entries] of Object.entries(doc.ui)) {
      if (typeof entries !== "object" || entries === null || Array.isArray(entries))
        throw new Error(p + ": ui." + ns + " 必须是键值对象");
    }
  }
  for (const p2 of doc.patterns ?? []) {
    new RegExp(p2.match, "u"); // 只验可编译性，结果丢弃
    if (typeof p2.replace !== "string") throw new Error(p + ": pattern 缺 replace");
  }
  console.log("   ok:", p);
}'

echo "==> 3/4 离线自测"
node tests/selftest.mjs

echo "==> 4/4 组装产物"
VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("plugin/package.json","utf8")).version')
rm -rf dist
mkdir -p dist
cp -R plugin "dist/dsh-l10n-zh"
find dist -name ".DS_Store" -delete   # Finder 垃圾不入包
tar -czf "dist/dsh-l10n-zh-${VERSION}.tar.gz" -C dist dsh-l10n-zh

echo
echo "完成：dist/dsh-l10n-zh/ 与 dist/dsh-l10n-zh-${VERSION}.tar.gz"
echo "部署步骤见 wiki/01-一键安装.md"
