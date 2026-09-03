# dsh-zh-gloss — DeepSeek Harness Web UI 中文汉化释义插件

> 热插拔 · 零改动官方源码 · 卸载逐字节还原

## 前言

> [!IMPORTANT]
> 本项目为**非官方社区插件**，与 DeepSeek 官方无任何关联。官方 dsh 处于开发者预览期，
> 升级可能带来行为变化，请配合 [体检命令](https://github.com/iiiiiei/dsh-zh-gloss/wiki#07--体检命令) 使用。

## 目录

| 章节 | 内容 |
|---|---|
| [01 · 一键安装](https://github.com/iiiiiei/dsh-zh-gloss/wiki#01--一键安装) | 三步装好，两分钟见效 |
| [02 · 使用指南](https://github.com/iiiiiei/dsh-zh-gloss/wiki#02--使用指南) | 应用内开关 · 插件注释 · 词典热更新 · 覆盖范围 |
| [03 · 架构与原理](https://github.com/iiiiiei/dsh-zh-gloss/wiki#03--架构与原理) | 官方 i18n 机制 · 双层翻译 · 可逆性保证 |
| [04 · 构建与发版](https://github.com/iiiiiei/dsh-zh-gloss/wiki#04--构建与发版) | 目录结构 · 测试矩阵 · 开发循环 |
| [05 · 更新机制](https://github.com/iiiiiei/dsh-zh-gloss/wiki#05--更新机制) | 官方 dsh 升级后的三道防线与标准流程 |
| [06 · 安全与风险](https://github.com/iiiiiei/dsh-zh-gloss/wiki#06--安全与风险) | 代码触面 · 攻击面分析 · 信任边界 |
| [07 · 体检命令](https://github.com/iiiiiei/dsh-zh-gloss/wiki#07--体检命令) | Doctor：/status 判读 · 快速故障对照 |
| [08 · 常见问题](https://github.com/iiiiiei/dsh-zh-gloss/wiki#08--常见问题) | FAQ |
| [09 · 版本历史](https://github.com/iiiiiei/dsh-zh-gloss/wiki#09--版本历史) | Changelog v0.1.0 → v0.4.5 |

## 它是什么

面向 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 官方 Web UI
的**中文补全插件**。官方已内置 zh/en 双语体系，本插件只补四类漏网之鱼：

- ✅ **键在、zh 值没翻译**——轨迹工具栏按钮、cordis 面板计数等（键级覆盖）
- ✅ **硬编码英文**——System Prompt / Raw Output 等标签页标题（字面量映射）
- ✅ **后端下发数据文案**——斜杠命令释义、执行回执、权限预设、工具卡片标题
- ✅ **官方不渲染的信息**——设置→插件列表的 169 个插件描述（DOM 注入）

外加：**应用内开关**（设置→通用设置→语言行左侧，「汉化：开/关」热启停）、
**词典热更新**（改 JSON 刷新即生效）、**官方补译自动让位**（追赶自愈）、
**首屏缓存**（无英文闪烁）、**卸载逐字节还原**（123 项自动化测试保证）。

## 它是如何工作的

一切顺着官方机制顺势而为：不重注册官方字典（官方 `register` 遇重复会抛错），
只给 `LocaleRuntime.lookup` 套一层"命中即覆盖、未命中即透传"的运行时包裹；
再挂一个 MutationObserver 对不走 t() 的硬编码/后端文案做整词精确替换。
最坏故障模式 = 个别文案回到英文，**永远不会白屏**。
详见 [03 · 架构与原理](https://github.com/iiiiiei/dsh-zh-gloss/wiki#03--架构与原理)。

## 安全与风险

零运行时依赖、零构建步骤，全部运行时代码就两个 JS 文件（~940 行）逐行可审计；
只新增两条只读 GET 路由；不写文件、无遥测、不触碰凭据。
完整分析见 [06 · 安全与风险](wiki/06-安全与风险.md)。

## 注意事项

- 针对 `@deepseek-ai/dsh@0.1.2-rc.1`（npx 形态）验证；官方升级后
  `/api/l10n-zh/status` 的 `drift` 字段会提示重跑扫描器；
- 仅当界面语言为**中文**时生效，English 模式零行为；
- 不翻译用户聊天内容、代码块、路径与命令输出（有硬护栏）。

## 免责声明

按 "AS IS" 提供，不附任何担保。因使用本插件造成的任何直接或间接损失，
作者不承担责任。卸载即完全还原官方原状。

## 查看更多

| 报告 | 内容 |
|---|---|
| [`reports/value-gaps.txt`](reports/value-gaps.txt) | 官方包键级+值级缺口全量清单 |
| [`reports/directory-picker-findings.md`](reports/directory-picker-findings.md) | "访达面板"专项调研（系统级边界） |
| [`reports/backend-strings/findings.md`](reports/backend-strings/findings.md) | 后端下发英文文案采集 |
| [`reports/audit-2026-08-28.md`](reports/audit-2026-08-28.md) | 全量审计报告与修复记录 |

> 仓库命名：dsh-zh-gloss（gloss=释义）；插件包名/Loader id 仍为 dsh-l10n-zh / l10n-zh（历史沿革，改动是破坏性迁移故保留）。

## 友情链接

- 官方上游：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

## 许可证

[MIT](LICENSE)，与上游 dsh 一致。
