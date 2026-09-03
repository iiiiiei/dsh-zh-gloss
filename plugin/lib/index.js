/**
 * dsh-l10n-zh — DSH Web UI 中文汉化补全插件（宿主侧 / Node 半边）
 *
 * 职责只有一个：把 dicts/ 目录里的词典 JSON **每次请求都现读磁盘**，
 * 合并后通过 GET /api/l10n-zh/dicts 提供给浏览器半边。
 *
 * 为什么不把词典打进 client bundle？
 *   官方客户端模块以内容哈希 (?rev=sha1) 做缓存击穿，改一行文案就要重启
 *   服务器才能刷新 rev。把词典放到运行时接口后面，就得到「改 JSON → 刷新
 *   网页即生效」的词典级热更新，插件本体保持稳定。
 *
 * 热插拔语义（与 cordis 生命周期对齐）：
 *   - 安装：cordis.patch.yml 增加 insert 条目并加载 → apply 执行，路由出现；
 *   - 卸载：移除条目重新加载 → ctx.effect 登记的 disposer 撤销路由注册。
 *
 * 韧性（fail-inert）：
 *   - webServer.register 契约若随官方升级变动，这里捕获异常并降级为
 *     惰性（仅 log warn），绝不向 cordis 抛错——与浏览器半边的护栏对齐。
 *   - /status 回显官方 dsh 版本与插件验证基线，升级后漂移一眼可见。
 *
 * 已知机制依据：
 *   - webServer 服务与 register({kind:"exact",path,handler}) 契约同
 *     dsh-desktop-bridge 的用法（官方 profile 内第三方插件的既有先例）；
 *   - ctx.effect(callback) 会**立即执行 callback 并把其返回值当作 disposer**
 *     保存 —— 因此所有注册调用都必须包在箭头函数里返回登记结果。
 */
import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsh-l10n-zh";
export const inject = ["webServer"];

/** 词典目录随插件走：无论被拷贝/链接到哪个 node_modules 都能自举。 */
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DICTS_DIR = process.env.DSH_L10N_DICTS_DIR || join(PLUGIN_ROOT, "dicts");

/** 插件针对该官方版本完成过覆盖验证；官方升级后请更新并重跑 tools/scan-locale-gaps.mjs。 */
const VERIFIED_BASELINE = "0.1.2-alpha.5";

/**
 * 读官方 dsh 版本号（仅用于 /status 漂移提示；读不到时返回 null，不影响路由）。
 * 先 realpath 解开 pnpm/yarn 符号链接，再从真实的 node_modules 根向上探测：
 * 优先 @deepseek-ai/dsh 主包；alpha 系部署形态内层常只有子包，则取同批发布的
 * dsh-client-locale / dsh-web-app / dsh-agent 版本（同一流水线，版本一致）。
 */
async function officialDshVersion() {
  let root = PLUGIN_ROOT;
  try {
    root = dirname(await realpath(join(PLUGIN_ROOT, "package.json")));
  } catch { /* 无 package.json 或不支持：按原样探测 */ }
  const scopes = [
    join(root, "..", "@deepseek-ai"),
    join(root, "..", "..", "@deepseek-ai"),
  ];
  const probes = ["dsh", "dsh-client-locale", "dsh-web-app", "dsh-agent"];
  for (const scope of scopes) {
    for (const probe of probes) {
      try {
        const doc = JSON.parse(await readFile(join(scope, probe, "package.json"), "utf8"));
        if (typeof doc.version === "string") return doc.version;
      } catch { /* 布局不同/未安装：尝试下一个 */ }
    }
  }
  return null;
}

/** 单个词典文件的规范结构；解析失败时给出可读错误而不是让路由 500 一整片。 */
function normalizeDictFile(raw) {
  const doc = JSON.parse(raw);
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error("顶层必须是对象");
  }
  return doc;
}

/**
 * 读取并合并 dicts/ 下全部 *.json。
 * 合并规则：
 *   - `ui` 命名空间树按 namespace → key 浅合并（后读的文件覆盖先读的）；
 *   - `literals` 平面映射同理；
 *   - 其余顶层字段视为 meta，同名时后读覆盖。
 * 文件名排序保证合并顺序稳定（例如 01-core.json 先于 99-personal.json）。
 */
async function readDicts() {
  const ui = {};
  const literals = {};
  const chromeLiterals = {};
  const patterns = [];
  const pluginInfo = {};
  const meta = { files: [] };
  let names = [];
  try {
    names = (await readdir(DICTS_DIR)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    // 目录不存在（例如用户清空了词典）→ 返回空词典而非报错，保持 UI 可用。
    return { version: 1, ui, literals, chromeLiterals, patterns, pluginInfo, meta };
  }
  for (const filename of names) {
    const path = join(DICTS_DIR, filename);
    let doc;
    try {
      doc = normalizeDictFile(await readFile(path, "utf8"));
    } catch (error) {
      meta.files.push({ file: filename, error: `解析失败：${error.message}` });
      continue;
    }
    if (doc.ui && typeof doc.ui === "object") {
      for (const [ns, entries] of Object.entries(doc.ui)) {
        if (entries && typeof entries === "object" && !Array.isArray(entries)) {
          ui[ns] = { ...ui[ns], ...entries };
        }
      }
    }
    if (doc.literals && typeof doc.literals === "object") {
      Object.assign(literals, doc.literals);
    }
    if (doc.chromeLiterals && typeof doc.chromeLiterals === "object") {
      Object.assign(chromeLiterals, doc.chromeLiterals);
    }
    // 插件注释（设置→插件列表注入用）：pluginInfo[插件id] = 中文描述
    if (doc.pluginInfo && typeof doc.pluginInfo === "object" && !Array.isArray(doc.pluginInfo)) {
      Object.assign(pluginInfo, doc.pluginInfo);
    }
    // 正则条目跨文件按文件序拼接；同文件内保持声明顺序（先声明者优先命中）。
    if (Array.isArray(doc.patterns)) patterns.push(...doc.patterns);
    let mtimeMs;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {}
    meta.files.push({ file: filename, mtimeMs });
  }
  meta.dictCount = Object.keys(ui).length;
  meta.literalCount = Object.keys(literals).length;
  meta.chromeLiteralCount = Object.keys(chromeLiterals).length;
  meta.patternCount = patterns.length;
  meta.pluginInfoCount = Object.keys(pluginInfo).length;
  return { version: 1, ui, literals, chromeLiterals, patterns, pluginInfo, meta };
}

/** 组装 JSON 响应的小工具（no-store：词典随时可能被编辑）。 */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

/** 官方契约变更时的护栏：注册失败只降级告警，绝不向 cordis 抛错。 */
function safeRegister(ctx, definition) {
  try {
    return ctx.webServer.register(definition);
  } catch (error) {
    ctx.logger?.warn?.(
      `dsh-l10n-zh: 路由注册失败（${definition?.path}），插件保持惰性：${error?.message ?? error}`,
    );
    return null;
  }
}

export function apply(ctx) {
  /** GET /api/l10n-zh/dicts — 浏览器半边的唯一数据源。现读磁盘，永不缓存。 */
  ctx.effect(() =>
    safeRegister(ctx, {
      kind: "exact",
      path: "/api/l10n-zh/dicts",
      handler: async (_req, res) => {
        try {
          sendJson(res, 200, await readDicts());
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
  );

  /** GET /api/l10n-zh/status — 部署体检用：词典条数、文件清单、解析错误、版本漂移。 */
  ctx.effect(() =>
    safeRegister(ctx, {
      kind: "exact",
      path: "/api/l10n-zh/status",
      handler: async (_req, res) => {
        const dict = await readDicts();
        const official = await officialDshVersion();
        sendJson(res, 200, {
          ok: true,
          plugin: name,
          dictsDir: DICTS_DIR,
          officialDshVersion: official,
          pluginBaseline: VERIFIED_BASELINE,
          // true=官方版本已偏离验证基线（建议重跑扫描器核对）；null=无法探测
          drift: official ? official !== VERIFIED_BASELINE : null,
          ...dict.meta,
        });
      },
    }),
  );

  ctx.logger?.info?.(
    `dsh-l10n-zh: 词典服务就绪（GET /api/l10n-zh/dicts，目录 ${DICTS_DIR}）`,
  );
}
