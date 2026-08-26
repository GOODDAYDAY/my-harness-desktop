# 目录结构说明

> 前后端分离改造后的完整目录结构。源码共 797 个文件，全量列出（不缩写）。

## 顶层一级目录

```text
.
├── .claude
├── .github
├── .playwright-mcp
├── .worktrees
├── assets
├── dist
├── docs
├── out
├── packages
├── scripts
└── src

12 directories
```

## 依赖方向（不变，仍然只向内）

```
packages/shared  ←  src/web          （前端 import 契约 + wire）
packages/shared  ←  src/server       （后端 import 契约 + wire）
packages/react   ←  src/web          （前端 import 组件/API）
packages/shared + react  ←  src/plugins   （插件 import 契约 + 组件）

src/web 和 src/server 之间：代码上零 import，只靠 shared 契约 + 运行时 WS 通信
```

## 目录职责速查

| 目录 | 职责 |
|---|---|
| `src/server/application/` | 后端用例编排（sessions/config/loader/models/theme/i18n/...） |
| `src/server/kernel/` | 内核域（abstract-backend + kernel-manager + pi/ + dsh/） |
| `src/server/routing/` | 传输无关的 channel 路由（gateway） |
| `src/server/remote/` | web 鉴权（auth/token/password/rate-limiter/remote-config） |
| `src/server/transport/` | 传输（http + ws 拆开） |
| `src/server/controllers/` | controller 层（14 个 channel 域） |
| `src/server/client/` | 外部适配器（fs/git/npm/remote/paths） |
| `src/server/bootstrap/` | 组装根（assemble + electron/server 入口 + host + kernel 注册表） |
| `src/web/` | 前端（transport/kernel/components/stores/ui） |
| `src/plugins/` | 内容层壳插件 |
| `packages/shared/` | 圆心 workspace 包（domain + channel + wire + paths + style-presets） |
| `packages/react/` | React 发布面（组件/hooks/stores + KernelApi） |
| `packages/my-harness-fit-pi-extension/` | pi 内核桌面适配扩展 |

## 完整源码树（src/ + packages/，全量）

```text
src
├── plugins
│   ├── insight
│   │   ├── blind-review
│   │   │   ├── client
│   │   │   │   └── squad-runner.ts
│   │   │   ├── core
│   │   │   │   ├── assemble.ts
│   │   │   │   ├── config.ts
│   │   │   │   └── run-state.ts
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── review.json
│   │   │   │   │   └── settings.json
│   │   │   │   ├── en
│   │   │   │   │   ├── review.json
│   │   │   │   │   └── settings.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── review.json
│   │   │   │   │   └── settings.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── review.json
│   │   │   │       └── settings.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── llm-recorder
│   │   │   ├── core
│   │   │   │   ├── log-model.test.ts
│   │   │   │   ├── log-model.ts
│   │   │   │   ├── payload-model.test.ts
│   │   │   │   └── payload-model.ts
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── panel.json
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── settings.json
│   │   │   │   ├── en
│   │   │   │   │   ├── panel.json
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── settings.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── panel.json
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── settings.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── panel.json
│   │   │   │       ├── plugin.json
│   │   │   │       └── settings.json
│   │   │   ├── pi-extension
│   │   │   │   └── index.ts
│   │   │   ├── renderer
│   │   │   │   ├── index.tsx
│   │   │   │   ├── payload-views.tsx
│   │   │   │   └── record-modal.tsx
│   │   │   ├── extension-flow.test.ts
│   │   │   └── plugin.json
│   │   └── token-stats
│   │       ├── locales
│   │       │   ├── de
│   │       │   │   ├── plugin.json
│   │       │   │   ├── shell.json
│   │       │   │   ├── stats.json
│   │       │   │   └── system.json
│   │       │   ├── en
│   │       │   │   ├── plugin.json
│   │       │   │   ├── shell.json
│   │       │   │   ├── stats.json
│   │       │   │   └── system.json
│   │       │   ├── zh-CN
│   │       │   │   ├── plugin.json
│   │       │   │   ├── shell.json
│   │       │   │   ├── stats.json
│   │       │   │   └── system.json
│   │       │   └── zh-TW
│   │       │       ├── plugin.json
│   │       │       ├── shell.json
│   │       │       ├── stats.json
│   │       │       └── system.json
│   │       ├── renderer
│   │       │   ├── context-usage-bar.tsx
│   │       │   ├── hover-tip.tsx
│   │       │   ├── index.tsx
│   │       │   └── stats-titlebar.tsx
│   │       └── plugin.json
│   ├── manager
│   │   ├── dsh-manager
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── dsh.json
│   │   │   │   │   └── ext.json
│   │   │   │   ├── en
│   │   │   │   │   ├── dsh.json
│   │   │   │   │   └── ext.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── dsh.json
│   │   │   │   │   └── ext.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── dsh.json
│   │   │   │       └── ext.json
│   │   │   ├── renderer
│   │   │   │   ├── extensions.tsx
│   │   │   │   ├── index.tsx
│   │   │   │   ├── kernel.tsx
│   │   │   │   └── models.tsx
│   │   │   └── plugin.json
│   │   ├── pi-manager
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── ext-settings.json
│   │   │   │   │   ├── ext.json
│   │   │   │   │   ├── kernel.json
│   │   │   │   │   ├── models-settings.json
│   │   │   │   │   ├── models.json
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── shell.json
│   │   │   │   ├── en
│   │   │   │   │   ├── ext-settings.json
│   │   │   │   │   ├── ext.json
│   │   │   │   │   ├── kernel.json
│   │   │   │   │   ├── models-settings.json
│   │   │   │   │   ├── models.json
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── shell.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── ext-settings.json
│   │   │   │   │   ├── ext.json
│   │   │   │   │   ├── kernel.json
│   │   │   │   │   ├── models-settings.json
│   │   │   │   │   ├── models.json
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── shell.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── ext-settings.json
│   │   │   │       ├── ext.json
│   │   │   │       ├── kernel.json
│   │   │   │       ├── models-settings.json
│   │   │   │       ├── models.json
│   │   │   │       ├── plugin.json
│   │   │   │       ├── settings.json
│   │   │   │       └── shell.json
│   │   │   ├── renderer
│   │   │   │   ├── extensions.tsx
│   │   │   │   ├── index.tsx
│   │   │   │   └── models.tsx
│   │   │   └── plugin.json
│   │   ├── plugin-manager
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── pluginManager.json
│   │   │   │   │   └── settings.json
│   │   │   │   ├── en
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── pluginManager.json
│   │   │   │   │   └── settings.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── pluginManager.json
│   │   │   │   │   └── settings.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── plugin.json
│   │   │   │       ├── pluginManager.json
│   │   │   │       └── settings.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── skill-manager
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── settings.json
│   │   │   │   ├── en
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── settings.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── settings.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── plugin.json
│   │   │   │       └── settings.json
│   │   │   ├── renderer
│   │   │   │   ├── index.tsx
│   │   │   │   └── skill-aux.tsx
│   │   │   └── plugin.json
│   │   ├── theme-manager
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── theme.json
│   │   │   │   ├── en
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── theme.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── theme.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── plugin.json
│   │   │   │       ├── settings.json
│   │   │   │       └── theme.json
│   │   │   ├── renderer
│   │   │   │   ├── tabs
│   │   │   │   │   ├── font-tab.tsx
│   │   │   │   │   ├── sidebar-tab.tsx
│   │   │   │   │   ├── sidepanel-tab.tsx
│   │   │   │   │   ├── theme-tab.tsx
│   │   │   │   │   └── timeline-tab.tsx
│   │   │   │   ├── index.tsx
│   │   │   │   ├── sidebar-style-preview.tsx
│   │   │   │   ├── sidepanel-style-preview.tsx
│   │   │   │   └── theme-preview.tsx
│   │   │   └── plugin.json
│   │   └── tool-manager
│   │       ├── core
│   │       │   ├── types.test.ts
│   │       │   └── types.ts
│   │       ├── locales
│   │       │   ├── de
│   │       │   │   ├── plugin.json
│   │       │   │   ├── settings.json
│   │       │   │   └── toolManager.json
│   │       │   ├── en
│   │       │   │   ├── plugin.json
│   │       │   │   ├── settings.json
│   │       │   │   └── toolManager.json
│   │       │   ├── zh-CN
│   │       │   │   ├── plugin.json
│   │       │   │   ├── settings.json
│   │       │   │   └── toolManager.json
│   │       │   └── zh-TW
│   │       │       ├── plugin.json
│   │       │       ├── settings.json
│   │       │       └── toolManager.json
│   │       ├── renderer
│   │       │   └── index.tsx
│   │       └── plugin.json
│   ├── project
│   │   ├── file-preview
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   └── preview.json
│   │   │   │   ├── en
│   │   │   │   │   └── preview.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   └── preview.json
│   │   │   │   └── zh-TW
│   │   │   │       └── preview.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── file-tree
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── files.json
│   │   │   │   │   └── plugin.json
│   │   │   │   ├── en
│   │   │   │   │   ├── files.json
│   │   │   │   │   └── plugin.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── files.json
│   │   │   │   │   └── plugin.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── files.json
│   │   │   │       └── plugin.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── git-review
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── review.json
│   │   │   │   │   └── system.json
│   │   │   │   ├── en
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── review.json
│   │   │   │   │   └── system.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── review.json
│   │   │   │   │   └── system.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── plugin.json
│   │   │   │       ├── review.json
│   │   │   │       └── system.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── projects
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── projects.json
│   │   │   │   ├── en
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── projects.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── projects.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── plugin.json
│   │   │   │       └── projects.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   └── stickers
│   │       ├── client
│   │       │   ├── stickers-store.test.ts
│   │       │   └── stickers-store.ts
│   │       ├── locales
│   │       │   ├── de
│   │       │   │   ├── settings.json
│   │       │   │   └── stickers.json
│   │       │   ├── en
│   │       │   │   ├── settings.json
│   │       │   │   └── stickers.json
│   │       │   ├── zh-CN
│   │       │   │   ├── settings.json
│   │       │   │   └── stickers.json
│   │       │   └── zh-TW
│   │       │       ├── settings.json
│   │       │       └── stickers.json
│   │       ├── renderer
│   │       │   ├── index.tsx
│   │       │   ├── sticker-card.tsx
│   │       │   ├── sticker-composer-button.tsx
│   │       │   └── sticker.tsx
│   │       └── plugin.json
│   ├── sessions
│   │   ├── ask
│   │   │   ├── pi-extension
│   │   │   │   └── index.ts
│   │   │   ├── renderer
│   │   │   │   ├── ask-host.tsx
│   │   │   │   ├── ask-question-card.tsx
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── continue
│   │   │   ├── locales
│   │   │   │   ├── en
│   │   │   │   │   └── shell.json
│   │   │   │   └── zh-CN
│   │   │   │       └── shell.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── goal
│   │   │   ├── pi-extension
│   │   │   │   ├── goal-fold.test.ts
│   │   │   │   ├── goal-fold.ts
│   │   │   │   ├── goal-store.ts
│   │   │   │   └── index.ts
│   │   │   ├── renderer
│   │   │   │   ├── goal-card.tsx
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── graphviz
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   └── plugin.json
│   │   │   │   ├── en
│   │   │   │   │   └── plugin.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   └── plugin.json
│   │   │   │   └── zh-TW
│   │   │   │       └── plugin.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── im-graph
│   │   │   ├── client
│   │   │   │   └── bus-observer.ts
│   │   │   ├── core
│   │   │   │   ├── flow-events.test.ts
│   │   │   │   ├── flow-events.ts
│   │   │   │   ├── graph-model.test.ts
│   │   │   │   └── graph-model.ts
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   └── panel.json
│   │   │   │   ├── en
│   │   │   │   │   └── panel.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   └── panel.json
│   │   │   │   └── zh-TW
│   │   │   │       └── panel.json
│   │   │   ├── renderer
│   │   │   │   ├── EventFlow.tsx
│   │   │   │   ├── GraphCanvas.tsx
│   │   │   │   ├── im-graph.css
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── markdown
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── shell.json
│   │   │   │   ├── en
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── shell.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── shell.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── plugin.json
│   │   │   │       └── shell.json
│   │   │   ├── renderer
│   │   │   │   ├── index.tsx
│   │   │   │   ├── markdown-body.tsx
│   │   │   │   ├── markdown.tsx
│   │   │   │   └── stream-utils.tsx
│   │   │   └── plugin.json
│   │   ├── mermaid
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   └── plugin.json
│   │   │   │   ├── en
│   │   │   │   │   └── plugin.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   └── plugin.json
│   │   │   │   └── zh-TW
│   │   │   │       └── plugin.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── message-blocks
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── shell.json
│   │   │   │   │   └── timeline.json
│   │   │   │   ├── en
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── shell.json
│   │   │   │   │   └── timeline.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── shell.json
│   │   │   │   │   └── timeline.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── plugin.json
│   │   │   │       ├── shell.json
│   │   │   │       └── timeline.json
│   │   │   ├── renderer
│   │   │   │   ├── comments-only-bubble.tsx
│   │   │   │   ├── entry-divider.tsx
│   │   │   │   ├── index.tsx
│   │   │   │   ├── stream-text-reveal.tsx
│   │   │   │   ├── thinking-chain-block.tsx
│   │   │   │   ├── tool-cards.tsx
│   │   │   │   └── user-bubble.tsx
│   │   │   └── plugin.json
│   │   ├── puml
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   └── plugin.json
│   │   │   │   ├── en
│   │   │   │   │   └── plugin.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   └── plugin.json
│   │   │   │   └── zh-TW
│   │   │   │       └── plugin.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── retry
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   └── shell.json
│   │   │   │   ├── en
│   │   │   │   │   └── shell.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   └── shell.json
│   │   │   │   └── zh-TW
│   │   │   │       └── shell.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── review
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── shell.json
│   │   │   │   ├── en
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── shell.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── shell.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── settings.json
│   │   │   │       └── shell.json
│   │   │   ├── renderer
│   │   │   │   ├── basket-bar.tsx
│   │   │   │   ├── index.tsx
│   │   │   │   └── review-basket-store.ts
│   │   │   └── plugin.json
│   │   ├── session-bookmarks
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   └── bookmarks.json
│   │   │   │   ├── en
│   │   │   │   │   └── bookmarks.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   └── bookmarks.json
│   │   │   │   └── zh-TW
│   │   │   │       └── bookmarks.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── session-colors
│   │   │   ├── core
│   │   │   │   ├── pin.test.ts
│   │   │   │   └── pin.ts
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   └── pinColors.json
│   │   │   │   ├── en
│   │   │   │   │   └── pinColors.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   └── pinColors.json
│   │   │   │   └── zh-TW
│   │   │   │       └── pinColors.json
│   │   │   ├── renderer
│   │   │   │   ├── index.tsx
│   │   │   │   ├── pin-store.ts
│   │   │   │   └── pin-svg.tsx
│   │   │   ├── DESIGN.md
│   │   │   └── plugin.json
│   │   ├── session-tree
│   │   │   ├── core
│   │   │   │   ├── tree-model.test.ts
│   │   │   │   ├── tree-model.ts
│   │   │   │   └── tree-visual.ts
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── shell.json
│   │   │   │   │   └── system.json
│   │   │   │   ├── en
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── shell.json
│   │   │   │   │   └── system.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── shell.json
│   │   │   │   │   └── system.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── plugin.json
│   │   │   │       ├── shell.json
│   │   │   │       └── system.json
│   │   │   ├── renderer
│   │   │   │   ├── fullscreen-map.tsx
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── sessions-list
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── sessions.json
│   │   │   │   ├── en
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── sessions.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── sessions.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── plugin.json
│   │   │   │       └── sessions.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── sub-agent
│   │   │   ├── client
│   │   │   │   └── ports.ts
│   │   │   ├── core
│   │   │   │   └── orchestrator.ts
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── sub-agent.json
│   │   │   │   ├── en
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── sub-agent.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── sub-agent.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── settings.json
│   │   │   │       └── sub-agent.json
│   │   │   ├── renderer
│   │   │   │   ├── dialog-state.ts
│   │   │   │   ├── dialog.tsx
│   │   │   │   ├── index.tsx
│   │   │   │   ├── orchestrator-singleton.ts
│   │   │   │   ├── panel.tsx
│   │   │   │   ├── settings.tsx
│   │   │   │   └── spawn-card.tsx
│   │   │   ├── tools
│   │   │   │   ├── abort-subagent.ts
│   │   │   │   ├── list-subagents.ts
│   │   │   │   ├── send-to-subagent.ts
│   │   │   │   ├── spawn-subagent.ts
│   │   │   │   └── wait-subagent.ts
│   │   │   └── plugin.json
│   │   └── timeline
│   │       ├── core
│   │       │   ├── attach-images.ts
│   │       │   ├── retry-collapse.test.ts
│   │       │   ├── retry-collapse.ts
│   │       │   ├── tool-result-fold.test.ts
│   │       │   └── tool-result-fold.ts
│   │       ├── locales
│   │       │   ├── de
│   │       │   │   ├── plugin.json
│   │       │   │   ├── settings.json
│   │       │   │   ├── shell.json
│   │       │   │   └── timeline.json
│   │       │   ├── en
│   │       │   │   ├── plugin.json
│   │       │   │   ├── settings.json
│   │       │   │   ├── shell.json
│   │       │   │   └── timeline.json
│   │       │   ├── zh-CN
│   │       │   │   ├── plugin.json
│   │       │   │   ├── settings.json
│   │       │   │   ├── shell.json
│   │       │   │   └── timeline.json
│   │       │   └── zh-TW
│   │       │       ├── plugin.json
│   │       │       ├── settings.json
│   │       │       ├── shell.json
│   │       │       └── timeline.json
│   │       ├── renderer
│   │       │   ├── block-renderer.tsx
│   │       │   ├── blocks.test.ts
│   │       │   ├── blocks.ts
│   │       │   ├── composer.tsx
│   │       │   ├── image-block.tsx
│   │       │   ├── index.tsx
│   │       │   ├── message-actions.tsx
│   │       │   ├── queue-basket.tsx
│   │       │   └── timeline-scroll-bridge.tsx
│   │       └── plugin.json
│   ├── system
│   │   ├── debug-bar
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   └── debug.json
│   │   │   │   ├── en
│   │   │   │   │   └── debug.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   └── debug.json
│   │   │   │   └── zh-TW
│   │   │   │       └── debug.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── general-config
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── settings.json
│   │   │   │   ├── en
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── settings.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   └── settings.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── plugin.json
│   │   │   │       └── settings.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   ├── plugin.json
│   │   │   └── plugin.md
│   │   ├── goody-hao
│   │   │   ├── skills
│   │   │   │   ├── arch-to-code
│   │   │   │   │   ├── references
│   │   │   │   │   │   ├── blind-review-prompts.md
│   │   │   │   │   │   └── workflow-script.js
│   │   │   │   │   └── SKILL.md
│   │   │   │   └── write-design-doc
│   │   │   │       └── SKILL.md
│   │   │   ├── CLAUDE.md
│   │   │   └── plugin.json
│   │   ├── i18n
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   ├── common.json
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── shell.json
│   │   │   │   ├── en
│   │   │   │   │   ├── common.json
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── shell.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   ├── common.json
│   │   │   │   │   ├── plugin.json
│   │   │   │   │   ├── settings.json
│   │   │   │   │   └── shell.json
│   │   │   │   └── zh-TW
│   │   │   │       ├── common.json
│   │   │   │       ├── plugin.json
│   │   │   │       ├── settings.json
│   │   │   │       └── shell.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── key-hints
│   │   │   ├── core
│   │   │   │   ├── hints.test.ts
│   │   │   │   └── hints.ts
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   └── hints.json
│   │   │   │   ├── en
│   │   │   │   │   └── hints.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   └── hints.json
│   │   │   │   └── zh-TW
│   │   │   │       └── hints.json
│   │   │   ├── renderer
│   │   │   │   ├── index.tsx
│   │   │   │   ├── key-hints.css
│   │   │   │   └── settings.tsx
│   │   │   ├── DESIGN.md
│   │   │   └── plugin.json
│   │   ├── keybindings
│   │   │   ├── core
│   │   │   │   ├── bindings.test.ts
│   │   │   │   ├── bindings.ts
│   │   │   │   ├── combo.test.ts
│   │   │   │   └── combo.ts
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   └── settings.json
│   │   │   │   ├── en
│   │   │   │   │   └── settings.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   └── settings.json
│   │   │   │   └── zh-TW
│   │   │   │       └── settings.json
│   │   │   ├── renderer
│   │   │   │   ├── index.tsx
│   │   │   │   └── settings.tsx
│   │   │   ├── DESIGN.md
│   │   │   └── plugin.json
│   │   ├── notifier
│   │   │   ├── locales
│   │   │   │   ├── de
│   │   │   │   │   └── plugin.json
│   │   │   │   ├── en
│   │   │   │   │   └── plugin.json
│   │   │   │   ├── zh-CN
│   │   │   │   │   └── plugin.json
│   │   │   │   └── zh-TW
│   │   │   │       └── plugin.json
│   │   │   ├── renderer
│   │   │   │   └── index.tsx
│   │   │   └── plugin.json
│   │   ├── read-claude-md
│   │   │   ├── pi-extension
│   │   │   │   ├── extension
│   │   │   │   │   └── index.ts
│   │   │   │   └── package.json
│   │   │   └── plugin.json
│   │   └── remote-access
│   │       ├── locales
│   │       │   ├── de
│   │       │   │   ├── plugin.json
│   │       │   │   └── settings.json
│   │       │   ├── en
│   │       │   │   ├── plugin.json
│   │       │   │   └── settings.json
│   │       │   ├── zh-CN
│   │       │   │   ├── plugin.json
│   │       │   │   └── settings.json
│   │       │   └── zh-TW
│   │       │       ├── plugin.json
│   │       │       └── settings.json
│   │       ├── renderer
│   │       │   └── index.tsx
│   │       └── plugin.json
│   └── themes
│       ├── font-presets
│       │   ├── locales
│       │   │   ├── de
│       │   │   │   └── fonts.json
│       │   │   ├── en
│       │   │   │   └── fonts.json
│       │   │   ├── zh-CN
│       │   │   │   └── fonts.json
│       │   │   └── zh-TW
│       │   │       └── fonts.json
│       │   └── plugin.json
│       ├── theme
│       │   └── plugin.json
│       ├── theme-chatgpt
│       │   └── plugin.json
│       ├── theme-everforest
│       │   └── plugin.json
│       ├── theme-midnight
│       │   └── plugin.json
│       ├── theme-mocha
│       │   └── plugin.json
│       ├── theme-new-york
│       │   └── plugin.json
│       ├── theme-stone
│       │   └── plugin.json
│       └── theme-terminal
│           └── plugin.json
├── server
│   ├── application
│   │   ├── bundled
│   │   │   └── mirror.ts
│   │   ├── config
│   │   │   ├── config-file.ts
│   │   │   ├── config-store.ts
│   │   │   ├── json-merge.ts
│   │   │   └── json-prefs.ts
│   │   ├── extensions
│   │   │   └── kernel-extension-manager.ts
│   │   ├── i18n
│   │   │   ├── merge.ts
│   │   │   └── translator.ts
│   │   ├── installer
│   │   │   └── index.ts
│   │   ├── lifecycle
│   │   │   └── index.ts
│   │   ├── loader
│   │   │   ├── discover.ts
│   │   │   ├── registry.test.ts
│   │   │   └── registry.ts
│   │   ├── models
│   │   │   ├── model-catalog.test.ts
│   │   │   └── model-catalog.ts
│   │   ├── restart
│   │   │   └── restart-coordinator.ts
│   │   ├── sessions
│   │   │   ├── neutral-session-store.test.ts
│   │   │   ├── neutral-session-store.ts
│   │   │   ├── session-bus.ts
│   │   │   ├── session-role.test.ts
│   │   │   ├── session-store.dsh.integration.test.ts
│   │   │   ├── session-store.test.ts
│   │   │   └── session-store.ts
│   │   ├── skills
│   │   │   ├── bundled-skills.ts
│   │   │   └── skill-aggregator.ts
│   │   └── theme
│   │       ├── contrast.ts
│   │       └── merge.ts
│   ├── bootstrap
│   │   ├── host
│   │   │   ├── electron-host.ts
│   │   │   └── node-host.ts
│   │   ├── kernel
│   │   │   ├── kernel-factories.ts
│   │   │   ├── kernel-logos.ts
│   │   │   └── kernel-managers.ts
│   │   ├── assemble.ts
│   │   ├── electron.ts
│   │   └── server.ts
│   ├── client
│   │   ├── fs
│   │   │   ├── fs-ops.ts
│   │   │   ├── fs-sync.ts
│   │   │   ├── fs-tree.test.ts
│   │   │   └── fs-tree.ts
│   │   ├── git
│   │   │   ├── git-status.ts
│   │   │   └── git-write.ts
│   │   ├── npm
│   │   │   └── kernel-runtime.ts
│   │   ├── remote
│   │   │   ├── cloudflared-download.ts
│   │   │   ├── cloudflared.ts
│   │   │   ├── lan-ip.ts
│   │   │   └── qr.ts
│   │   ├── kernel-extension.ts
│   │   ├── paths.ts
│   │   └── skill-frontmatter.ts
│   ├── controllers
│   │   ├── app-info.ts
│   │   ├── appearance.ts
│   │   ├── bus.ts
│   │   ├── config.ts
│   │   ├── extensions.ts
│   │   ├── fs-git.ts
│   │   ├── kernel.ts
│   │   ├── notification.ts
│   │   ├── plugins.ts
│   │   ├── remote.ts
│   │   ├── sessions.ts
│   │   ├── skills.ts
│   │   ├── slots-dialog.ts
│   │   └── window.ts
│   ├── kernel
│   │   ├── dsh
│   │   │   ├── dsh-extension
│   │   │   │   ├── extension.json
│   │   │   │   └── index.mjs
│   │   │   ├── dsh-backend.integration.test.ts
│   │   │   ├── dsh-backend.test.ts
│   │   │   ├── dsh-backend.ts
│   │   │   ├── dsh-catalog.ts
│   │   │   ├── dsh-config-source.test.ts
│   │   │   ├── dsh-config-source.ts
│   │   │   ├── dsh-event-translator.test.ts
│   │   │   ├── dsh-event-translator.ts
│   │   │   ├── dsh-extension-installer.test.ts
│   │   │   ├── dsh-extension-installer.ts
│   │   │   ├── dsh-extension-manager.ts
│   │   │   ├── dsh-extension-manifest.ts
│   │   │   ├── dsh-kernel-api.test.ts
│   │   │   ├── dsh-kernel-api.ts
│   │   │   ├── dsh-kernel-config.ts
│   │   │   ├── dsh-kernel.ts
│   │   │   ├── dsh-logo.ts
│   │   │   ├── dsh-methods.ts
│   │   │   ├── dsh-question-bridge.ts
│   │   │   ├── dsh-skill-provider.ts
│   │   │   ├── dsh-warmup.ts
│   │   │   ├── json-rpc.test.ts
│   │   │   ├── json-rpc.ts
│   │   │   └── subprocess-lifecycle.ts
│   │   ├── pi
│   │   │   ├── commands.ts
│   │   │   ├── context-binding.test.ts
│   │   │   ├── context-binding.ts
│   │   │   ├── correlator.ts
│   │   │   ├── event-translator.ts
│   │   │   ├── known-tools.ts
│   │   │   ├── models-config.ts
│   │   │   ├── models-store.ts
│   │   │   ├── my-harness-fit-pi-extension-installer.ts
│   │   │   ├── patch-rpc-mode.ts
│   │   │   ├── pi-backend-extensions.ts
│   │   │   ├── pi-backend.test.ts
│   │   │   ├── pi-backend.ts
│   │   │   ├── pi-bundled-skills.ts
│   │   │   ├── pi-catalog.test.ts
│   │   │   ├── pi-catalog.ts
│   │   │   ├── pi-cli.ts
│   │   │   ├── pi-extension-installer.ts
│   │   │   ├── pi-extension-manager.ts
│   │   │   ├── pi-kernel-api.ts
│   │   │   ├── pi-kernel-config.ts
│   │   │   ├── pi-kernel.ts
│   │   │   ├── pi-logo.ts
│   │   │   ├── pi-model-source.ts
│   │   │   ├── pi-oneshot.ts
│   │   │   ├── pi-settings-store.ts
│   │   │   ├── pi-skill-provider.ts
│   │   │   ├── pi-warmup.ts
│   │   │   ├── resync.ts
│   │   │   ├── rpc-adapter.ts
│   │   │   ├── rpc-types.ts
│   │   │   ├── subprocess-handle.ts
│   │   │   ├── subprocess-lifecycle.ts
│   │   │   └── versions.ts
│   │   ├── abstract-backend.ts
│   │   ├── kernel-manager.install.test.ts
│   │   ├── kernel-manager.test.ts
│   │   ├── kernel-manager.ts
│   │   └── kernel-runtime.ts
│   ├── remote
│   │   ├── auth.test.ts
│   │   ├── auth.ts
│   │   ├── password.test.ts
│   │   ├── password.ts
│   │   ├── rate-limiter.ts
│   │   ├── remote-config.ts
│   │   ├── token.test.ts
│   │   └── token.ts
│   ├── routing
│   │   ├── gateway.test.ts
│   │   └── gateway.ts
│   ├── transport
│   │   ├── http
│   │   │   └── http-server.ts
│   │   └── ws
│   │       ├── ws-server.test.ts
│   │       └── ws-server.ts
│   ├── broadcast.ts
│   └── main-context.ts
└── web
    ├── components
    │   ├── layout-engine.tsx
    │   ├── right-panel.tsx
    │   ├── settings-page.tsx
    │   ├── sidebar.tsx
    │   └── titlebar.tsx
    ├── kernel
    │   └── build-kernel.ts
    ├── stores
    │   ├── general-config.ts
    │   ├── kernel-logos.ts
    │   ├── layout-store.test.ts
    │   ├── layout-store.ts
    │   ├── session-store.image.test.ts
    │   ├── session-store.test.ts
    │   ├── session-store.ts
    │   └── ui-store.ts
    ├── transport
    │   ├── ws-transport.test.ts
    │   └── ws-transport.ts
    ├── ui
    │   ├── button.tsx
    │   └── chat-row.tsx
    ├── event-bus.test.ts
    ├── i18n-init.ts
    ├── index.css
    ├── index.html
    ├── index.tsx
    ├── plugins-host.ts
    ├── theme-context.tsx
    └── ui-store.ts
packages
├── my-harness-fit-pi-extension
│   ├── skills
│   │   ├── chatroom-collab.md
│   │   ├── delegate-task.md
│   │   ├── orchestrate.md
│   │   ├── parallel-fanout.md
│   │   └── supervise-worker.md
│   ├── tools
│   │   ├── abort-subagent.ts
│   │   ├── bus-status.ts
│   │   ├── channel-member.ts
│   │   ├── list-subagents.ts
│   │   ├── send-to-subagent.ts
│   │   ├── session-abort.ts
│   │   ├── session-create.ts
│   │   ├── spawn-subagent.ts
│   │   ├── tap-start.ts
│   │   ├── tap-stop.ts
│   │   └── wait-subagent.ts
│   ├── bus.ts
│   ├── context-probe.ts
│   ├── index.ts
│   ├── runtime.ts
│   ├── scanner.ts
│   ├── skills.ts
│   ├── subagent.ts
│   └── toolgate.ts
├── react
│   ├── src
│   │   ├── manager
│   │   │   ├── kernel-config-form.tsx
│   │   │   ├── kernel-version-page.tsx
│   │   │   └── model-config-page.tsx
│   │   ├── panel
│   │   │   ├── index.ts
│   │   │   ├── panel-card.tsx
│   │   │   ├── panel-icon-button.tsx
│   │   │   ├── panel-row.tsx
│   │   │   ├── panel-search-input.tsx
│   │   │   ├── panel-section-title.tsx
│   │   │   ├── panel-stat-row.tsx
│   │   │   ├── panel-tabs.tsx
│   │   │   └── panel-toolbar.tsx
│   │   ├── widgets
│   │   │   ├── button.tsx
│   │   │   ├── context-menu.tsx
│   │   │   ├── control-geometry.ts
│   │   │   ├── empty-state.tsx
│   │   │   ├── file-tree.css
│   │   │   ├── file-tree.tsx
│   │   │   ├── kernel-logo.tsx
│   │   │   ├── pagination.tsx
│   │   │   ├── plugin-icon.tsx
│   │   │   ├── section.tsx
│   │   │   ├── select.tsx
│   │   │   ├── sortable-list.tsx
│   │   │   └── toast.tsx
│   │   ├── aux-block-parsers.ts
│   │   ├── block-renderers.ts
│   │   ├── code-block-renderers.ts
│   │   ├── composer-actions.ts
│   │   ├── composer-attachments.ts
│   │   ├── composer-policies.ts
│   │   ├── composer-stats.ts
│   │   ├── error-boundary.tsx
│   │   ├── event-bus.ts
│   │   ├── file-actions.ts
│   │   ├── file-icons.ts
│   │   ├── index.ts
│   │   ├── inline-confirm.tsx
│   │   ├── kernel-extensions-page.tsx
│   │   ├── list-item.tsx
│   │   ├── message-actions.ts
│   │   ├── plugin-context.ts
│   │   ├── plugin-id-context.ts
│   │   ├── plugin-modules.ts
│   │   ├── plugin-overlays.tsx
│   │   ├── session-groupings.ts
│   │   ├── settings-groups.ts
│   │   └── settings-section.tsx
│   └── package.json
└── shared
    ├── src
    │   ├── channel
    │   │   ├── channel-contract.ts
    │   │   └── channel-meta.ts
    │   ├── domain
    │   │   ├── events
    │   │   │   ├── kernel-event.ts
    │   │   │   ├── session-bus.ts
    │   │   │   ├── session-state.test.ts
    │   │   │   └── session-state.ts
    │   │   ├── slots
    │   │   │   └── theme-tokens.ts
    │   │   ├── aux-blocks.test.ts
    │   │   ├── aux-blocks.ts
    │   │   ├── backend.test.ts
    │   │   ├── backend.ts
    │   │   ├── context.ts
    │   │   ├── contributions.ts
    │   │   ├── custom-order.ts
    │   │   ├── extensions.ts
    │   │   ├── file-icons.test.ts
    │   │   ├── file-icons.ts
    │   │   ├── host.ts
    │   │   ├── kernel-manager.ts
    │   │   ├── kernel-warmup.ts
    │   │   ├── kernel.ts
    │   │   ├── layout.ts
    │   │   ├── path-utils.test.ts
    │   │   ├── path-utils.ts
    │   │   ├── remote.ts
    │   │   ├── restart.ts
    │   │   ├── session-neutral.test.ts
    │   │   ├── session-neutral.ts
    │   │   ├── sessions.ts
    │   │   ├── skills.ts
    │   │   ├── working-phase.test.ts
    │   │   └── working-phase.ts
    │   ├── wire
    │   │   └── wire.ts
    │   ├── index.ts
    │   ├── paths.ts
    │   └── style-presets.ts
    └── package.json

357 directories, 797 files
```
