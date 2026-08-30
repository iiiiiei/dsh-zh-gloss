/**
 * dsh-l10n-zh — DSH Web UI 中文汉化补全插件（浏览器侧 / client 半边）
 *
 * ══════════════════════════════════════════════════════════════════
 *  设计原则（与官方机制的关系）
 * ══════════════════════════════════════════════════════════════════
 *  1. 官方加载管线：本文件是官方客户端模块格式的手写 bundle ——
 *     `window.__ModuleLoader__.load({ id, factory })`，由宿主的
 *     dsh-client-modules 按 package.json 的 `dsh.client` 声明编排进启动图。
 *     不依赖任何构建器，源码即可审阅、可审计。

 *  2. 零侵入 + fail-inert：不修改官方任何包/字典/组件。官方 LocaleRuntime 的
 *     `register()` 在命名空间+语言已存在时会抛错（防止覆盖官方词典），
 *     因此我们**不重注册**，而是注入一个 cordis 客户端插件，把
 *     locale 实例的 `lookup` 方法做运行时包裹（覆盖层优先命中，
 *     未命中原样透传官方查找链）。locale 服务不可用/契约变更时插件
 *     保持惰性，UI 与未安装时行为一致。

 *  3. 可逆性承诺：卸载 = 完全还原。
 *     - lookup 包裹：disposer 会把原函数装回（引用同一）；
 *     - DOM 字面量层：每个被改写的文本节点/属性都以 {original, written}
 *       双值登记——仅在"当前值仍是我们写下的译文"时才回写原件
 *       （官方中途改写的值视为新的原件，绝不回写覆盖）；
 *     - 节点从 DOM 移除时随 mutation 记录同步注销登记（防内存滞留），
 *       注销前先还原，节点若被 React 移动复用也能带着原件回去；
 *     - 插件卸载后 UI 与未安装本插件时逐字节一致。

 *  4. 双层翻译：
 *     ┌ 第一层 键级覆盖 ui[ns][key] ── 官方 t() 体系内的缺口
 *     │   （如 trajectory 工具栏 zh 字典里留着英文值）；
 *     │   命中时回查官方值：官方已补出含汉字的译文 → 自动让位
 *     │   （官方追赶后插件自我收缩）；官方仍是英文/键名 → 用本插件词条。
 *     └ 第二层 字面量精确映射 literals[英文原文] ── 不走 t() 的
 *         硬编码文案与后端下发的数据文案（命令释义、执行回执、
 *         工具卡片标题等），经 MutationObserver 对渲染结果做整词
 *         精确匹配替换。chromeLiterals 仅在按钮/标题等界面骨架生效；
 *         patterns 正则捕获用于带参数的动态串。
 *     安全边界：CODE/PRE/SVG/TEXTAREA/contentEditable 一律跳过；
 *     `[data-chat-flow-kind="user"]`（官方用户消息气泡标记）永不改写。

 *  5. 词典热更新与首屏：词典来自 GET /api/l10n-zh/dicts（宿主半边
 *     现读磁盘）。上次拉取成功的词典同步缓存于 localStorage——下次
 *     页面加载先用缓存渲染（消除首屏英闪），随后网络校验并覆盖。
 *     拉取失败按 1.5s/4s 退避重试两次即止（无常驻轮询）。
 *     仅在 locale 为 zh 时启用；en 模式零改动。

 *  6. 应用内开关：设置 → 通用设置 → 语言行的语言选择药丸左侧注入一枚
 *     「汉化：开/关」按钮（视觉借用官方 selector 的 className，随官方
 *     改版自动跟随）。锚定方式：用官方 lookup("settings.locale",
 *     "language.title") 取当前语言的标题文案精确匹配行内叶子元素，
 *     不依赖哈希类名；锚点找不到时开关不出现，翻译功能本身不受影响。
 *     关=立即停用并逐字节还原（词典缓存保留，重开更快）；状态持久化于
 *     localStorage，重装/重启后跟随。真正的 cordis 卸载仍会连开关一起移除。
 */

window.__ModuleLoader__.load({
	id: "dsh-l10n-zh",
	factory: () => {
		const PLUGIN_ID = "dsh-l10n-zh";
		const DICTS_URL = "/api/l10n-zh/dicts";
		const TARGET_LOCALE = "zh";
		const CACHE_KEY = "dsh-l10n-zh:dicts:v1";
		const ENABLED_KEY = "dsh-l10n-zh:enabled";
		const TOGGLE_ATTR = "data-dsh-l10n-zh-toggle";
		const RETRY_DELAYS_MS = [1500, 4000];
		/** 官方 zh 值含汉字 → 视为官方已补译，键级覆盖让位（追赶自愈）。 */
		const CJK_RE = /[\u4e00-\u9fff]/;

		/** 归一化用于匹配的文本：折叠连续空白、去首尾。 */
		const norm = (s) => s.replace(/\s+/g, " ").trim();
		const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

		/** 调试探针：localStorage 置 dsh-l10n-zh:debug=1 后，window.__l10nDebug 可看注入器执行轨迹。 */
		const DEBUG = (() => {
			try { return typeof localStorage !== "undefined" && localStorage.getItem("dsh-l10n-zh:debug") === "1"; }
			catch { return false; }
		})();
		const debugLog = (...parts) => {
			if (!DEBUG) return;
			try {
				const w = window;
				(w.__l10nDebug = w.__l10nDebug || []).push(`${new Date().toISOString().slice(11, 23)} ${parts.join(" ")}`.slice(-300));
				if (w.__l10nDebug.length > 80) w.__l10nDebug.splice(0, w.__l10nDebug.length - 80);
			} catch { /* 忽略 */ }
		};

		// ───────────────────────── 运行状态 ─────────────────────────
		function readEnabled() {
			try {
				if (typeof localStorage === "undefined") return true;
				const raw = localStorage.getItem(ENABLED_KEY);
				return raw === null ? true : raw === "1";
			} catch { return true; }
		}
		function writeEnabled(v) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(ENABLED_KEY, v ? "1" : "0");
			} catch { /* 配额/隐私模式：状态不持久化但不影响本次会话 */ }
		}

		const state = {
			active: "en", // 跟随官方 locale 服务；仅 zh 时翻译生效
			enabled: readEnabled(), // 应用内开关；关 = 停用翻译并还原，插件其余部分待命
			ui: {}, // namespace -> key -> 中文
			literals: {}, // 英文原文 -> 中文（全局精确）
			chromeLiterals: {}, // 英文原文 -> 中文（仅界面骨架上下文生效）
			pluginInfo: {}, // 插件 id -> 中文注释（设置→插件列表注入用）
			ready: false,
			failed: null,
		};

		let localeRef = null;

		// ─────────────────── 第一层：键级覆盖（t() 体系） ───────────────────
		function installLookupPatch() {
			// 注意：不使用 .bind() —— 卸载还原要求把**同一个函数引用**装回，
			// 否则任何依赖身份比较的消费方都会察觉差异。
			const original = localeRef.lookup;
			const patched = function (ns, key) {
				if (state.active === TARGET_LOCALE) {
					const table = state.ui[ns];
					if (table && hasOwn(table, key)) {
						const value = table[key];
						if (typeof value === "string") {
							const official = original.call(this, ns, key);
							if (typeof official === "string" && CJK_RE.test(official)) return official;
							return value;
						}
					}
				}
				return original.call(this, ns, key);
			};
			localeRef.lookup = patched;
			/** disposer：停用时把官方查找链原样装回。 */
			return () => {
				if (localeRef && localeRef.lookup === patched) localeRef.lookup = original;
			};
		}

		/**
		 * 触发全量重渲染：官方 LocaleRuntime.publish 会推进 revision 并通知
		 * 全部 useSyncExternalStore 订阅者，已挂载的 t() 文案随之重算。
		 * （localeChanged=false：只刷渲染，不发 locale/change 事件。）
		 * 只能在非订阅回调的调用链上使用——订阅回调里再 publish 会同步递归。
		 */
		function refreshRender() {
			try {
				if (localeRef && typeof localeRef.publish === "function") {
					localeRef.publish(localeRef.getLocale().active, false);
				}
			} catch { /* 快照不可用时静默；DOM 层仍会兜底 */ }
			scheduleFullScan();
		}

		// ─────────────── localStorage 词典缓存（消除首屏英闪） ───────────────
		function readCache() {
			try {
				if (typeof localStorage === "undefined") return null;
				const raw = localStorage.getItem(CACHE_KEY);
				if (!raw) return null;
				const doc = JSON.parse(raw);
				return doc && typeof doc === "object" ? doc : null;
			} catch { return null; }
		}
		function writeCache(doc) {
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem(CACHE_KEY, JSON.stringify(doc));
			} catch { /* 配额/隐私模式：缓存不可用不影响功能 */ }
		}
		function clearCache() {
			try {
				if (typeof localStorage !== "undefined") localStorage.removeItem(CACHE_KEY);
			} catch { /* 忽略 */ }
		}

		/** 词典文档 → 运行状态（缓存与网络两条路共用同一入口，天然同构）。 */
		function applyDictDoc(doc) {
			state.ui = doc && typeof doc.ui === "object" && doc.ui ? doc.ui : {};
			state.literals = doc && typeof doc.literals === "object" && doc.literals ? doc.literals : {};
			state.chromeLiterals =
				doc && typeof doc.chromeLiterals === "object" && doc.chromeLiterals ? doc.chromeLiterals : {};
			state.pluginInfo =
				doc && typeof doc.pluginInfo === "object" && doc.pluginInfo ? doc.pluginInfo : {};
			compiledPatterns = compilePatterns(doc && doc.patterns);
		}

		async function loadDicts(attempt = 0) {
			if (!state.enabled) return;
			try {
				const res = await fetch(`${DICTS_URL}?t=${Date.now()}`, { cache: "no-store" });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const doc = await res.json();
				applyDictDoc(doc);
				writeCache(doc);
				state.ready = true;
				state.failed = null;
				clearRetry();
				refreshRender();
			} catch (error) {
				state.failed = String((error && error.message) || error);
				// 失败退避重试有限次即止（服务器重启瞬间/弱网首载），不引入常驻轮询
				if (attempt < RETRY_DELAYS_MS.length) {
					clearRetry();
					retryTimer = setTimeout(() => {
						retryTimer = null;
						void loadDicts(attempt + 1);
					}, RETRY_DELAYS_MS[attempt]);
				}
			}
		}

		let retryTimer = null;
		function clearRetry() {
			if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
		}

		// ─────────────── 第二层：字面量精确映射（DOM 层） ───────────────
		// 除整词精确匹配外，支持 patterns 正则条目（用于带路径/参数的宿主报错）：
		//   { "match": "^cannot list \"(.+)\": …$", "replace": "无法列出目录：“$1”" }
		// $1~$9 引用捕获组；按声明顺序取第一个命中条目。
		const SKIP_TAGS = new Set([
			"SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT",
			"EMBED", "SVG", "CANVAS", "CODE", "PRE", "KBD", "SAMP", "TEXTAREA",
		]);
		const SKIP_SELECTOR = [...SKIP_TAGS].map((t) => t.toLowerCase()).join(",");
		/** 参与翻译的属性（图标按钮的 tooltip、无障碍标签、占位符）。 */
		const TRANSLATED_ATTRS = ["title", "aria-label", "placeholder", "aria-description"];
		/** 官方用户消息气泡标记：用户输入永不改写（官方 dsh-client-ui-conversation）。 */
		const USER_CONTENT_SELECTOR = '[data-chat-flow-kind="user"]';
		/** 插件自注入的 UI（应用内开关等）不做翻译扫描。 */
		const OWN_UI_SELECTOR = `[${TOGGLE_ATTR}]`;

		/** Text 节点 → { original: 改写前原件, written: 我们写下的译文 }；Element → { attr: 同构 }。 */
		const originalTexts = new Map();
		const originalAttrs = new Map();

		let observer = null;
		let scanTimer = null;
		const pendingRoots = new Set();
		let compiledPatterns = [];

		/** 把词典里的 patterns 条目编译成正则；坏条目跳过并在控制台留痕。 */
		function compilePatterns(entries) {
			const out = [];
			if (!Array.isArray(entries)) return out;
			for (const entry of entries) {
				if (!entry || typeof entry.match !== "string" || typeof entry.replace !== "string") continue;
				try {
					out.push({ re: new RegExp(entry.match, "u"), replace: entry.replace });
				} catch (error) {
					console.warn(`dsh-l10n-zh: 无效的 patterns 条目已跳过（${entry.match}）：`, error);
				}
			}
			return out;
		}

		/**
		 * patterns 单遍匹配：命中即返回替换结果。
		 * 源串全为英文，纯中文文本先用 ASCII 预筛短路，避免逐条跑正则。
		 */
		function matchPatterns(text) {
			if (!compiledPatterns.length || !/[A-Za-z]/.test(text)) return null;
			for (const { re, replace } of compiledPatterns) {
				const out = text.replace(re, replace);
				if (out !== text) return out;
			}
			return null;
		}

		/**
		 * chrome 限定词条（chromeLiterals）的上下文选择器：命中节点自身或其
		 * 祖先匹配它时，chromeLiterals 才参与查找。用于 Read/Write/Edit 这类
		 * 既是工具卡片标题、又可能原样出现在用户对话里的通用单词——按钮、
		 * 标题、表头等“界面骨架”内才翻译，聊天气泡里的用户内容永不触碰。
		 */
		const CHROME_SELECTOR =
			'button,[type="button"],[role="button"],a,h1,h2,h3,h4,h5,h6,label,th,summary,' +
			'[class*="title"],[class*="Title"],[class*="header"],[class*="Header"],[data-tool]';

		function inChrome(node) {
			const el = node.nodeType === 1 ? node : node.parentElement;
			return !!(el && el.closest && el.closest(CHROME_SELECTOR));
		}

		function inUserContent(node) {
			const el = node.nodeType === 1 ? node : node.parentElement;
			return !!(el && el.closest && el.closest(USER_CONTENT_SELECTOR));
		}

		/**
		 * 三段式查找：全局 literals（O(1)）→ chromeLiterals（仅当文本确属
		 * chrome 词表才付出 closest 代价）→ patterns（ASCII 预筛 + 单遍正则）。
		 */
		function lookupLiteral(text, node) {
			if (state.active !== TARGET_LOCALE || !state.enabled || !text) return null;
			if (hasOwn(state.literals, text)) return state.literals[text];
			if (hasOwn(state.chromeLiterals, text) && inChrome(node)) return state.chromeLiterals[text];
			return matchPatterns(text);
		}

		function translateTextNode(node) {
			const raw = node.nodeValue;
			if (!raw || !raw.trim()) return;
			const rec = originalTexts.get(node);
			// 匹配基准永远是"原件"；官方中途改写当前值（≠ 我们写下的译文）时以新值为新原件
			const base = rec ? (raw === rec.written ? rec.original : raw) : raw;
			const hit = lookupLiteral(norm(base), node);
			if (hit == null) {
				if (rec) restoreTextNode(node);
				return;
			}
			if (inUserContent(node)) return; // 用户消息气泡：永不改写
			const next = /^\s*/.exec(raw)[0] + hit + /\s*$/.exec(raw)[0];
			if (rec) { rec.original = base; rec.written = next; }
			else originalTexts.set(node, { original: raw, written: next });
			if (next !== raw) node.nodeValue = next;
		}

		/** 还原仅当当前值仍是我们写下的译文；官方改写过的值原样保留。 */
		function restoreTextNode(node) {
			const rec = originalTexts.get(node);
			if (!rec) return;
			if (node.nodeValue === rec.written && node.nodeValue !== rec.original) {
				node.nodeValue = rec.original;
			}
			originalTexts.delete(node);
		}

		function translateElementAttrs(el) {
			for (const attr of TRANSLATED_ATTRS) {
				const val = el.getAttribute(attr);
				if (val == null) continue;
				let rec = originalAttrs.get(el);
				const entry = rec && hasOwn(rec, attr) ? rec[attr] : null;
				const base = entry ? (val === entry.written ? entry.original : val) : val;
				const hit = lookupLiteral(norm(base), el);
				if (hit == null) {
					if (entry) {
						// 词条没了：仍是我们写的值才还原；官方已改写的值原样保留
						if (val === entry.written) {
							try { el.setAttribute(attr, entry.original); } catch { /* 已脱离文档 */ }
						}
						delete rec[attr];
						if (!Object.keys(rec).length) originalAttrs.delete(el);
					}
					continue;
				}
				if (inUserContent(el)) continue; // 用户消息气泡：永不改写
				if (!rec) { rec = {}; originalAttrs.set(el, rec); }
				rec[attr] = { original: base, written: hit };
				if (val !== hit) {
					try { el.setAttribute(attr, hit); } catch { /* 已脱离文档 */ }
				}
			}
		}

		/**
		 * 节点（含子树）从 DOM 移除时注销登记：先按所有权规则还原，
		 * 再删除登记项——React 移动复用的节点带着原件回去，地图不滞留死节点。
		 */
		function pruneNode(node) {
			if (node.nodeType === Node.TEXT_NODE) { restoreTextNode(node); return; }
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			const rec = originalAttrs.get(node);
			if (rec) {
				for (const [attr, entry] of Object.entries(rec)) {
					try {
						if (node.getAttribute(attr) === entry.written && entry.written !== entry.original) {
							node.setAttribute(attr, entry.original);
						}
					} catch { /* 已脱离文档 */ }
				}
				originalAttrs.delete(node);
			}
			for (const child of node.childNodes) pruneNode(child);
		}

		function walk(root) {
			if (!root || !root.isConnected) return; // 脱离文档的节点不可见也不可还原，跳过
			if (root.nodeType === Node.TEXT_NODE) {
				// 直达路径（characterData / 裸文本新增）：父级跳过规则必须补查
				const p = root.parentElement;
				if (!p || p.isContentEditable || p.closest(SKIP_SELECTOR) || p.closest(OWN_UI_SELECTOR)) return;
				translateTextNode(root);
				return;
			}
			if (root.nodeType !== Node.ELEMENT_NODE) return;
			if (SKIP_TAGS.has(root.tagName) || root.isContentEditable || root.closest(SKIP_SELECTOR) || root.closest(OWN_UI_SELECTOR)) return;
			translateElementAttrs(root);
			// 收集后代文本节点与元素（属性翻译用），先收集后改写，避免 live 树干扰遍历
			const texts = [];
			const els = [];
			const skip = (el) => SKIP_TAGS.has(el.tagName) || el.isContentEditable;
			const visit = (n) => {
				for (const child of n.childNodes) {
					if (child.nodeType === 3) {
						texts.push(child); // 能进树就说明祖先链已验证可译
					} else if (child.nodeType === 1 && !skip(child)) {
						els.push(child);
						visit(child);
					}
				}
			};
			visit(root);
			for (const n of texts) translateTextNode(n);
			for (const el of els) translateElementAttrs(el);
		}

		function flushRoots() {
			scanTimer = null;
			const roots = [...pendingRoots];
			pendingRoots.clear();
			for (const r of roots) walk(r);
		}

		function scheduleWalk(roots) {
			for (const r of roots) if (r && r.nodeType) pendingRoots.add(r);
			if (!scanTimer) scanTimer = setTimeout(flushRoots, 30);
		}

		function scheduleFullScan() {
			if (!observer) return;
			scheduleWalk([document.body]);
		}

		function onMutations(mutations) {
			// 移除注销必须先于一切短路执行：即便在自写回批次里也不能漏
			for (const m of mutations) {
				if (m.removedNodes) for (const n of m.removedNodes) pruneNode(n);
			}
			const roots = [];
			for (const m of mutations) {
				if (m.type === "characterData" || m.type === "attributes") {
					roots.push(m.target);
				} else for (const n of m.addedNodes) if (n.nodeType === 1 || n.nodeType === 3) roots.push(n);
			}
			if (roots.length) scheduleWalk(roots);
			// 幂等收敛保证终止性：自写回产生的记录再扫描时 base/hit 恒等，不再产生写入
		}

		function startDomLayer() {
			walk(document.body);
			observer = new MutationObserver(onMutations);
			observer.observe(document.body, {
				childList: true,
				characterData: true,
				attributes: true,
				attributeFilter: TRANSLATED_ATTRS, // 只看参与翻译的 4 个属性，回调量可控
				subtree: true,
			});
			return () => {
				if (observer) { observer.disconnect(); observer = null; }
				if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
				pendingRoots.clear();
				// 完整还原：先属性后文本；仅回写"仍归我们所有"的值
				for (const [el, rec] of originalAttrs) {
					for (const [attr, entry] of Object.entries(rec)) {
						try {
							if (el.getAttribute(attr) === entry.written && entry.written !== entry.original) {
								el.setAttribute(attr, entry.original);
							}
						} catch { /* 已脱离文档 */ }
					}
				}
				originalAttrs.clear();
				for (const node of [...originalTexts.keys()]) restoreTextNode(node);
			};
		}

		// ───────────────── 翻译运行时（开关可启停） ─────────────────
		let running = false;
		let runtimeDisposers = [];

		function startTranslation() {
			if (running || !localeRef) return;
			running = true;
			const disposers = [];
			disposers.push(installLookupPatch());
			disposers.push(localeRef.subscribe(onLocaleChange));

			// 首屏：先用本地缓存同步上词典并 publish 一次重渲染（消除键级英闪），
			// 随后网络校验覆盖。必须在 lookup 包裹安装之后，重渲染才能命中覆盖表。
			const cached = readCache();
			if (cached) {
				applyDictDoc(cached);
				state.ready = true;
				refreshRender();
			}

			disposers.push(() => { clearRetry(); });
			void loadDicts();
			disposers.push(startDomLayer());
			runtimeDisposers = disposers;
		}

		function stopTranslation(opts = {}) {
			if (!running) return;
			running = false;
			while (runtimeDisposers.length) {
				try { runtimeDisposers.pop()(); } catch { /* 逐项容错，保证余下还原继续 */ }
			}
			runtimeDisposers = [];
			if (opts.reRender !== false) refreshRender(); // t() 文案回官方值（监听器已撤，不会递归）
		}

		// ───────────────── 应用内开关（语言行注入） ─────────────────
		function buildToggle(selectorClass) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.setAttribute(TOGGLE_ATTR, "");
			if (selectorClass) btn.className = selectorClass; // 借官方药丸样式，随官方改版自动跟随
			btn.title = "汉化补全开关（dsh-l10n-zh）";
			btn.onclick = () => setEnabled(!state.enabled, btn);
			renderToggle(btn);
			return btn;
		}

		function renderToggle(btn) {
			if (!btn) return;
			btn.setAttribute("aria-pressed", String(state.enabled));
			const label = state.enabled ? "汉化：开" : "汉化：关";
			if (btn.textContent !== label) btn.textContent = label;
		}

		function setEnabled(v, btn) {
			if (state.enabled === v) return;
			state.enabled = v;
			writeEnabled(v);
			if (v) startTranslation();
			else stopTranslation(); // 含还原 + 重渲染
			renderToggle(btn);
			try { console.info(`dsh-l10n-zh: 已${v ? "开启" : "关闭"}（应用内开关）`); } catch { /* 忽略 */ }
		}

		/** 开关扫描的当前实现（供测试钩子同步驱动；由 installToggleInjector 赋值）。 */
		let toggleCheck = null;
		/** 注入防抖调度器（由 installToggleInjector 赋值；注入函数内部重试时使用）。 */
		let scheduleCheck = () => {};

		/** 在设置弹窗的语言行里注入开关（详见 installToggleInjector）。 */
		function tryToggleInjection(dialog) {
			if (dialog.querySelector(OWN_UI_SELECTOR)) { debugLog("toggle: already"); return; }
			let titleText = null;
			try {
				if (localeRef && typeof localeRef.lookup === "function") {
					titleText = norm(localeRef.lookup("settings.locale", "language.title"));
				}
			} catch (error) { debugLog("toggle: lookup threw", String(error)); return; }
			if (!titleText) { debugLog("toggle: titleText empty"); return; }
			debugLog("toggle: titleText=", JSON.stringify(titleText));
			const candidates = dialog.querySelectorAll("div,span,h1,h2,h3,h4,h5");
			let leafHits = 0;
			for (const el of candidates) {
				if (el.children && el.children.length > 0) continue; // 只匹配纯文本叶子
				if (norm(el.textContent) !== titleText) continue;
				leafHits++;
				const rowText = el.parentElement;
				const row = rowText ? rowText.parentElement : null;
				if (!row || typeof row.contains !== "function" || !row.contains(el)) continue;
				// 复合选择器（button[aria-haspopup]）部分环境不可用，用遍历过滤代替
				const menuBtn = Array.from(row.querySelectorAll("button"))
					.find((b) => b.getAttribute && b.getAttribute("aria-haspopup") === "menu");
				if (!menuBtn) { debugLog("toggle: row 但无 menuBtn"); continue; }
				if (row.querySelector(OWN_UI_SELECTOR)) return; // 本行已有（防重复）
				try {
					// 官方 Menu 组件会给药丸按钮包一层容器（span._root_*）——
					// 插入点取"按钮在该行的顶层祖先"，保证开关紧贴药丸左侧
					let insertRef = menuBtn;
					while (insertRef.parentElement && insertRef.parentElement !== row) {
						insertRef = insertRef.parentElement;
					}
					row.insertBefore(buildToggle(menuBtn.className), insertRef);
					debugLog("toggle: ✅ 已注入");
				} catch (error) {
					// 渐进渲染竞态：查询到的节点在插入前被 React 换掉——下一拍重试
					debugLog("toggle: 注入竞态失败，重试:", String(error).slice(0, 80));
					scheduleCheck(200);
				}
				return;
			}
			debugLog("toggle: 叶子命中", leafHits, "未注入");
		}

		/**
		 * 设置→插件列表 的展开卡片注入一行「描述」（图5）：官方列表只渲染
		 * 插件 id，不显示 package.json 描述。真实 DOM（2026-08-29 实测）：
		 * LI 卡片 > div.cardDetails > dl > div 包裹层 > [dt 标签 + dd 值]，
		 * 插件名在 LI 内、dl 之外。注入 = 在「Cordis 状态」包裹层之后插入
		 * 同构包裹层（样式克隆）；仅注入词典收录的插件，其余不动。
		 */
		const DESC_ATTR = "data-dsh-l10n-zh-desc";
		function tryPluginCardInjection(dialog) {
			if (!state.enabled) return;
			const info = state.pluginInfo;
			if (!info || !Object.keys(info).length) return;
			const hint = dialog.textContent || "";
			if (!(hint.includes("配置状态") || hint.includes("Config status"))) return; // 不在插件页
			// 一次遍历建立叶子文本索引
			const leafMap = new Map();
			for (const x of dialog.querySelectorAll("*")) {
				if (x.children && x.children.length > 0) continue;
				const k = norm(x.textContent || "");
				if (!k) continue;
				if (!leafMap.has(k)) leafMap.set(k, []);
				leafMap.get(k).push(x);
			}
			// 锚点：Cordis 状态行（已挂载插件）与 配置状态行（每张展开卡片都有，
			// 覆盖已停用/未挂载插件）。Cordis 锚点优先处理，描述行位置更靠后。
			const anchors = [];
			for (const k of ["Cordis 状态", "Cordis status", "配置状态", "Config status"]) {
				for (const el of leafMap.get(k) || []) anchors.push(el);
			}
			const doneCards = new Set();
			for (const anchor of anchors) {
				// 包裹层 = dt/dd 的直接父层（官方为 DIV，位于 dl 之内）；
				// 卡片 = 向上第一层"恰好只包含一个插件名"的独占容器。
				// 独占判定防止越界：一旦某层出现 ≥2 个插件名（已跨入别的卡片）即放弃。
				const wrapEl = anchor.parentElement;
				if (!wrapEl) continue;
				const srcLabel = anchor;
				const srcValue = anchor.nextElementSibling || anchor;
				let card = wrapEl.parentElement;
				let name = null;
				for (let d = 0; d < 8 && card && card !== dialog; d++) {
					const keys = new Set(
						[...card.querySelectorAll("*")]
							.filter((x) => x.children && x.children.length === 0)
							.map((x) => norm(x.textContent || ""))
							.filter((k) => hasOwn(info, k))
					);
					if (keys.size === 1) { name = [...keys][0]; break; } // 独占容器 = 卡片边界
					if (keys.size > 1) break;                            // 已越界，拒绝注入
					card = card.parentElement;                           // 尚无插件名，继续向上
				}
				if (!name || !card || !card.contains(wrapEl)) continue;
				if (doneCards.has(card) || card.querySelector(`[${DESC_ATTR}]`)) { doneCards.add(card); continue; }
				doneCards.add(card);
				const desc = info[name];
				try {
					// 状态列表是 dl 网格布局，dt/dd 必须是 dl 的直接子元素——
					// 直接向 dl 插入一对 dt/dd（样式克隆官方 dt/dd），插在锚点行之后
					const host = wrapEl.parentElement;
					const lab = document.createElement(srcLabel.tagName);
					lab.className = srcLabel.className || "";
					lab.textContent = "描述";
					lab.setAttribute(DESC_ATTR, name);
					const val = document.createElement(srcValue.tagName);
					val.className = srcValue.className || "";
					val.textContent = desc;
					host.insertBefore(val, wrapEl.nextSibling);
					host.insertBefore(lab, val);
					debugLog("pluginInfo: ✅ 已注入", name);
				} catch (error) {
					debugLog("pluginInfo: 注入失败（渲染竞态？）", name, String(error).slice(0, 80));
					scheduleCheck(200);
				}
			}
		}

		/**
		 * 注入器：设置弹窗出现时驱动两类增强——语言行开关 + 插件卡片注释。
		 * 锚定均用官方 i18n 文案/页面结构，不依赖哈希类名；找不到锚点静默跳过。
		 */
		function installToggleInjector() {
			const check = () => {
				timer = null;
				if (!document.body) return;
				const dialog = document.querySelector('[role="dialog"]');
				if (!dialog || typeof dialog.querySelectorAll !== "function" || typeof dialog.querySelector !== "function") return;
				try { tryToggleInjection(dialog); } catch (error) { debugLog("toggle: 💥", String(error && error.stack || error).slice(0, 160)); }
				try { tryPluginCardInjection(dialog); } catch (error) { debugLog("pluginInfo: 💥", String(error && error.stack || error).slice(0, 160)); }
			};
			toggleCheck = check;
			scheduleCheck = (delay = 50) => { if (!timer) timer = setTimeout(check, delay); };
			let timer = null;
			const obs = new MutationObserver(scheduleCheck);
			obs.observe(document.body, { childList: true, subtree: true });
			scheduleCheck();
			return () => {
				if (timer) { clearTimeout(timer); timer = null; }
				obs.disconnect();
				try {
					document.querySelectorAll(`${OWN_UI_SELECTOR},[${DESC_ATTR}]`).forEach((n) => n.remove());
				} catch { /* 已随弹窗卸载 */ }
			};
		}

		// ───────────────────────── 插件本体 ─────────────────────────
		function onLocaleChange() {
			state.active = localeRef.getLocale().active;
			// 只做 DOM 层全量扫描（zh→en 借词条缺失自动还原、en→zh 全量翻译）。
			// 切勿在此 publish：订阅回调里再 publish 会同步自递归；
			// t() 文案的重渲染由官方 locale 切换自身的 publish 驱动。
			if (running) scheduleFullScan();
		}

		function apply(ctx) {
			localeRef = ctx.locale;
			if (!localeRef || typeof localeRef.lookup !== "function" || typeof localeRef.subscribe !== "function") {
				ctx.logger?.warn?.("dsh-l10n-zh: locale 服务不可用，插件保持惰性（不影响官方功能）");
				return;
			}
			state.active = localeRef.getLocale().active;
			state.enabled = readEnabled();

			// 开关注入器独立于翻译运行时：关=只停翻译，开关本身仍在设置页
			ctx.effect(() => installToggleInjector());

			ctx.effect(() => {
				if (state.enabled) {
					startTranslation();
					ctx.logger?.info?.(
						`dsh-l10n-zh: 已激活 — 双层翻译就绪${state.ready ? "（缓存先行）" : "（词典拉取中…）"}`,
					);
				}
				// cordis 真卸载：连开关一起撤 + 清本地缓存
				return () => {
					stopTranslation({ reRender: false });
					clearCache();
				};
			});
		}

		return {
			name: PLUGIN_ID,
			inject: ["locale"],
			apply,
			/** 供离线自测/模拟推演内省与确定性驱动；运行时无消费者。 */
			__l10nTest: {
				state,
				loadDicts,
				flushNow: () => walk(document.body),
				walk,
				compiledPatterns: () => compiledPatterns,
				stats: () => ({ text: originalTexts.size, attrs: originalAttrs.size }),
				pendingRetry: () => retryTimer != null,
				scanToggle: () => { if (toggleCheck) toggleCheck(); }, // 同步驱动开关扫描（测试钩子）
				startTranslation,
				stopTranslation,
			},
		};
	},
});
