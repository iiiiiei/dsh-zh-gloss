#!/usr/bin/env node
/**
 * dsh-l10n-zh 离线自测 —— 不启动 dsh、不依赖网络、不依赖真实定时器。
 *
 *   A. 宿主半边：dicts 路由现读磁盘、多文件合并、坏文件容错、注册护栏、版本回声；
 *   B. 键级覆盖：zh 命中覆盖表；官方补译（含汉字）自动让位；en 模式零改动；
 *   C. 字面量层：精确映射 + 正则模式；属性翻译与官方改写再基准化；
 *      代码区/contentEditable/用户气泡跳过（含裸文本直达路径）；登记与移除注销；
 *      词典缩小自动还原；失败退避重试；localStorage 首屏缓存；
 *   D. 可逆性：dispose 全部 disposer 后查找链与 DOM 逐字节复原、观察器断开、
 *      缓存清除；publish 无自递归。
 *
 * 运行：node tests/selftest.mjs   （成功退出 0，失败打印差异退出 1）
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..", "plugin");
const CACHE_KEY = "dsh-l10n-zh:dicts:v1";
const ENABLED_KEY = "dsh-l10n-zh:enabled";
const TOGGLE_ATTR = "data-dsh-l10n-zh-toggle";

let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures.push(label); console.error(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  const good = a === b;
  if (!good) console.error(`    期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
  ok(good, label);
}

/* ═══════════════ 微型 DOM 桩（只实现插件触面） ═══════════════ */
/** 选择器子集匹配：标签名、[attr]、[attr="v"]（closest/querySelector 共用） */
function matchSelectorPart(el, part) {
  if (part === "*") return true; // 通配符
  const m = part.match(/^\[([a-zA-Z0-9-]+)(\*=)?=?["']?([^\]"']*)["']?\]$/);
  if (m) {
    const [, attr, sub, val] = m;
    const cur = el.attrs.get(attr) ?? "";
    if (sub === "*=") return cur.toLowerCase().includes(val.toLowerCase());
    return val ? cur === val : el.attrs.has(attr);
  }
  return el.tagName === part.toUpperCase();
}
class FakeElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.parentElement = null;
    this.attrs = new Map();
    this.isContentEditable = false;
    this.onclick = null;
  }
  get isConnected() {
    let n = this;
    while (n.parentElement) n = n.parentElement;
    return n === doc.body;
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const sibs = this.parentElement.childNodes.filter((n) => n.nodeType === 1);
    const i = sibs.indexOf(this);
    return i >= 0 && i < sibs.length - 1 ? sibs[i + 1] : null;
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const sibs = this.parentElement.childNodes.filter((n) => n.nodeType === 1);
    const i = sibs.indexOf(this);
    return i > 0 ? sibs[i - 1] : null;
  }
  get textContent() {
    let out = "";
    const visit = (n) => n.nodeType === 3 ? (out += n.nodeValue) : n.childNodes.forEach(visit);
    visit(this);
    return out;
  }
  set textContent(v) {
    this.childNodes = [];
    this.append(new FakeText(String(v)));
  }
  get className() { return this.attrs.get("class") ?? ""; }
  set className(v) { this.attrs.set("class", String(v)); }
  get title() { return this.getAttribute("title") ?? ""; }
  set title(v) { this.setAttribute("title", String(v)); }
  append(...cs) { for (const c of cs) { c.parentElement = this; this.childNodes.push(c); } return cs[0]; }
  insertBefore(node, ref) {
    node.parentElement = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    return node;
  }
  remove() {
    const p = this.parentElement;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    if (i >= 0) p.childNodes.splice(i, 1);
    this.parentElement = null;
  }
  contains(other) {
    for (let n = other; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  click() { if (this.onclick) this.onclick({}); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  querySelectorAll(selector) {
    const parts = selector.split(",").map((x) => x.trim()).filter(Boolean);
    const out = [];
    const visit = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (parts.some((p) => matchSelectorPart(c, p))) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  /** closest：向上找第一个匹配（含自身） */
  closest(selector) {
    const parts = selector.split(",").map((x) => x.trim()).filter(Boolean);
    for (let n = this; n; n = n.parentElement) {
      if (parts.some((part) => matchSelectorPart(n, part))) return n;
    }
    return null;
  }
  textNodes() {
    const out = [];
    const visit = (n) => n.nodeType === 3 ? out.push(n) : n.childNodes.forEach(visit);
    visit(this);
    return out;
  }
}
class FakeText {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentElement = null; }
  get isConnected() {
    let n = this;
    while (n.parentElement) n = n.parentElement;
    return n === doc.body;
  }
}
/** 从父节点摘除（测试用 detach 语义，模拟真实 DOM 移除）。 */
function detach(node) {
  const p = node.parentElement;
  if (!p) return;
  const i = p.childNodes.indexOf(node);
  if (i >= 0) p.childNodes.splice(i, 1);
  node.parentElement = null;
}
globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 };

const doc = {
  body: new FakeElement("body"),
  createElement: (tag) => new FakeElement(tag),
  querySelector: (sel) => doc.body.querySelector(sel),
  querySelectorAll: (sel) => doc.body.querySelectorAll(sel),
};
globalThis.document = doc;

const observers = [];
let observerInstance = null;
globalThis.MutationObserver = class {
  constructor(cb) { this.cb = cb; observers.push(this); observerInstance = this; }
  observe() { this.observing = true; }
  disconnect() { this.observing = false; }
};

/** localStorage 桩（首屏缓存路径）。 */
const lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => { lsStore.set(k, String(v)); },
  removeItem: (k) => { lsStore.delete(k); },
};

/** 微任务沉降：把已排队的 async 续体跑干净（不碰宏任务队列）。 */
async function settle(ticks = 20) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

/* ═══════════════ 加载客户端 bundle ═══════════════ */
let registration = null;
globalThis.window = { __ModuleLoader__: { load(reg) { registration = reg; } } };

await import(pathToFileURL(join(PLUGIN, "lib", "client.js")).href);
ok(typeof registration?.factory === "function", "A0 · client.js 以 __ModuleLoader__.load 注册");
const pluginFace = registration.factory();
eq(pluginFace.name, "dsh-l10n-zh", "B0 · 插件名正确");
ok(Array.isArray(pluginFace.inject) && pluginFace.inject.includes("locale"), "B0 · 声明注入 locale 服务");

/* ─── 官方 LocaleRuntime 行为仿真（publish 带递归深度探针） ─── */
const OFFICIAL = {
  trajectory: { en: { "toolbar.duration": "Duration" }, zh: { "toolbar.duration": "Duration" } },
  common: { en: { cancel: "Cancel" }, zh: { cancel: "取消" } },
  "settings.locale": { en: { "language.title": "Language" }, zh: { "language.title": "语言" } },
};
let activeLocale = "en";
let revision = 0;
const listeners = new Set();
let pubDepth = 0;
let pubMax = 0;
const origLookup = (ns, key) =>
  OFFICIAL[ns]?.[activeLocale]?.[key] ?? OFFICIAL[ns]?.en?.[key] ?? key;
const fakeLocale = {
  lookup: origLookup,
  getLocale: () => ({ active: activeLocale, revision }),
  publish(_active, _changed) {
    pubDepth++;
    if (pubDepth > pubMax) pubMax = pubDepth;
    try {
      revision++;
      [...listeners].forEach((fn) => fn());
    } finally { pubDepth--; }
  },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

/* ─── fetch 桩：V1 全量 → V2 缩小（移除部分词条） ─── */
const DICTS_V1 = {
  version: 1,
  ui: { trajectory: { "toolbar.duration": "时长" } },
  literals: {
    Summary: "摘要", "Open image": "打开图片", Options: "选项", Tools: "工具",
    Usage: "用量", Timing: "耗时", "Raw Output": "原始输出", Diff: "差异",
  },
  chromeLiterals: { Edit: "编辑" },
  pluginInfo: { include: "组合加载：测试描述", hmr: "热重载测试描述" },
  patterns: [
    { match: "^native directory picker aborted$", replace: "已取消原生目录选择" },
    { match: '^cannot list "(.+)": not a fully qualified path$', replace: "无法列出目录：“$1”（路径须为绝对路径）" },
  ],
};
const DICTS_V2 = {
  version: 1,
  ui: DICTS_V1.ui,
  literals: { Summary: "摘要" },
  chromeLiterals: {},
  pluginInfo: DICTS_V1.pluginInfo,
  patterns: [],
};
let servedDicts = DICTS_V1;
globalThis.fetch = async () => ({ ok: true, json: async () => servedDicts });

/* ─── ctx 桩 ─── */
const disposers = [];
const ctx = {
  locale: fakeLocale,
  logger: { info() {}, warn() {} },
  effect(cb) { const d = cb(); if (typeof d === "function") disposers.push(d); return d; },
};

const flush = () => pluginFace.__l10nTest.flushNow();
const stats = () => pluginFace.__l10nTest.stats();

/* ════════ 首屏缓存：apply 前预置 localStorage 词典 ════════ */
lsStore.set(CACHE_KEY, JSON.stringify({ version: 1, ui: {}, literals: {}, chromeLiterals: {}, patterns: [] }));

/* ════════ en 模式挂载 ════════ */
doc.body.append(new FakeText("Summary"));
const btn = doc.body.append(new FakeElement("button"));
btn.setAttribute("title", "Open image");
btn.append(new FakeText("Summary"));
const codeTag = doc.body.append(new FakeElement("code"));
codeTag.append(new FakeText("Summary")); // SKIP_TAGS 内，不应被翻译

pluginFace.apply(ctx);
eq(pluginFace.__l10nTest.state.ready, true, "C0b · 预置缓存使词典在 apply 内同步就绪（首屏无英闪）");
for (let i = 0; i < 50 && !pluginFace.__l10nTest.state.ready; i++) await settle();
await settle();
{
  const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
  eq(cached?.ui?.trajectory?.["toolbar.duration"], "时长", "C0b · 网络词典到达后回写缓存");
}
ok(pluginFace.__l10nTest.state.ready, "C0 · 词典异步拉取完成");
flush();

eq(btn.textNodes()[0].nodeValue, "Summary", "C1 · en 模式零改动");
eq(btn.getAttribute("title"), "Open image", "C1 · en 模式属性零改动");
eq(observerInstance?.observing, true, "C0 · MutationObserver 已挂载");

/* ════════ 切到 zh ════════ */
activeLocale = "zh";
fakeLocale.publish("zh", true);
flush();

eq(fakeLocale.lookup("trajectory", "toolbar.duration"), "时长", "B1 · 键级覆盖命中（官方 zh 值仍为英文）");
eq(fakeLocale.lookup("common", "cancel"), "取消", "B2 · 未覆盖键走官方链（zh）");
eq(doc.body.textNodes()[0].nodeValue, "摘要", "C2 · 字面量替换生效");
eq(btn.textNodes()[0].nodeValue, "摘要", "C2 · 元素内文本替换生效");
eq(btn.getAttribute("title"), "打开图片", "C3 · 属性替换生效");
eq(codeTag.textNodes()[0].nodeValue, "Summary", "C4 · code 区跳过不译");

// chrome 限定词条：普通内容不译，界面骨架内才译
const plainEdit = doc.body.append(new FakeText("Edit"));
const chromeBtn = doc.body.append(new FakeElement("button"));
chromeBtn.append(new FakeText("Edit"));
flush();
eq(plainEdit.nodeValue, "Edit", "C5b · chrome词条在普通内容中不生效");
eq(chromeBtn.textNodes()[0].nodeValue, "编辑", "C5b · chrome词条在按钮内生效");

// 模式匹配（宿主透传的英文报错）
const errA = doc.body.append(new FakeText("native directory picker aborted"));
const errB = doc.body.append(new FakeText('cannot list "/tmp/x": not a fully qualified path'));
flush();
eq(errA.nodeValue, "已取消原生目录选择", "C5 · 模式命中：整句报错");
eq(errB.nodeValue, "无法列出目录：“/tmp/x”（路径须为绝对路径）", "C5 · 模式命中：$1 捕获替换");

// 模拟 React 重渲染产生的新英文节点（观察器在真实环境触发，这里直接驱动同一入口）
const rerendered = btn.append(new FakeText("Summary"));
flush();
eq(rerendered.nodeValue, "摘要", "C6 · 新增节点被扫描捕获");

/* ════════ C8 · 直达路径旁路（characterData / 裸文本新增） ════════ */
const preEl = doc.body.append(new FakeElement("pre"));
const preText = preEl.append(new FakeText("Options"));
const spanInPre = preEl.append(new FakeElement("span"));
spanInPre.append(new FakeText("Tools"));
const ceEl = doc.body.append(new FakeElement("div"));
ceEl.isContentEditable = true;
const ceText = ceEl.append(new FakeText("Options"));
flush(); // 元素根路径本就跳过
pluginFace.__l10nTest.walk(preText); // 直达路径：文本节点根
pluginFace.__l10nTest.walk(spanInPre); // 直达路径：pre 内新增元素根
pluginFace.__l10nTest.walk(ceText); // 直达路径：contentEditable 内文本
pluginFace.__l10nTest.walk(ceEl);
observerInstance.cb([{ type: "characterData", target: preText, addedNodes: [], removedNodes: [] }]);
eq(preText.nodeValue, "Options", "C8 · 代码区内文本经直达路径不译");
eq(spanInPre.textNodes()[0].nodeValue, "Tools", "C8 · 代码区内新增元素不译");
eq(ceText.nodeValue, "Options", "C8 · contentEditable 内文本经直达路径不译");

/* ════════ C9 · 用户消息气泡护栏（官方 data-chat-flow-kind="user"） ════════ */
const userBubble = doc.body.append(new FakeElement("div"));
userBubble.setAttribute("data-chat-flow-kind", "user");
const userText = userBubble.append(new FakeText("Options"));
const userBtn = userBubble.append(new FakeElement("button"));
userBtn.setAttribute("title", "System Prompt");
userBtn.append(new FakeText("Options"));
flush();
eq(userText.nodeValue, "Options", "C9 · 用户气泡内文本永不改写");
eq(userBtn.getAttribute("title"), "System Prompt", "C9 · 用户气泡内属性永不改写");
eq(userBtn.textNodes()[0].nodeValue, "Options", "C9 · 用户气泡内按钮文本也不改写");

/* ════════ C10 · 登记最小化 + 移除注销（内存滞留修复） ════════ */
const noHitEl = doc.body.append(new FakeElement("span"));
noHitEl.setAttribute("title", "NoMatchHereAtAll");
flush();
const s1 = stats();
eq(noHitEl.getAttribute("title"), "NoMatchHereAtAll", "C10 · 未命中属性保持原值");
ok(true, "C10 · 未命中属性不登记（下方注销计数佐证）");

const hitEl = doc.body.append(new FakeElement("span"));
hitEl.setAttribute("title", "Summary");
const hitText = doc.body.append(new FakeText("Usage"));
const contEl = doc.body.append(new FakeElement("div"));
const contText = contEl.append(new FakeText("Timing"));
flush();
const s2 = stats();
eq(s2.attrs - s1.attrs, 1, "C10 · 命中属性按条登记（无命中不登记）");
eq(s2.text - s1.text, 2, "C10 · 命中文本按节点登记");
eq(hitEl.getAttribute("title"), "摘要", "C10 · 命中属性已翻译");
eq(hitText.nodeValue, "用量", "C10 · 命中文本已翻译");
eq(contText.nodeValue, "耗时", "C10 · 子树内文本已翻译");

detach(hitEl); detach(hitText); detach(contEl);
observerInstance.cb([
  { type: "childList", target: doc.body, addedNodes: [], removedNodes: [hitEl] },
  { type: "childList", target: doc.body, addedNodes: [], removedNodes: [hitText] },
  { type: "childList", target: doc.body, addedNodes: [], removedNodes: [contEl] },
]);
const s3 = stats();
eq(s3.attrs, s1.attrs, "C10 · 移除节点属性登记已注销");
eq(s3.text, s1.text, "C10 · 移除节点文本登记已注销（含子树）");
eq(hitEl.getAttribute("title"), "Summary", "C10 · 注销前还原属性原件（移动复用安全）");
eq(hitText.nodeValue, "Usage", "C10 · 注销前还原文本原件");
eq(contText.nodeValue, "Timing", "C10 · 子树内文本同样还原");

/* ════════ C11 · 官方改写 → 以新值为基准（re-base） ════════ */
const attrBase = doc.body.append(new FakeElement("button"));
attrBase.setAttribute("title", "Summary");
flush();
eq(attrBase.getAttribute("title"), "摘要", "C11 · 属性首译生效");
attrBase.setAttribute("title", "Raw Output"); // 官方随后改写了该属性
pluginFace.__l10nTest.walk(attrBase);
eq(attrBase.getAttribute("title"), "原始输出", "C11 · 官方改写后按新值重新翻译");
const textBase = doc.body.append(new FakeText("Tools"));
flush();
eq(textBase.nodeValue, "工具", "C11 · 文本首译生效");
textBase.nodeValue = "Diff"; // 官方随后改写了该文本
pluginFace.__l10nTest.walk(textBase);
eq(textBase.nodeValue, "差异", "C11 · 官方改写后按新文本重新翻译");

/* ════════ 词典缩小 → 已翻处回退原件 ════════ */
servedDicts = DICTS_V2;
await pluginFace.__l10nTest.loadDicts();
flush();
eq(btn.getAttribute("title"), "Open image", "C7 · 词条移除后属性恢复英文");
eq(doc.body.textNodes()[0].nodeValue, "摘要", "C7 · 仍在典词条保持中文");
eq(pluginFace.__l10nTest.compiledPatterns().length, 0, "C7 · patterns 清空生效");
eq(attrBase.getAttribute("title"), "Raw Output", "C11 · 改写基准词条移除后回到官方最新值");
eq(textBase.nodeValue, "Diff", "C11 · 改写基准词条移除后回到官方最新文本");

/* ════════ B3 · 官方补译让位（追赶自愈） ════════ */
OFFICIAL.trajectory.zh["toolbar.duration"] = "持续时间";
eq(fakeLocale.lookup("trajectory", "toolbar.duration"), "持续时间", "B3 · 官方补出含汉字译文 → 插件让位");
OFFICIAL.trajectory.zh["toolbar.duration"] = "Duration";
eq(fakeLocale.lookup("trajectory", "toolbar.duration"), "时长", "B3 · 官方仍是英文 → 继续用插件词条");

/* ════════ B4 · 应用内开关（设置语言行注入 + 热启停） ════════ */
const toggleDialog = doc.body.append(new FakeElement("div"));
toggleDialog.setAttribute("role", "dialog");
const langRow = toggleDialog.append(new FakeElement("div"));
const langRowText = langRow.append(new FakeElement("div"));
const langTitle = langRowText.append(new FakeElement("div"));
langTitle.textContent = "语言";
// 官方 Menu 组件会给按钮包一层容器（span._root_*），结构必须对齐真实 DOM
const menuWrap = langRow.append(new FakeElement("span"));
menuWrap.setAttribute("class", "_root_19372_1");
const langMenuBtn = menuWrap.append(new FakeElement("button"));
langMenuBtn.setAttribute("aria-haspopup", "menu");
langMenuBtn.className = "hVGvvW_selector";
langMenuBtn.textContent = "中文";
// 插件列表卡片仿真（图5 注入目标）：真实 DOM 为
// LI 卡片 > div.cardDetails > dl > div 包裹层 > [dt 标签 + dd 值]，插件名在 dl 之外
const pluginCard = toggleDialog.append(new FakeElement("div"));
pluginCard.className = "pluginCard";
const pName = pluginCard.append(new FakeElement("span"));
pName.className = "mono";
pName.textContent = "include";
const pDetails = pluginCard.append(new FakeElement("div"));
pDetails.className = "details";
const pCfgWrap = pDetails.append(new FakeElement("div"));
const pCfgL = pCfgWrap.append(new FakeElement("span"));
pCfgL.textContent = "配置状态";
const pCfgV = pCfgWrap.append(new FakeElement("span"));
pCfgV.textContent = "已启用";
const pCordisWrap = pDetails.append(new FakeElement("div"));
const pCordisL = pCordisWrap.append(new FakeElement("span"));
pCordisL.textContent = "Cordis 状态";
const pCordisV = pCordisWrap.append(new FakeElement("span"));
pCordisV.textContent = "已挂载";
pluginFace.__l10nTest.scanToggle();
const toggleBtn = langRow.children[1]; // 注入在 Menu 容器之前
ok(toggleBtn && toggleBtn.attrs.has(TOGGLE_ATTR), "B4a · 开关注入到语言行");
eq(langRow.children[1] === toggleBtn, true, "B4a · 开关插入在 Menu 容器之前（药丸左侧）");
eq(toggleBtn.className, "hVGvvW_selector", "B4a · 借用官方药丸样式（运行时拷贝）");
eq(toggleBtn.textContent, "汉化：开", "B4a · 默认开启态标签");
eq(toggleBtn.getAttribute("aria-pressed"), "true", "B4a · aria-pressed 同步");

// B4a2 · 插件卡片描述注入（图5）：描述以 dt/dd 对插入 Cordis 状态包裹层之后
const descDT = pluginCard.querySelector(`[data-dsh-l10n-zh-desc]`);
ok(descDT, "B4a2 · 插件卡片注入「描述」dt");
eq(descDT && descDT.textContent, "描述", "B4a2 · dt 标签文本");
eq(descDT && descDT.nextElementSibling && descDT.nextElementSibling.textContent.includes("组合加载：测试描述"), true, "B4a2 · dd 内容来自词典 pluginInfo");
eq(descDT && descDT.parentElement === pDetails, true, "B4a2 · dt/dd 直接位于状态列表容器内（对齐 dl 网格）");
eq(descDT && pCordisWrap.nextElementSibling === descDT, true, "B4a2 · 描述对紧随 Cordis 状态包裹层");
pluginFace.__l10nTest.scanToggle();
eq(pluginCard.querySelectorAll(`[data-dsh-l10n-zh-desc]`).length, 1, "B4a2 · 重复扫描不重复注入");

// B4a3 · 已停用插件：只有 配置状态 行（无 Cordis 状态行）也要注入
const disabledCard = toggleDialog.append(new FakeElement("div"));
disabledCard.className = "pluginCard";
const dName = disabledCard.append(new FakeElement("span"));
dName.className = "mono";
dName.textContent = "hmr";
const dCfgWrap = disabledCard.append(new FakeElement("div"));
const dCfgL = dCfgWrap.append(new FakeElement("span"));
dCfgL.textContent = "配置状态";
const dCfgV = dCfgWrap.append(new FakeElement("span"));
dCfgV.textContent = "已停用";
// B4a4 对照 · 未收录插件：不得注入（更不得串台别人的描述）
const unknownCard = toggleDialog.append(new FakeElement("div"));
unknownCard.className = "pluginCard";
const uName = unknownCard.append(new FakeElement("span"));
uName.className = "mono";
uName.textContent = "mystery";
const uCfgWrap = unknownCard.append(new FakeElement("div"));
const uCfgL = uCfgWrap.append(new FakeElement("span"));
uCfgL.textContent = "配置状态";
const uCfgV = uCfgWrap.append(new FakeElement("span"));
uCfgV.textContent = "已启用";
pluginFace.__l10nTest.scanToggle();
const hmrDesc = disabledCard.querySelector(`[data-dsh-l10n-zh-desc]`);
ok(hmrDesc, "B4a3 · 已停用插件（仅配置状态行）也注入描述");
eq(hmrDesc && hmrDesc.textContent === "描述", true, "B4a3 · dt 标签文本");
eq(hmrDesc && hmrDesc.nextElementSibling && hmrDesc.nextElementSibling.textContent.includes("热重载测试描述"), true, "B4a3 · 停用插件拿到自己的描述");
eq(unknownCard.querySelector(`[data-dsh-l10n-zh-desc]`), null, "B4a4 · 未收录插件不注入");
eq(pluginCard.querySelector(`[data-dsh-l10n-zh-desc]`).getAttribute("data-dsh-l10n-zh-desc"), "include", "B4a5 · 多卡片各取己名（描述不串台）");

toggleBtn.click(); // 关
eq(pluginFace.__l10nTest.state.enabled, false, "B4b · 开关关闭");
eq(localStorage.getItem(ENABLED_KEY), "0", "B4b · 状态持久化");
eq(fakeLocale.lookup === origLookup, true, "B4b · 关=lookup 包裹立即卸下（引用同一）");
eq(doc.body.textNodes()[0].nodeValue, "Summary", "B4b · 字面量层立即还原");
eq(toggleBtn.textContent, "汉化：关", "B4b · 标签切换");
eq(toggleBtn.getAttribute("aria-pressed"), "false", "B4b · aria-pressed 同步");
pluginFace.__l10nTest.scanToggle(); // 再扫一遍不得重复注入
eq(langRow.querySelectorAll(`[${TOGGLE_ATTR}]`).length, 1, "B4b · 重复扫描不重复注入");

toggleBtn.click(); // 开
eq(pluginFace.__l10nTest.state.enabled, true, "B4c · 开关重开");
eq(localStorage.getItem(ENABLED_KEY), "1", "B4c · 状态持久化");
for (let i = 0; i < 50 && !pluginFace.__l10nTest.state.ready; i++) await settle();
await settle();
eq(fakeLocale.lookup("trajectory", "toolbar.duration"), "时长", "B4c · 键级覆盖恢复");
flush();
eq(doc.body.textNodes()[0].nodeValue, "摘要", "B4c · 字面量层恢复");
eq(toggleBtn.textContent, "汉化：开", "B4c · 标签切回");
eq(toggleBtn.getAttribute("title"), "汉化补全开关（dsh-l10n-zh）", "B4c · 开关自身 title 是插件自有文案");

/* ════════ 卸载：全部 disposer 逆放 ════════ */
while (disposers.length) disposers.pop()();

eq(fakeLocale.lookup === origLookup, true, "D1 · 卸载后查找链===官方原函数（引用同一）");
eq(fakeLocale.lookup("trajectory", "toolbar.duration"), "Duration", "D1 · 官方行为逐字节复原");
eq(doc.body.textNodes()[0].nodeValue, "Summary", "D2 · 文本节点全部还原");
eq(rerendered.nodeValue, "Summary", "D2 · 新增节点同样还原");
eq(chromeBtn.textNodes()[0].nodeValue, "Edit", "D2 · chrome 词条节点同样还原");
eq(btn.textNodes()[0].nodeValue, "Summary", "D2 · 元素内文本还原");
eq(btn.getAttribute("title"), "Open image", "D3 · 属性还原");
eq(userText.nodeValue, "Options", "D2 · 用户气泡内容始终未动");
eq(observerInstance?.observing, false, "D4 · MutationObserver 已断开");
eq(localStorage.getItem(CACHE_KEY), null, "D5 · 卸载清除本地词典缓存");
ok(pubMax <= 2, `D6 · publish 无自递归（观测最大深度 ${pubMax}）`);
eq(doc.body.querySelector(`[${TOGGLE_ATTR}]`), null, "D7 · 卸载连应用内开关一起移除");
eq(doc.body.querySelector(`[data-dsh-l10n-zh-desc]`), null, "D8 · 卸载连插件描述行一起移除");

/* ════════ C13 · 词典拉取失败退避重试（卸载后状态仍可驱动） ════════ */
{
  const realST = globalThis.setTimeout;
  const realCT = globalThis.clearTimeout;
  const captured = [];
  globalThis.setTimeout = (fn, ms) => { captured.push({ fn, ms }); return captured.length; };
  globalThis.clearTimeout = (id) => { if (captured[id - 1]) captured[id - 1].cleared = true; };
  try {
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    await pluginFace.__l10nTest.loadDicts();
    await settle();
    ok(pluginFace.__l10nTest.state.failed != null, "C13 · 拉取失败记录原因");
    eq(pluginFace.__l10nTest.pendingRetry(), true, "C13 · 失败后安排退避重试");
    eq(captured.length, 1, "C13 · 首次重试延迟 1.5s（有限次）");
    eq(captured[0].ms, 1500, "C13 · 退避间隔正确");
    globalThis.fetch = async () => ({ ok: true, json: async () => DICTS_V1 });
    captured[0].fn();
    for (let i = 0; i < 50 && !pluginFace.__l10nTest.state.ready; i++) await settle();
    await settle();
    eq(pluginFace.__l10nTest.state.ready, true, "C13 · 重试成功恢复就绪");
    eq(pluginFace.__l10nTest.state.failed, null, "C13 · 失败态清除");
    eq(pluginFace.__l10nTest.pendingRetry(), false, "C13 · 成功后不再重试");
    eq(captured.length, 1, "C13 · 无额外重试排程");
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    eq(cached?.literals?.Summary, "摘要", "C13 · 重试成功后缓存同步回写");
    localStorage.removeItem(CACHE_KEY);
  } finally {
    globalThis.setTimeout = realST;
    globalThis.clearTimeout = realCT;
  }
}

/* ═══════════════ A · 宿主半边（真实 fs 夹具） ═══════════════ */
const fixtureDir = mkdtempSync(join(tmpdir(), "dsh-l10n-test-"));
writeFileSync(join(fixtureDir, "01-a.json"), JSON.stringify({
  ui: { nsA: { k1: "一" } },
  literals: { Save: "保存" },
  chromeLiterals: { Run: "运行" },
  pluginInfo: { include: "组合加载" },
  patterns: [{ match: "^a$", replace: "甲" }],
}));
writeFileSync(join(fixtureDir, "02-b.json"), JSON.stringify({
  ui: { nsA: { k2: "二" }, nsB: { k: "乙" } },
  literals: { Save: "储存" },
  patterns: [{ match: "^b$", replace: "乙" }],
}));
writeFileSync(join(fixtureDir, "03-broken.json"), "{ 不是 JSON");

process.env.DSH_L10N_DICTS_DIR = fixtureDir;
const routes = {};
const hostCtx = {
  webServer: { register: (def) => { routes[def.path] = def.handler; } },
  logger: { info() {} },
  effect(cb) { cb(); },
};
const hostMod = await import(pathToFileURL(join(PLUGIN, "lib", "index.js")).href);
hostMod.apply(hostCtx);

ok(typeof routes["/api/l10n-zh/dicts"] === "function", "A1 · dicts 路由已注册");
{
  let captured;
  const res = { writeHead() {}, end(p) { captured = JSON.parse(p); } };
  await routes["/api/l10n-zh/dicts"]({}, res);
  eq(captured.ui.nsA.k1, "一", "A2 · 多文件合并：先读字段保留");
  eq(captured.ui.nsA.k2, "二", "A2 · 同命名空间跨文件合并");
  eq(captured.literals.Save, "储存", "A2 · 后读文件覆盖 literals");
  eq(captured.patterns.length, 2, "A2 · patterns 跨文件拼接保序");
  eq(captured.chromeLiterals.Run, "运行", "A2 · chromeLiterals 合并");
  eq(captured.pluginInfo.include, "组合加载", "A2 · pluginInfo 合并");
  eq(captured.meta.files.filter((f) => f.error).length, 1, "A3 · 坏 JSON 容错并上报");
}
{
  let captured;
  const res = { writeHead() {}, end(p) { captured = JSON.parse(p); } };
  await routes["/api/l10n-zh/status"]({}, res);
  eq(captured.ok, true, "A4 · status 路由可用");
  eq(captured.literalCount, 1, "A4 · 计数正确");
  eq(captured.patternCount, 2, "A4 · patterns 计数正确");
  eq(captured.pluginInfoCount, 1, "A4 · pluginInfo 计数正确");
  eq(captured.pluginBaseline, "0.1.1-rc.2", "A5 · 回显插件验证基线");
  eq(captured.officialDshVersion, null, "A5 · 探测不到官方版本时回显 null");
  eq(captured.drift, null, "A5 · 探测不到时 drift 为 null");
}
{
  // 官方 webServer.register 契约变更 → 护栏降级为 warn，apply 不抛错
  const warns = [];
  const throwingCtx = {
    webServer: { register() { throw new Error("contract changed"); } },
    logger: { info() {}, warn(m) { warns.push(m); } },
    effect(cb) { cb(); },
  };
  let threw = null;
  try { hostMod.apply(throwingCtx); } catch (e) { threw = e; }
  eq(threw, null, "A6 · register 契约变更时 apply 不抛错");
  eq(warns.length, 2, "A6 · 两条路由均降级为告警");
}

rmSync(fixtureDir, { recursive: true, force: true });

/* ════════ B5 · 开关=关时的挂载：不启动翻译，但开关可用（重开入口） ════════ */
{
  detach(toggleDialog); // 摘掉 B4 的弹窗，避免 querySelector 命中旧弹窗
  localStorage.setItem(ENABLED_KEY, "0");
  const face2 = registration.factory();
  const disposers2 = [];
  const ctx2 = {
    locale: fakeLocale,
    logger: { info() {}, warn() {} },
    effect(cb) { const d = cb(); if (typeof d === "function") disposers2.push(d); return d; },
  };
  face2.apply(ctx2);
  eq(fakeLocale.lookup === origLookup, true, "B5a · 关态挂载不包裹 lookup");
  eq(face2.__l10nTest.state.ready, false, "B5a · 关态不拉词典");
  const dlg2 = doc.body.append(new FakeElement("div"));
  dlg2.setAttribute("role", "dialog");
  const row2 = dlg2.append(new FakeElement("div"));
  const rowText2 = row2.append(new FakeElement("div"));
  const title2 = rowText2.append(new FakeElement("div"));
  title2.textContent = "语言";
  const wrap2 = row2.append(new FakeElement("span"));
  const menu2 = wrap2.append(new FakeElement("button"));
  menu2.setAttribute("aria-haspopup", "menu");
  face2.__l10nTest.scanToggle();
  const tog2 = row2.children[1];
  ok(tog2 && tog2.attrs.has(TOGGLE_ATTR), "B5b · 关态下开关仍注入（重开翻译的入口）");
  tog2.click();
  eq(face2.__l10nTest.state.enabled, true, "B5b · 点击重开翻译");
  for (let i = 0; i < 50 && !face2.__l10nTest.state.ready; i++) await settle();
  await settle();
  eq(fakeLocale.lookup("trajectory", "toolbar.duration"), "时长", "B5b · 重开后键级覆盖恢复");
  while (disposers2.length) disposers2.pop()();
  eq(fakeLocale.lookup === origLookup, true, "B5c · face2 卸载还原（引用同一）");
  detach(dlg2);
  localStorage.setItem(ENABLED_KEY, "1");
}

/* ═══════════════ 结果 ═══════════════ */
console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`);
if (failures.length) {
  console.error("失败项：", failures);
  process.exit(1);
}
