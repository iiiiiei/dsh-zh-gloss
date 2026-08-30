# 真实使用模拟推演（browser simulation）

在**真实浏览器**里驱动**真插件 bundle（plugin/lib/client.js）+ 真词典（plugin/dicts/）**，
对照仿真的官方宿主环境（ModuleLoader / LocaleRuntime / t() 渲染 / 会话流 DOM 结构）做黑盒推演。
与 `tests/selftest.mjs`（离线确定性断言）互补：这里验证的是真实 MutationObserver、
真实定时器、真实 localStorage、真实 fetch 下的行为。

## 运行

```bash
node tests/simulation/server.mjs [端口=8931]
# 浏览器打开：
#   http://127.0.0.1:8931/                        全量推演 S1–S13（约 1 分钟）
#   http://127.0.0.1:8931/?hostile=1              敌意环境 S14（locale 契约破坏 → 必须惰性）
#   先访问 / 再访问 /?phase=cache&delaydicts=2500 首屏缓存 S15（词典扣住 2.5s 仍即时中文）
```

结果写在页面右侧面板（`#sim-results`），`document.title` 变为 `SIM-DONE n✓/m✗` 即跑完。
注意：窗格隐藏时 Chrome 会把 `setTimeout` 节流到 ≥1s/次，套件已改为条件驱动（waitFor 实际
状态而非盲等），但跑完需要更久；尽量保持窗格可见。

## 场景矩阵

| 组 | 验证点 |
|---|---|
| S1 | 键级覆盖（zh 缺口 → 中文；未覆盖键走官方链） |
| S2–S3 | 字面量整词替换；patterns 正则（Compacted N history items） |
| S4 | chrome 作用域（工具卡片 Read→读取；普通段落 Read 不动） |
| S5 | 用户气泡硬护栏（`data-chat-flow-kind="user"` 内文本/属性永不改写） |
| S6–S7 | 代码块与 contentEditable 跳过（含动态更新后的直达路径） |
| S8 | 属性翻译 + 官方改写 title 后按新值再基准化重译（attributeFilter 观察通路） |
| S9 | 后端下发数据文案（命令释义 / 执行回执 / 权限预设描述） |
| S10 | 官方补译让位（官方 zh 含汉字 → 插件退位；仍是英文 → 插件词条） |
| S11 | 词典热更新（overlay 模拟编辑 dicts → 重拉即生效；词条移除回退英文） |
| S12 | 内存稳定（240 节点 churn 后登记数回到基线，中途不单调增长） |
| S13 | 卸载逐字节还原 + 查找链引用同一 + 缓存清除 + 重装恢复 |
| S14 | 敌意环境：官方 locale 服务缺 lookup → apply 不抛错、插件惰性、零 error |
| S15 | 首屏缓存：网络词典扣住 2.5s 时键级/字面量已是中文，随后网络校验 |
| 手动 | 词典 500 故障 → `failed=HTTP 500` + 退避重试挂起 → 故障解除自动恢复 |

## 已知环境现象（非插件缺陷）

- 隐藏窗格里 Chrome 节流定时器，插件的 30ms 去抖扫描同样被推迟——
  后台标签页翻译会迟到但保证收敛；对前台使用无影响，客观上还降低了后台功耗。
- S13 的字节级对比把推演脚本自己改过的元素（S6/S7）先恢复原状再比对，
  对照基准只反映插件经手的部分。
