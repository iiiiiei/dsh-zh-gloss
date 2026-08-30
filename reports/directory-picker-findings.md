# 调研报告 · 「添加工作区」访达页面专项

> 由子代理对官方包逐行核对后产出（2026-08）。结论可直接指导词典维护。

## 场景结论

「访达页面」**不是**浏览器内组件，也**不是宿主新开的网页**——三个 host 包
（native / browse / auto）的 Node 侧均无打开浏览器窗口的逻辑，也无内联 HTML 模板。

真实链路：`dsh-host-directory-picker-auto` 启动探测（本地 Mac ⇒ native）→
点击添加工作区 → 客户端经 RPC `api.host.pickDirectory` 调到宿主 →
宿主执行：

```
osascript -e 'set selectedFolder to choose folder with prompt "Select Workspace Directory"'
```

弹出 **macOS 原生「选取文件夹」面板**——这就是用户看到的“访达页面”。

## 各路径 i18n 状态

| 路径 | 状态 |
|---|---|
| 浏览器内浏览式选择器 `directory-browser` 命名空间 | **zh 完整**，无需处理 |
| native 客户端占位（dsh-client-ui-directory-picker-native） | 零可见文案（renderless） |
| macOS 原生面板 prompt | 宿主硬编码英文；网页插件不可达（系统级边界） |
| 流程错误弹窗 | 宿主英文串经 wire 透传 → **本插件以 patterns 层汉化（已交付 12 条）** |

## 触发入口（均已有 zh）

侧栏「＋」（`workspace.add`=添加工作区）/ hero 菜单「添加工作区…」→
失败弹窗标题 `Couldn't open folder`=无法打开文件夹、按钮 `Choose again`=重新选择 等，
键集完整。

## 已入库的宿主报错原文（patterns 来源）

- `native directory picker aborted`
- `native directory picker aborted (dialog unresponsive; worker killed)`
- `win32 folder dialog failed: ${message}`
- `win32 folder dialog worker exited before reporting a result`
- `no supported native directory picker found (install zenity or kdialog)`
- `native directory picker is unsupported on ${platform}`
- `cannot list "${path}": not a fully qualified path`
- `cannot create under "${path}": not a fully qualified parent path`
- `"${name}" is not a single path segment`
- `${target} already exists` / `cannot create ${target}: …`
- `directory picker failed: ${…}`（client-runtime 前缀）
