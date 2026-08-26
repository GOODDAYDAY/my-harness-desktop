# 目录结构说明（带解释）

> 前后端分离后的完整目录结构，每行带说明。i18n 语言包(locales/)已折叠为一行(37 处),源码文件全量列出。

## src/

```text

└── src/  # 子目录
    ├── plugins/  # 内容层壳插件
    │   ├── insight/  # 洞察类
    │   │   ├── blind-review/  # 盲审
    │   │   │   ├── client/  # 后端适配
    │   │   │   │   └── squad-runner.ts  # 模块
    │   │   │   ├── core/  # 插件私有编排
    │   │   │   │   ├── assemble.ts  # 模块
    │   │   │   │   ├── config.ts  # 模块
    │   │   │   │   └── run-state.ts  # 模块
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── llm-recorder/  # LLM 录制
    │   │   │   ├── core/  # 插件私有编排
    │   │   │   │   ├── log-model.test.ts  # 单测
    │   │   │   │   ├── log-model.ts  # 模块
    │   │   │   │   ├── payload-model.test.ts  # 单测
    │   │   │   │   └── payload-model.ts  # 模块
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── pi-extension/  # pi 内核扩展
    │   │   │   │   └── index.ts  # 导出入口
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── index.tsx  # 插件渲染入口
    │   │   │   │   ├── payload-views.tsx  # React 组件
    │   │   │   │   └── record-modal.tsx  # React 组件
    │   │   │   ├── extension-flow.test.ts  # 单测
    │   │   │   └── plugin.json  # 插件清单
    │   │   └── token-stats/  # token 统计
    │   │       ├── locales/  # i18n 语言包(已折叠)
    │   │       ├── renderer/  # 前端（React UI）
    │   │       │   ├── context-usage-bar.tsx  # React 组件
    │   │       │   ├── hover-tip.tsx  # React 组件
    │   │       │   ├── index.tsx  # 插件渲染入口
    │   │       │   └── stats-titlebar.tsx  # React 组件
    │   │       └── plugin.json  # 插件清单
    │   ├── manager/  # 管理类
    │   │   ├── dsh-manager/  # dsh 管理页
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── extensions.tsx  # React 组件
    │   │   │   │   ├── index.tsx  # 插件渲染入口
    │   │   │   │   ├── kernel.tsx  # React 组件
    │   │   │   │   └── models.tsx  # React 组件
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── pi-manager/  # pi 管理页
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── extensions.tsx  # React 组件
    │   │   │   │   ├── index.tsx  # 插件渲染入口
    │   │   │   │   └── models.tsx  # React 组件
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── plugin-manager/  # 插件管理
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── skill-manager/  # 技能管理
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── index.tsx  # 插件渲染入口
    │   │   │   │   └── skill-aux.tsx  # React 组件
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── theme-manager/  # 主题管理
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── tabs/  # 子目录
    │   │   │   │   │   ├── font-tab.tsx  # React 组件
    │   │   │   │   │   ├── sidebar-tab.tsx  # React 组件
    │   │   │   │   │   ├── sidepanel-tab.tsx  # React 组件
    │   │   │   │   │   ├── theme-tab.tsx  # React 组件
    │   │   │   │   │   └── timeline-tab.tsx  # React 组件
    │   │   │   │   ├── index.tsx  # 插件渲染入口
    │   │   │   │   ├── sidebar-style-preview.tsx  # React 组件
    │   │   │   │   ├── sidepanel-style-preview.tsx  # React 组件
    │   │   │   │   └── theme-preview.tsx  # React 组件
    │   │   │   └── plugin.json  # 插件清单
    │   │   └── tool-manager/  # 工具管理
    │   │       ├── core/  # 插件私有编排
    │   │       │   ├── types.test.ts  # 单测
    │   │       │   └── types.ts  # 模块
    │   │       ├── locales/  # i18n 语言包(已折叠)
    │   │       ├── renderer/  # 前端（React UI）
    │   │       │   └── index.tsx  # 插件渲染入口
    │   │       └── plugin.json  # 插件清单
    │   ├── project/  # 项目类
    │   │   ├── file-preview/  # 文件预览
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── file-tree/  # 文件树
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── git-review/  # git review 面板
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── projects/  # 项目列表
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   └── stickers/  # 贴纸包
    │   │       ├── client/  # 后端适配
    │   │       │   ├── stickers-store.test.ts  # 单测
    │   │       │   └── stickers-store.ts  # 模块
    │   │       ├── locales/  # i18n 语言包(已折叠)
    │   │       ├── renderer/  # 前端（React UI）
    │   │       │   ├── index.tsx  # 插件渲染入口
    │   │       │   ├── sticker-card.tsx  # React 组件
    │   │       │   ├── sticker-composer-button.tsx  # React 组件
    │   │       │   └── sticker.tsx  # React 组件
    │   │       └── plugin.json  # 插件清单
    │   ├── sessions/  # 会话类
    │   │   ├── ask/  # ask 会话
    │   │   │   ├── pi-extension/  # pi 内核扩展
    │   │   │   │   └── index.ts  # 导出入口
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── ask-host.tsx  # React 组件
    │   │   │   │   ├── ask-question-card.tsx  # React 组件
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── continue/  # 续跑
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── goal/  # 目标
    │   │   │   ├── pi-extension/  # pi 内核扩展
    │   │   │   │   ├── goal-fold.test.ts  # 单测
    │   │   │   │   ├── goal-fold.ts  # 模块
    │   │   │   │   ├── goal-store.ts  # 模块
    │   │   │   │   └── index.ts  # 导出入口
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── goal-card.tsx  # React 组件
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── graphviz/  # graphviz 渲染
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── im-graph/  # 图渲染
    │   │   │   ├── client/  # 后端适配
    │   │   │   │   └── bus-observer.ts  # 模块
    │   │   │   ├── core/  # 插件私有编排
    │   │   │   │   ├── flow-events.test.ts  # 单测
    │   │   │   │   ├── flow-events.ts  # 模块
    │   │   │   │   ├── graph-model.test.ts  # 单测
    │   │   │   │   └── graph-model.ts  # 模块
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── EventFlow.tsx  # React 组件
    │   │   │   │   ├── GraphCanvas.tsx  # React 组件
    │   │   │   │   ├── im-graph.css  # 样式
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── markdown/  # markdown 渲染
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── index.tsx  # 插件渲染入口
    │   │   │   │   ├── markdown-body.tsx  # React 组件
    │   │   │   │   ├── markdown.tsx  # React 组件
    │   │   │   │   └── stream-utils.tsx  # React 组件
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── mermaid/  # mermaid 渲染
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── message-blocks/  # 消息块
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── comments-only-bubble.tsx  # React 组件
    │   │   │   │   ├── entry-divider.tsx  # React 组件
    │   │   │   │   ├── index.tsx  # 插件渲染入口
    │   │   │   │   ├── stream-text-reveal.tsx  # React 组件
    │   │   │   │   ├── thinking-chain-block.tsx  # React 组件
    │   │   │   │   ├── tool-cards.tsx  # React 组件
    │   │   │   │   └── user-bubble.tsx  # React 组件
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── puml/  # plantuml 渲染
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── retry/  # 重试
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── review/  # 审查
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── basket-bar.tsx  # React 组件
    │   │   │   │   ├── index.tsx  # 插件渲染入口
    │   │   │   │   └── review-basket-store.ts  # 模块
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── session-bookmarks/  # 会话书签
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── session-colors/  # 会话颜色
    │   │   │   ├── core/  # 插件私有编排
    │   │   │   │   ├── pin.test.ts  # 单测
    │   │   │   │   └── pin.ts  # 模块
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── index.tsx  # 插件渲染入口
    │   │   │   │   ├── pin-store.ts  # 模块
    │   │   │   │   └── pin-svg.tsx  # React 组件
    │   │   │   ├── DESIGN.md  # 文档
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── session-tree/  # 会话树
    │   │   │   ├── core/  # 插件私有编排
    │   │   │   │   ├── tree-model.test.ts  # 单测
    │   │   │   │   ├── tree-model.ts  # 模块
    │   │   │   │   └── tree-visual.ts  # 模块
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── fullscreen-map.tsx  # React 组件
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── sessions-list/  # 会话列表
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── sub-agent/  # 子代理
    │   │   │   ├── client/  # 后端适配
    │   │   │   │   └── ports.ts  # 模块
    │   │   │   ├── core/  # 插件私有编排
    │   │   │   │   └── orchestrator.ts  # 模块
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── dialog-state.ts  # 模块
    │   │   │   │   ├── dialog.tsx  # React 组件
    │   │   │   │   ├── index.tsx  # 插件渲染入口
    │   │   │   │   ├── orchestrator-singleton.ts  # 模块
    │   │   │   │   ├── panel.tsx  # React 组件
    │   │   │   │   ├── settings.tsx  # React 组件
    │   │   │   │   └── spawn-card.tsx  # React 组件
    │   │   │   ├── tools/  # 子目录
    │   │   │   │   ├── abort-subagent.ts  # 模块
    │   │   │   │   ├── list-subagents.ts  # 模块
    │   │   │   │   ├── send-to-subagent.ts  # 模块
    │   │   │   │   ├── spawn-subagent.ts  # 模块
    │   │   │   │   └── wait-subagent.ts  # 模块
    │   │   │   └── plugin.json  # 插件清单
    │   │   └── timeline/  # 时间线（消息流渲染）
    │   │       ├── core/  # 插件私有编排
    │   │       │   ├── attach-images.ts  # 模块
    │   │       │   ├── retry-collapse.test.ts  # 单测
    │   │       │   ├── retry-collapse.ts  # 模块
    │   │       │   ├── tool-result-fold.test.ts  # 单测
    │   │       │   └── tool-result-fold.ts  # 模块
    │   │       ├── locales/  # i18n 语言包(已折叠)
    │   │       ├── renderer/  # 前端（React UI）
    │   │       │   ├── block-renderer.tsx  # React 组件
    │   │       │   ├── blocks.test.ts  # 单测
    │   │       │   ├── blocks.ts  # 模块
    │   │       │   ├── composer.tsx  # React 组件
    │   │       │   ├── image-block.tsx  # React 组件
    │   │       │   ├── index.tsx  # 插件渲染入口
    │   │       │   ├── message-actions.tsx  # React 组件
    │   │       │   ├── queue-basket.tsx  # React 组件
    │   │       │   └── timeline-scroll-bridge.tsx  # React 组件
    │   │       └── plugin.json  # 插件清单
    │   ├── system/  # 系统类
    │   │   ├── debug-bar/  # debug 栏
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── general-config/  # 通用配置页
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   ├── plugin.json  # 插件清单
    │   │   │   └── plugin.md  # 文档
    │   │   ├── goody-hao/  # goody-hao 集成
    │   │   │   ├── skills/  # 子目录
    │   │   │   │   ├── arch-to-code/  # 子目录
    │   │   │   │   │   ├── references/  # 子目录
    │   │   │   │   │   │   ├── blind-review-prompts.md  # 文档
    │   │   │   │   │   │   └── workflow-script.js  # 文件
    │   │   │   │   │   └── SKILL.md  # 文档
    │   │   │   │   └── write-design-doc/  # 子目录
    │   │   │   │       └── SKILL.md  # 文档
    │   │   │   ├── CLAUDE.md  # 文档
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── i18n/  # 语言包
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── key-hints/  # 快捷键提示
    │   │   │   ├── core/  # 插件私有编排
    │   │   │   │   ├── hints.test.ts  # 单测
    │   │   │   │   └── hints.ts  # 模块
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── index.tsx  # 插件渲染入口
    │   │   │   │   ├── key-hints.css  # 样式
    │   │   │   │   └── settings.tsx  # React 组件
    │   │   │   ├── DESIGN.md  # 文档
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── keybindings/  # 键绑定
    │   │   │   ├── core/  # 插件私有编排
    │   │   │   │   ├── bindings.test.ts  # 单测
    │   │   │   │   ├── bindings.ts  # 模块
    │   │   │   │   ├── combo.test.ts  # 单测
    │   │   │   │   └── combo.ts  # 模块
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   ├── index.tsx  # 插件渲染入口
    │   │   │   │   └── settings.tsx  # React 组件
    │   │   │   ├── DESIGN.md  # 文档
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── notifier/  # 通知
    │   │   │   ├── locales/  # i18n 语言包(已折叠)
    │   │   │   ├── renderer/  # 前端（React UI）
    │   │   │   │   └── index.tsx  # 插件渲染入口
    │   │   │   └── plugin.json  # 插件清单
    │   │   ├── read-claude-md/  # 读 claude.md
    │   │   │   ├── pi-extension/  # pi 内核扩展
    │   │   │   │   ├── extension/  # 子目录
    │   │   │   │   │   └── index.ts  # 导出入口
    │   │   │   │   └── package.json  # i18n 资源
    │   │   │   └── plugin.json  # 插件清单
    │   │   └── remote-access/  # 远程访问设置页
    │   │       ├── locales/  # i18n 语言包(已折叠)
    │   │       ├── renderer/  # 前端（React UI）
    │   │       │   └── index.tsx  # 插件渲染入口
    │   │       └── plugin.json  # 插件清单
    │   └── themes/  # 主题类
    │       ├── font-presets/  # 字体预设
    │       │   ├── locales/  # i18n 语言包(已折叠)
    │       │   └── plugin.json  # 插件清单
    │       ├── theme/  # 主题机制
    │       │   └── plugin.json  # 插件清单
    │       ├── theme-chatgpt/  # ChatGPT 配色
    │       │   └── plugin.json  # 插件清单
    │       ├── theme-everforest/  # Everforest 配色
    │       │   └── plugin.json  # 插件清单
    │       ├── theme-midnight/  # Midnight 配色
    │       │   └── plugin.json  # 插件清单
    │       ├── theme-mocha/  # Mocha 配色
    │       │   └── plugin.json  # 插件清单
    │       ├── theme-new-york/  # New York 配色
    │       │   └── plugin.json  # 插件清单
    │       ├── theme-stone/  # Stone 配色
    │       │   └── plugin.json  # 插件清单
    │       └── theme-terminal/  # Terminal 配色
    │           └── plugin.json  # 插件清单
    ├── server/  # 后端（node 侧）
    │   ├── application/  # 后端用例编排
    │   │   ├── bundled/  # 内置资源镜像
    │   │   │   └── mirror.ts  # 资源镜像
    │   │   ├── config/  # 配置读写
    │   │   │   ├── config-file.ts  # JSON 原语
    │   │   │   ├── config-store.ts  # 插件配置（分层）
    │   │   │   ├── json-merge.ts  # 深合并
    │   │   │   └── json-prefs.ts  # JSON 键值偏好
    │   │   ├── extensions/  # 内核扩展管理
    │   │   │   └── kernel-extension-manager.ts  # 内核扩展管理
    │   │   ├── i18n/  # i18n 资源合并 + 翻译器
    │   │   │   ├── merge.ts  # i18n 合并
    │   │   │   └── translator.ts  # 翻译器 + 语言探测
    │   │   ├── installer/  # 安装器
    │   │   │   └── index.ts  # 安装器
    │   │   ├── lifecycle/  # 插件生命周期
    │   │   │   └── index.ts  # 插件生命周期
    │   │   ├── loader/  # 插件发现 + 注册表
    │   │   │   ├── discover.ts  # 插件发现
    │   │   │   ├── registry.test.ts  # 单测
    │   │   │   └── registry.ts  # 插件注册表
    │   │   ├── models/  # 多内核模型合流
    │   │   │   ├── model-catalog.test.ts  # 单测
    │   │   │   └── model-catalog.ts  # ModelCatalog 合流
    │   │   ├── restart/  # 重启协调
    │   │   │   └── restart-coordinator.ts  # 重启协调
    │   │   ├── sessions/  # 会话编排（核心）
    │   │   │   ├── neutral-session-store.test.ts  # 单测
    │   │   │   ├── neutral-session-store.ts  # 中性会话存储
    │   │   │   ├── session-bus.ts  # 会话总线
    │   │   │   ├── session-role.test.ts  # 单测
    │   │   │   ├── session-store.dsh.integration.test.ts  # 单测
    │   │   │   ├── session-store.test.ts  # 单测
    │   │   │   └── session-store.ts  # 会话编排核心
    │   │   ├── skills/  # 多内核技能聚合
    │   │   │   ├── bundled-skills.ts  # 内置技能镜像
    │   │   │   └── skill-aggregator.ts  # 技能聚合
    │   │   └── theme/  # 主题合并 + 对比度审计
    │   │       ├── contrast.ts  # 对比度审计
    │   │       └── merge.ts  # 主题合并
    │   ├── bootstrap/  # 组装根
    │   │   ├── host/  # 宿主能力实现
    │   │   │   ├── electron-host.ts  # Host 的 Electron 实现
    │   │   │   └── node-host.ts  # Host 的 Node 降级实现
    │   │   ├── kernel/  # 内核注册表
    │   │   │   ├── kernel-factories.ts  # 模块
    │   │   │   ├── kernel-logos.ts  # 模块
    │   │   │   └── kernel-managers.ts  # 模块
    │   │   ├── assemble.ts  # 共享组装（零 electron）
    │   │   ├── electron.ts  # Electron 入口
    │   │   └── server.ts  # Node 入口
    │   ├── client/  # 外部适配器
    │   │   ├── fs/  # 文件系统读写
    │   │   │   ├── fs-ops.ts  # 文件操作
    │   │   │   ├── fs-sync.ts  # 文件同步
    │   │   │   ├── fs-tree.test.ts  # 单测
    │   │   │   └── fs-tree.ts  # 目录树
    │   │   ├── git/  # Git 读写
    │   │   │   ├── git-status.ts  # Git 只读状态
    │   │   │   └── git-write.ts  # Git 收敛写面
    │   │   ├── npm/  # npm install + registry
    │   │   │   └── kernel-runtime.ts  # npm install + registry
    │   │   ├── remote/  # 局域网 IP + cloudflared + 二维码
    │   │   │   ├── cloudflared-download.ts  # cloudflared 下载
    │   │   │   ├── cloudflared.ts  # cloudflared 隧道
    │   │   │   ├── lan-ip.ts  # 局域网 IPv4 探测
    │   │   │   └── qr.ts  # 二维码生成
    │   │   ├── kernel-extension.ts  # 内核扩展统一入口
    │   │   ├── paths.ts  # 数据根单源
    │   │   └── skill-frontmatter.ts  # skill frontmatter 解析
    │   ├── controllers/  # controller 层
    │   │   ├── app-info.ts  # app:info/restart（conn.host.app）
    │   │   ├── appearance.ts  # 外观（i18n/主题/settings）
    │   │   ├── bus.ts  # 会话总线
    │   │   ├── config.ts  # 插件配置读写
    │   │   ├── extensions.ts  # 内核扩展
    │   │   ├── fs-git.ts  # 文件 + git 读写
    │   │   ├── kernel.ts  # 内核版本管理
    │   │   ├── notification.ts  # 系统通知（conn.host.notify）
    │   │   ├── plugins.ts  # 壳插件管理
    │   │   ├── remote.ts  # remote:* 控制面
    │   │   ├── sessions.ts  # 会话（48 channel）
    │   │   ├── skills.ts  # 技能
    │   │   ├── slots-dialog.ts  # 槽位 + 对话框
    │   │   └── window.ts  # 窗口控制（conn.host.window）
    │   ├── kernel/  # 内核域（独立 + 内聚）
    │   │   ├── dsh/  # dsh 内核全部
    │   │   │   ├── dsh-extension/  # 子目录
    │   │   │   │   ├── extension.json  # 扩展清单
    │   │   │   │   └── index.mjs  # dsh 扩展入口
    │   │   │   ├── dsh-backend.integration.test.ts  # 单测
    │   │   │   ├── dsh-backend.test.ts  # 单测
    │   │   │   ├── dsh-backend.ts  # DshBackend（JSON-RPC）
    │   │   │   ├── dsh-catalog.ts  # DshSessionCatalog
    │   │   │   ├── dsh-config-source.test.ts  # 单测
    │   │   │   ├── dsh-config-source.ts  # cordis.yml + settings.yaml
    │   │   │   ├── dsh-event-translator.test.ts  # 单测
    │   │   │   ├── dsh-event-translator.ts  # dsh 事件→中性事件
    │   │   │   ├── dsh-extension-installer.test.ts  # 单测
    │   │   │   ├── dsh-extension-installer.ts  # 扩展安装
    │   │   │   ├── dsh-extension-manager.ts  # 扩展管理
    │   │   │   ├── dsh-extension-manifest.ts  # 扩展清单
    │   │   │   ├── dsh-kernel-api.test.ts  # 单测
    │   │   │   ├── dsh-kernel-api.ts  # dsh 内核 API
    │   │   │   ├── dsh-kernel-config.ts  # dsh 内核配置
    │   │   │   ├── dsh-kernel.ts  # DshKernelManager
    │   │   │   ├── dsh-logo.ts  # dsh logo
    │   │   │   ├── dsh-methods.ts  # dsh 方法枚举
    │   │   │   ├── dsh-question-bridge.ts  # 提问桥接
    │   │   │   ├── dsh-skill-provider.ts  # 技能提供
    │   │   │   ├── dsh-warmup.ts  # warmup
    │   │   │   ├── json-rpc.test.ts  # 单测
    │   │   │   ├── json-rpc.ts  # JSON-RPC 行传输
    │   │   │   └── subprocess-lifecycle.ts  # 子进程生命周期
    │   │   ├── pi/  # pi 内核全部
    │   │   │   ├── commands.ts  # pi 命令构造纯函数
    │   │   │   ├── context-binding.test.ts  # 单测
    │   │   │   ├── context-binding.ts  # RPC→domain 映射
    │   │   │   ├── correlator.ts  # 事件关联
    │   │   │   ├── event-translator.ts  # pi 事件→中性事件
    │   │   │   ├── known-tools.ts  # 已知工具
    │   │   │   ├── models-config.ts  # 模型配置
    │   │   │   ├── models-store.ts  # 模型存储
    │   │   │   ├── my-harness-fit-pi-extension-installer.ts  # 五能力安装
    │   │   │   ├── patch-rpc-mode.ts  # rpc 模式补丁
    │   │   │   ├── pi-backend-extensions.ts  # pi 扩展面
    │   │   │   ├── pi-backend.test.ts  # 单测
    │   │   │   ├── pi-backend.ts  # PiBackend（JSONL 后端）
    │   │   │   ├── pi-bundled-skills.ts  # 内置技能
    │   │   │   ├── pi-catalog.test.ts  # 单测
    │   │   │   ├── pi-catalog.ts  # PiSessionCatalog
    │   │   │   ├── pi-cli.ts  # pi cli 路径
    │   │   │   ├── pi-extension-installer.ts  # 扩展安装
    │   │   │   ├── pi-extension-manager.ts  # 扩展管理
    │   │   │   ├── pi-kernel-api.ts  # pi 内核 API
    │   │   │   ├── pi-kernel-config.ts  # pi 内核配置
    │   │   │   ├── pi-kernel.ts  # PiKernelManager
    │   │   │   ├── pi-logo.ts  # pi logo
    │   │   │   ├── pi-model-source.ts  # 模型源
    │   │   │   ├── pi-oneshot.ts  # 一次性调用
    │   │   │   ├── pi-settings-store.ts  # pi 设置存储
    │   │   │   ├── pi-skill-provider.ts  # 技能提供
    │   │   │   ├── pi-warmup.ts  # warmup
    │   │   │   ├── resync.ts  # 重同步
    │   │   │   ├── rpc-adapter.ts  # JSONL 读写 + id 配对
    │   │   │   ├── rpc-types.ts  # pi 消息类型
    │   │   │   ├── subprocess-handle.ts  # 子进程句柄
    │   │   │   ├── subprocess-lifecycle.ts  # 子进程生命周期
    │   │   │   └── versions.ts  # 协议版本
    │   │   ├── abstract-backend.ts  # AbstractBackend 基类
    │   │   ├── kernel-manager.install.test.ts  # 单测
    │   │   ├── kernel-manager.test.ts  # 单测
    │   │   ├── kernel-manager.ts  # KernelManager 基类
    │   │   └── kernel-runtime.ts  # KernelRuntime 接口
    │   ├── remote/  # web 鉴权
    │   │   ├── auth.test.ts  # 单测
    │   │   ├── auth.ts  # RemoteAuth（verifyToken/密码/token 签发）
    │   │   ├── password.test.ts  # 单测
    │   │   ├── password.ts  # scrypt 密码哈希
    │   │   ├── rate-limiter.ts  # 限速器（5 错锁 60s）
    │   │   ├── remote-config.ts  # remote.json 读写
    │   │   ├── token.test.ts  # 单测
    │   │   └── token.ts  # HMAC token
    │   ├── routing/  # channel 路由（gateway）
    │   │   ├── gateway.test.ts  # 单测
    │   │   └── gateway.ts  # 网关（register/dispatch/broadcast/authenticate）
    │   ├── transport/  # 传输（http/ws 拆开）
    │   │   ├── http/  # HTTP 服务
    │   │   │   └── http-server.ts  # HTTP 静态 + /login
    │   │   └── ws/  # WS 服务
    │   │       ├── ws-server.test.ts  # 单测
    │   │       └── ws-server.ts  # WS /rpc（hello/cookie 鉴权）
    │   ├── broadcast.ts  # 广播 helper
    │   └── main-context.ts  # MainContext 契约 + Prefs
    └── web/  # 前端（浏览器侧）
        ├── components/  # 槽壳组件
        │   ├── layout-engine.tsx  # 布局引擎
        │   ├── right-panel.tsx  # 右侧面板
        │   ├── settings-page.tsx  # 设置页容器
        │   ├── sidebar.tsx  # 左侧栏
        │   └── titlebar.tsx  # 标题栏
        ├── kernel/  # build-kernel（transport→KernelApi）
        │   └── build-kernel.ts  # window.kernel 构建
        ├── stores/  # 运行时 store
        │   ├── general-config.ts  # 通用配置 store
        │   ├── kernel-logos.ts  # 内核 logo store
        │   ├── layout-store.test.ts  # 单测
        │   ├── layout-store.ts  # 布局 store
        │   ├── session-store.image.test.ts  # 单测
        │   ├── session-store.test.ts  # 单测
        │   ├── session-store.ts  # 会话 store
        │   └── ui-store.ts  # UI store（activeView）
        ├── transport/  # ws-transport（客户端 WS）
        │   ├── ws-transport.test.ts  # 单测
        │   └── ws-transport.ts  # WS 传输三原语 + 缓冲
        ├── ui/  # 通用 UI
        │   ├── button.tsx  # 通用按钮
        │   └── chat-row.tsx  # 聊天行
        ├── event-bus.test.ts  # 单测
        ├── i18n-init.ts  # i18n 初始化
        ├── index.css  # 入口样式
        ├── index.html  # Vite 入口
        ├── index.tsx  # React 入口
        ├── plugins-host.ts  # 插件宿主
        ├── theme-context.tsx  # 主题上下文
        └── ui-store.ts  # UI store
```

## packages/

```text

└── packages/  # 子目录
    ├── my-harness-fit-pi-extension/  # pi 内核桌面适配扩展（五能力合一）
    │   ├── skills/  # 子目录
    │   │   ├── chatroom-collab.md  # 文档
    │   │   ├── delegate-task.md  # 文档
    │   │   ├── orchestrate.md  # 文档
    │   │   ├── parallel-fanout.md  # 文档
    │   │   └── supervise-worker.md  # 文档
    │   ├── tools/  # 子目录
    │   │   ├── abort-subagent.ts  # 模块
    │   │   ├── bus-status.ts  # 模块
    │   │   ├── channel-member.ts  # 模块
    │   │   ├── list-subagents.ts  # 模块
    │   │   ├── send-to-subagent.ts  # 模块
    │   │   ├── session-abort.ts  # 模块
    │   │   ├── session-create.ts  # 模块
    │   │   ├── spawn-subagent.ts  # 模块
    │   │   ├── tap-start.ts  # 模块
    │   │   ├── tap-stop.ts  # 模块
    │   │   └── wait-subagent.ts  # 模块
    │   ├── bus.ts  # 模块
    │   ├── context-probe.ts  # 模块
    │   ├── index.ts  # 导出入口
    │   ├── runtime.ts  # 模块
    │   ├── scanner.ts  # 模块
    │   ├── skills.ts  # 模块
    │   ├── subagent.ts  # 模块
    │   └── toolgate.ts  # 模块
    ├── react/  # React 发布面（组件/hooks/stores + KernelApi）
    │   ├── src/  # 子目录
    │   │   ├── manager/  # 子目录
    │   │   │   ├── kernel-config-form.tsx  # React 组件
    │   │   │   ├── kernel-version-page.tsx  # React 组件
    │   │   │   └── model-config-page.tsx  # React 组件
    │   │   ├── panel/  # 子目录
    │   │   │   ├── index.ts  # 导出入口
    │   │   │   ├── panel-card.tsx  # React 组件
    │   │   │   ├── panel-icon-button.tsx  # React 组件
    │   │   │   ├── panel-row.tsx  # React 组件
    │   │   │   ├── panel-search-input.tsx  # React 组件
    │   │   │   ├── panel-section-title.tsx  # React 组件
    │   │   │   ├── panel-stat-row.tsx  # React 组件
    │   │   │   ├── panel-tabs.tsx  # React 组件
    │   │   │   └── panel-toolbar.tsx  # React 组件
    │   │   ├── widgets/  # 子目录
    │   │   │   ├── button.tsx  # React 组件
    │   │   │   ├── context-menu.tsx  # React 组件
    │   │   │   ├── control-geometry.ts  # 模块
    │   │   │   ├── empty-state.tsx  # React 组件
    │   │   │   ├── file-tree.css  # 样式
    │   │   │   ├── file-tree.tsx  # React 组件
    │   │   │   ├── kernel-logo.tsx  # React 组件
    │   │   │   ├── pagination.tsx  # React 组件
    │   │   │   ├── plugin-icon.tsx  # React 组件
    │   │   │   ├── section.tsx  # React 组件
    │   │   │   ├── select.tsx  # React 组件
    │   │   │   ├── sortable-list.tsx  # React 组件
    │   │   │   └── toast.tsx  # React 组件
    │   │   ├── aux-block-parsers.ts  # 模块
    │   │   ├── block-renderers.ts  # 模块
    │   │   ├── code-block-renderers.ts  # 模块
    │   │   ├── composer-actions.ts  # 模块
    │   │   ├── composer-attachments.ts  # 模块
    │   │   ├── composer-policies.ts  # 模块
    │   │   ├── composer-stats.ts  # 模块
    │   │   ├── error-boundary.tsx  # React 组件
    │   │   ├── event-bus.ts  # 模块
    │   │   ├── file-actions.ts  # 模块
    │   │   ├── file-icons.ts  # 模块
    │   │   ├── index.ts  # 导出入口
    │   │   ├── inline-confirm.tsx  # React 组件
    │   │   ├── kernel-extensions-page.tsx  # React 组件
    │   │   ├── list-item.tsx  # React 组件
    │   │   ├── message-actions.ts  # 模块
    │   │   ├── plugin-context.ts  # 模块
    │   │   ├── plugin-id-context.ts  # 模块
    │   │   ├── plugin-modules.ts  # 模块
    │   │   ├── plugin-overlays.tsx  # React 组件
    │   │   ├── session-groupings.ts  # 模块
    │   │   ├── settings-groups.ts  # 模块
    │   │   └── settings-section.tsx  # React 组件
    │   └── package.json  # i18n 资源
    └── shared/  # 圆心 workspace 包（前后端都 import，零依赖）
        ├── src/  # 圆心源码
        │   ├── channel/  # 通道契约
        │   │   ├── channel-contract.ts  # 通道树
        │   │   └── channel-meta.ts  # 通道元数据
        │   ├── domain/  # 纯类型
        │   │   ├── events/  # 子目录
        │   │   │   ├── kernel-event.ts  # 内核事件类型
        │   │   │   ├── session-bus.ts  # 会话总线类型
        │   │   │   ├── session-state.test.ts  # 单测
        │   │   │   └── session-state.ts  # 会话状态类型
        │   │   ├── slots/  # 子目录
        │   │   │   └── theme-tokens.ts  # 主题 token 契约
        │   │   ├── aux-blocks.test.ts  # 单测
        │   │   ├── aux-blocks.ts  # 辅助块契约
        │   │   ├── backend.test.ts  # 单测
        │   │   ├── backend.ts  # BaseBackend 中立契约
        │   │   ├── context.ts  # 上下文类型 + PluginContext
        │   │   ├── contributions.ts  # 槽位贡献
        │   │   ├── custom-order.ts  # 自定义排序
        │   │   ├── extensions.ts  # 扩展类型
        │   │   ├── file-icons.test.ts  # 单测
        │   │   ├── file-icons.ts  # 文件图标契约
        │   │   ├── host.ts  # Host 接口
        │   │   ├── kernel-manager.ts  # KernelSpec
        │   │   ├── kernel-warmup.ts  # warmup 契约
        │   │   ├── kernel.ts  # KernelId 单源
        │   │   ├── layout.ts  # 布局类型
        │   │   ├── path-utils.test.ts  # 单测
        │   │   ├── path-utils.ts  # 路径工具纯函数
        │   │   ├── remote.ts  # 线协议类型
        │   │   ├── restart.ts  # 重启状态类型
        │   │   ├── session-neutral.test.ts  # 单测
        │   │   ├── session-neutral.ts  # 中性会话层
        │   │   ├── sessions.ts  # 会话类型
        │   │   ├── skills.ts  # 技能契约
        │   │   ├── working-phase.test.ts  # 单测
        │   │   └── working-phase.ts  # 工作阶段
        │   ├── wire/  # 线协议实现
        │   │   └── wire.ts  # 线协议 parse/serialize
        │   ├── index.ts  # barrel re-export
        │   ├── paths.ts  # 配置路径常量
        │   └── style-presets.ts  # 样式预设清单
        └── package.json  # i18n 资源
```
