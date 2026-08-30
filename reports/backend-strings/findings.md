# 调研报告 · 后端下发英文数据文案（子代理汇总）

> 只读分析产出；基线 `@deepseek-ai/dsh@0.1.1-rc.2`。本文件是关键结论存档，
> 原始逐条字符串见同目录 `commands.txt`、`tool-labels.txt`。

## 关键纠正

1. **设置→插件的「库存」标签页渲染的是 Loader 的 moduleName（包名）**，
   package.json description 属 npm/CLI 侧自述文案，不在 Web 界面显示。
   因此本插件不为 197 条包描述建词条（避免词典膨胀）。
2. `dsh-agent-tool-presentation` 只是 presentAs(native|code) 模式选择器，
   不含每工具元数据。工具卡片展示名硬编码在 **dsh-client-ui-tool**
   （VARIANT_TITLES / TOOL_TITLES / SEARCH_TITLES / WEB_TITLES）；
   工具长描述由各 dsh-tool-* 注册后随 wire 下发。

## 已入库覆盖（dicts/10-backend-copy.json）

- 斜杠命令释义 ×6（compact/goal/feedback/plan/permission/export；
  `/model` 官方已走 t() 无需处理）
- 命令执行回执 ×30+：compact（含 Usage）、goal 全套状态回执、feedback 分享三态、
  plan 模式进出与评审问答串、export 提示
- 权限预设描述 ×3（workspace-write / danger-full-access / custom 未匹配提示）
- 工具卡片标题：通用回退 Tool call、Inspect、Fetch、Run/Stop/Remove Cordis Plugin
  （全局精确）；Read/Write/Edit/Search/Code 七个通用词入 **chromeLiterals**
  （仅按钮/标题等界面骨架上下文生效，永不触碰聊天气泡里的用户内容）
- patterns：`Compacted N history items (~X tokens).`

## 明确不译（决策记录）

| 项 | 原因 |
|---|---|
| Bash / Pwsh / Grep / Glob | 产品专名，官方 zh 文案同样保留 |
| Full access | 官方中文文案即保留该英文术语（“确认启用 Full access？”），保持一致 |
| 技能行 description | SKILL.md frontmatter 是用户数据；仅「仅用户」前缀官方已汉化 |
| 工具长描述（模型 schema 文案） | 截断句干无法精确匹配整句；如界面出现漏网，按 wiki03 用完整原句补条目即可 |

## 斜杠菜单结论

MENU_NS=`slash.menu` zh 完整（命令/技能/子智能体/正在加载…/触发候选建议）；
菜单可见英文只剩命令 description（本次已覆盖）与技能描述（用户数据，不处理）。
