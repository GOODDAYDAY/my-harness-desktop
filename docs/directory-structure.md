# 目录结构说明（带解释）

> 前后端分离后的完整目录结构，每行带说明（统一缩进到 60 列）。i18n 语言包已折叠为一行，源码文件全量列出，每条说明不少于 20 字。

## src/

```text
└── src/                                                    # 源码根目录：前端、后端、插件三层结构的顶层
    ├── plugins/                                            # 内容层壳插件：一切可插拔功能，按域分组管理
    │   ├── insight/                                        # 子目录：按域组织该功能块的源码与资源文件
    │   │   ├── blind-review/                               # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── client/                                 # 后端适配：该插件与内核系统交互的流出逻辑
    │   │   │   │   └── squad-runner.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── assemble.ts                         # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   ├── config.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   └── run-state.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── llm-recorder/                               # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── log-model.test.ts                   # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   ├── log-model.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   ├── payload-model.test.ts               # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   └── payload-model.ts                    # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── pi-extension/                           # pi 内核扩展：该插件注入内核侧的扩展实现
    │   │   │   │   └── index.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── payload-views.tsx                   # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   └── record-modal.tsx                    # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── extension-flow.test.ts                  # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   └── token-stats/                                # 子目录：按域组织该功能块的源码与资源文件
    │   │       ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │       ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │       │   ├── context-usage-bar.tsx               # React 组件：该功能块的界面渲染与交互逻辑
    │   │       │   ├── hover-tip.tsx                       # React 组件：该功能块的界面渲染与交互逻辑
    │   │       │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │       │   └── stats-titlebar.tsx                  # React 组件：该功能块的界面渲染与交互逻辑
    │   │       └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   ├── manager/                                        # 子目录：按域组织该功能块的源码与资源文件
    │   │   ├── dsh-manager/                                # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── extensions.tsx                      # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── kernel.tsx                          # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   └── models.tsx                          # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── pi-manager/                                 # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── extensions.tsx                      # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   └── models.tsx                          # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── plugin-manager/                             # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── skill-manager/                              # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   └── skill-aux.tsx                       # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── theme-manager/                              # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── tabs/                               # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   │   ├── font-tab.tsx                    # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   │   ├── sidebar-tab.tsx                 # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   │   ├── sidepanel-tab.tsx               # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   │   ├── theme-tab.tsx                   # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   │   └── timeline-tab.tsx                # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── sidebar-style-preview.tsx           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── sidepanel-style-preview.tsx         # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   └── theme-preview.tsx                   # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   └── tool-manager/                               # 子目录：按域组织该功能块的源码与资源文件
    │   │       ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │       │   ├── types.test.ts                       # 单元测试：验证对应模块的正确行为与边界条件
    │   │       │   └── types.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │       ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │       ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │       │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │       └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   ├── project/                                        # 子目录：按域组织该功能块的源码与资源文件
    │   │   ├── file-preview/                               # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── file-tree/                                  # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── git-review/                                 # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── projects/                                   # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   └── stickers/                                   # 子目录：按域组织该功能块的源码与资源文件
    │   │       ├── client/                                 # 后端适配：该插件与内核系统交互的流出逻辑
    │   │       │   ├── stickers-store.test.ts              # 单元测试：验证对应模块的正确行为与边界条件
    │   │       │   └── stickers-store.ts                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │       ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │       ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │       │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │       │   ├── sticker-card.tsx                    # React 组件：该功能块的界面渲染与交互逻辑
    │   │       │   ├── sticker-composer-button.tsx         # React 组件：该功能块的界面渲染与交互逻辑
    │   │       │   └── sticker.tsx                         # React 组件：该功能块的界面渲染与交互逻辑
    │   │       └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   ├── sessions/                                       # 子目录：按域组织该功能块的源码与资源文件
    │   │   ├── ask/                                        # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── pi-extension/                           # pi 内核扩展：该插件注入内核侧的扩展实现
    │   │   │   │   └── index.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── ask-host.tsx                        # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── ask-question-card.tsx               # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── continue/                                   # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── goal/                                       # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── pi-extension/                           # pi 内核扩展：该插件注入内核侧的扩展实现
    │   │   │   │   ├── goal-fold.test.ts                   # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   ├── goal-fold.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   ├── goal-store.ts                       # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   └── index.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── goal-card.tsx                       # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── graphviz/                                   # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── im-graph/                                   # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── client/                                 # 后端适配：该插件与内核系统交互的流出逻辑
    │   │   │   │   └── bus-observer.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── flow-events.test.ts                 # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   ├── flow-events.ts                      # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   ├── graph-model.test.ts                 # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   └── graph-model.ts                      # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── EventFlow.tsx                       # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── GraphCanvas.tsx                     # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── im-graph.css                        # 样式文件：定义该模块的视觉样式与布局规则
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── markdown/                                   # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── markdown-body.tsx                   # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── markdown.tsx                        # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   └── stream-utils.tsx                    # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── mermaid/                                    # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── message-blocks/                             # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── comments-only-bubble.tsx            # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── entry-divider.tsx                   # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── stream-text-reveal.tsx              # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── thinking-chain-block.tsx            # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── tool-cards.tsx                      # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   └── user-bubble.tsx                     # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── puml/                                       # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── retry/                                      # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── review/                                     # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── basket-bar.tsx                      # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   └── review-basket-store.ts              # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── session-bookmarks/                          # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── session-colors/                             # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── pin.test.ts                         # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   └── pin.ts                              # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── pin-store.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   └── pin-svg.tsx                         # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── DESIGN.md                               # Markdown 文档：说明文档、技能或设计文档
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── session-tree/                               # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── tree-model.test.ts                  # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   ├── tree-model.ts                       # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   └── tree-visual.ts                      # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── fullscreen-map.tsx                  # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── sessions-list/                              # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── sub-agent/                                  # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── client/                                 # 后端适配：该插件与内核系统交互的流出逻辑
    │   │   │   │   └── ports.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   └── orchestrator.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── dialog-state.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   ├── dialog.tsx                          # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── orchestrator-singleton.ts           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   ├── panel.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── settings.tsx                        # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   └── spawn-card.tsx                      # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── tools/                                  # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   ├── abort-subagent.ts                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   ├── list-subagents.ts                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   ├── send-to-subagent.ts                 # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   ├── spawn-subagent.ts                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   └── wait-subagent.ts                    # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   └── timeline/                                   # 子目录：按域组织该功能块的源码与资源文件
    │   │       ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │       │   ├── attach-images.ts                    # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │       │   ├── retry-collapse.test.ts              # 单元测试：验证对应模块的正确行为与边界条件
    │   │       │   ├── retry-collapse.ts                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │       │   ├── tool-result-fold.test.ts            # 单元测试：验证对应模块的正确行为与边界条件
    │   │       │   └── tool-result-fold.ts                 # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │       ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │       ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │       │   ├── block-renderer.tsx                  # React 组件：该功能块的界面渲染与交互逻辑
    │   │       │   ├── blocks.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
    │   │       │   ├── blocks.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │       │   ├── composer.tsx                        # React 组件：该功能块的界面渲染与交互逻辑
    │   │       │   ├── image-block.tsx                     # React 组件：该功能块的界面渲染与交互逻辑
    │   │       │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │       │   ├── message-actions.tsx                 # React 组件：该功能块的界面渲染与交互逻辑
    │   │       │   ├── queue-basket.tsx                    # React 组件：该功能块的界面渲染与交互逻辑
    │   │       │   └── timeline-scroll-bridge.tsx          # React 组件：该功能块的界面渲染与交互逻辑
    │   │       └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   ├── system/                                         # 子目录：按域组织该功能块的源码与资源文件
    │   │   ├── debug-bar/                                  # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── general-config/                             # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   │   └── plugin.md                               # Markdown 文档：说明文档、技能或设计文档
    │   │   ├── goody-hao/                                  # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── skills/                                 # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   ├── arch-to-code/                       # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   │   ├── references/                     # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   │   │   ├── blind-review-prompts.md     # Markdown 文档：说明文档、技能或设计文档
    │   │   │   │   │   │   └── workflow-script.js          # JavaScript 脚本：辅助脚本或构建工具
    │   │   │   │   │   └── SKILL.md                        # Markdown 文档：说明文档、技能或设计文档
    │   │   │   │   └── write-design-doc/                   # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │       └── SKILL.md                        # Markdown 文档：说明文档、技能或设计文档
    │   │   │   ├── CLAUDE.md                               # Markdown 文档：说明文档、技能或设计文档
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── i18n/                                       # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── key-hints/                                  # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── hints.test.ts                       # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   └── hints.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   ├── key-hints.css                       # 样式文件：定义该模块的视觉样式与布局规则
    │   │   │   │   └── settings.tsx                        # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── DESIGN.md                               # Markdown 文档：说明文档、技能或设计文档
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── keybindings/                                # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── bindings.test.ts                    # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   ├── bindings.ts                         # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   ├── combo.test.ts                       # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   └── combo.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   │   └── settings.tsx                        # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── DESIGN.md                               # Markdown 文档：说明文档、技能或设计文档
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── notifier/                                   # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   ├── read-claude-md/                             # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── pi-extension/                           # pi 内核扩展：该插件注入内核侧的扩展实现
    │   │   │   │   ├── extension/                          # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   │   └── index.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   │   └── package.json                        # JSON 数据：结构化配置、清单或文案资源
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   │   └── remote-access/                              # 子目录：按域组织该功能块的源码与资源文件
    │   │       ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │   │       ├── renderer/                               # 前端部分：该插件的 React 渲染界面与交互逻辑
    │   │       │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │       └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │   └── themes/                                         # 子目录：按域组织该功能块的源码与资源文件
    │       ├── font-presets/                               # 子目录：按域组织该功能块的源码与资源文件
    │       │   ├── locales/                                # i18n 语言包：各语种文案资源，已折叠为一行
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │       ├── theme/                                      # 子目录：按域组织该功能块的源码与资源文件
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │       ├── theme-chatgpt/                              # 子目录：按域组织该功能块的源码与资源文件
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │       ├── theme-everforest/                           # 子目录：按域组织该功能块的源码与资源文件
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │       ├── theme-midnight/                             # 子目录：按域组织该功能块的源码与资源文件
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │       ├── theme-mocha/                                # 子目录：按域组织该功能块的源码与资源文件
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │       ├── theme-new-york/                             # 子目录：按域组织该功能块的源码与资源文件
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │       ├── theme-stone/                                # 子目录：按域组织该功能块的源码与资源文件
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    │       └── theme-terminal/                             # 子目录：按域组织该功能块的源码与资源文件
    │           └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与入口
    ├── server/                                             # 后端：跑在 node / Electron main 侧的全部服务端逻辑
    │   ├── application/                                    # 后端用例编排：会话、配置、加载器、模型合流等编排层
    │   │   ├── bundled/                                    # 内置资源镜像：把仓库 skills/stickers 镜像到数据根
    │   │   │   └── mirror.ts                               # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── config/                                     # 配置读写：config-store/config-file/json-prefs/json-merge
    │   │   │   ├── config-file.ts                          # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── config-store.ts                         # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── json-merge.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   └── json-prefs.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── extensions/                                 # 内核扩展管理：统一管理内核扩展的安装与状态
    │   │   │   └── kernel-extension-manager.ts             # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── i18n/                                       # i18n 资源合并与翻译器：服务端合并语言包后下发
    │   │   │   ├── merge.ts                                # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   └── translator.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── installer/                                  # 安装器：统一封装资源的下载与安装流程，负责对应功能的具体实现
    │   │   │   └── index.ts                                # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── lifecycle/                                  # 插件生命周期：activate/deactivate/dispose 编排
    │   │   │   └── index.ts                                # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── loader/                                     # 插件发现与注册表：扫描校验并注册壳插件，负责对应功能的具体实现
    │   │   │   ├── discover.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── registry.test.ts                        # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   └── registry.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── models/                                     # 多内核模型合流：ModelCatalog 合并各内核模型清单
    │   │   │   ├── model-catalog.test.ts                   # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   └── model-catalog.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── restart/                                    # 重启协调：RestartCoordinator 管理会话重启状态机
    │   │   │   └── restart-coordinator.ts                  # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── sessions/                                   # 会话编排核心：session-store 只依赖 BaseBackend 接口
    │   │   │   ├── neutral-session-store.test.ts           # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── neutral-session-store.ts                # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── session-bus.ts                          # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── session-role.test.ts                    # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── session-store.dsh.integration.test.ts   # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── session-store.test.ts                   # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   └── session-store.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── skills/                                     # 多内核技能聚合：合并 pi/dsh 两侧的 SkillProvider
    │   │   │   ├── bundled-skills.ts                       # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   └── skill-aggregator.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   └── theme/                                      # 主题合并与对比度审计：服务端构建主题并做 WCAG 审计
    │   │       ├── contrast.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │       └── merge.ts                                # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── bootstrap/                                      # 组装根：最外层，把接口与实现绑定后启动应用
    │   │   ├── host/                                       # 宿主能力实现：electron-host 与 node-host 两套适配
    │   │   │   ├── electron-host.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   └── node-host.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── kernel/                                     # 内核注册表：把 BaseBackend 接口绑定到各内核实现
    │   │   │   ├── kernel-factories.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── kernel-logos.ts                         # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   └── kernel-managers.ts                      # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── assemble.ts                                 # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── electron.ts                                 # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   └── server.ts                                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── client/                                         # 其他外部适配器：文件系统、git、npm、远程探测
    │   │   ├── fs/                                         # 文件系统读写：目录树、文本文件增删改与同步
    │   │   │   ├── fs-ops.ts                               # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── fs-sync.ts                              # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── fs-tree.test.ts                         # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   └── fs-tree.ts                              # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── git/                                        # Git 读写：只读状态查询与收敛写面 commit/push
    │   │   │   ├── git-status.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   └── git-write.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── npm/                                        # npm 集成：npm install 与 registry 版本查询
    │   │   │   └── kernel-runtime.ts                       # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── remote/                                     # 远程探测：局域网 IP、cloudflared 隧道、二维码
    │   │   │   ├── cloudflared-download.ts                 # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── cloudflared.ts                          # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── lan-ip.ts                               # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   └── qr.ts                                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── kernel-extension.ts                         # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── paths.ts                                    # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   └── skill-frontmatter.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── controllers/                                    # controller 层：14 个 channel 域，解包参数后委托
    │   │   ├── app-info.ts                                 # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── appearance.ts                               # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── bus.ts                                      # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── config.ts                                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── extensions.ts                               # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── fs-git.ts                                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── kernel.ts                                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── notification.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── plugins.ts                                  # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── remote.ts                                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── sessions.ts                                 # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── skills.ts                                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── slots-dialog.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   └── window.ts                                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── kernel/                                         # 内核域：抽象基类与 pi/dsh 两个同级内核实现
    │   │   ├── dsh/                                        # dsh 内核全部：json-rpc、后端、安装器、warmup 内聚
    │   │   │   ├── dsh-extension/                          # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   ├── extension.json                      # JSON 数据：结构化配置、清单或文案资源
    │   │   │   │   └── index.mjs                           # ES 模块入口：该扩展的可执行入口脚本，负责对应功能的具体实现
    │   │   │   ├── dsh-backend.integration.test.ts         # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── dsh-backend.test.ts                     # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── dsh-backend.ts                          # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-catalog.ts                          # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-config-source.test.ts               # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── dsh-config-source.ts                    # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-event-translator.test.ts            # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── dsh-event-translator.ts                 # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-extension-installer.test.ts         # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── dsh-extension-installer.ts              # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-extension-manager.ts                # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-extension-manifest.ts               # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-kernel-api.test.ts                  # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── dsh-kernel-api.ts                       # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-kernel-config.ts                    # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-kernel.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-logo.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-methods.ts                          # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-question-bridge.ts                  # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-skill-provider.ts                   # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── dsh-warmup.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── json-rpc.test.ts                        # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── json-rpc.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   └── subprocess-lifecycle.ts                 # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── pi/                                         # pi 内核全部：协议、后端、安装器、warmup 内聚一处
    │   │   │   ├── commands.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── context-binding.test.ts                 # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── context-binding.ts                      # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── correlator.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── event-translator.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── known-tools.ts                          # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── models-config.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── models-store.ts                         # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── my-harness-fit-pi-extension-installer.ts  # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── patch-rpc-mode.ts                       # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-backend-extensions.ts                # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-backend.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── pi-backend.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-bundled-skills.ts                    # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-catalog.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── pi-catalog.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-cli.ts                               # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-extension-installer.ts               # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-extension-manager.ts                 # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-kernel-api.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-kernel-config.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-kernel.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-logo.ts                              # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-model-source.ts                      # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-oneshot.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-settings-store.ts                    # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-skill-provider.ts                    # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── pi-warmup.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── resync.ts                               # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── rpc-adapter.ts                          # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── rpc-types.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── subprocess-handle.ts                    # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── subprocess-lifecycle.ts                 # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   └── versions.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── abstract-backend.ts                         # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── kernel-manager.install.test.ts              # 单元测试：验证对应模块的正确行为与边界条件
    │   │   ├── kernel-manager.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
    │   │   ├── kernel-manager.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   └── kernel-runtime.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── remote/                                         # web 鉴权：auth/token/password/rate-limiter/remote-config
    │   │   ├── auth.test.ts                                # 单元测试：验证对应模块的正确行为与边界条件
    │   │   ├── auth.ts                                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── password.test.ts                            # 单元测试：验证对应模块的正确行为与边界条件
    │   │   ├── password.ts                                 # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── rate-limiter.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── remote-config.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── token.test.ts                               # 单元测试：验证对应模块的正确行为与边界条件
    │   │   └── token.ts                                    # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── routing/                                        # channel 路由：传输无关的 gateway 分发与广播编排
    │   │   ├── gateway.test.ts                             # 单元测试：验证对应模块的正确行为与边界条件
    │   │   └── gateway.ts                                  # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── transport/                                      # 传输层：HTTP 与 WebSocket 两个服务，物理拆开
    │   │   ├── http/                                       # HTTP 服务：静态托管 + 登录登出 + 健康状态接口
    │   │   │   └── http-server.ts                          # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   └── ws/                                         # WS 服务：/rpc 升级 + hello/cookie 鉴权 + 帧解析
    │   │       ├── ws-server.test.ts                       # 单元测试：验证对应模块的正确行为与边界条件
    │   │       └── ws-server.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── broadcast.ts                                    # 广播工具：broadcastSettingsChanged 统一广播设置变更
    │   └── main-context.ts                                 # MainContext 依赖契约与 Prefs 默认值定义
    └── web/                                                # 前端：跑在浏览器侧的 React 渲染与交互逻辑
        ├── components/                                     # 子目录：按域组织该功能块的源码与资源文件
        │   ├── layout-engine.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
        │   ├── right-panel.tsx                             # React 组件：该功能块的界面渲染与交互逻辑
        │   ├── settings-page.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
        │   ├── sidebar.tsx                                 # React 组件：该功能块的界面渲染与交互逻辑
        │   └── titlebar.tsx                                # React 组件：该功能块的界面渲染与交互逻辑
        ├── kernel/                                         # 子目录：按域组织该功能块的源码与资源文件
        │   └── build-kernel.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
        ├── stores/                                         # 子目录：按域组织该功能块的源码与资源文件
        │   ├── general-config.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   ├── kernel-logos.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   ├── layout-store.test.ts                        # 单元测试：验证对应模块的正确行为与边界条件
        │   ├── layout-store.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   ├── session-store.image.test.ts                 # 单元测试：验证对应模块的正确行为与边界条件
        │   ├── session-store.test.ts                       # 单元测试：验证对应模块的正确行为与边界条件
        │   ├── session-store.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   └── ui-store.ts                                 # TypeScript 模块：该功能块的业务逻辑与工具函数
        ├── transport/                                      # 子目录：按域组织该功能块的源码与资源文件
        │   ├── ws-transport.test.ts                        # 单元测试：验证对应模块的正确行为与边界条件
        │   └── ws-transport.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
        ├── ui/                                             # 子目录：按域组织该功能块的源码与资源文件
        │   ├── button.tsx                                  # React 组件：该功能块的界面渲染与交互逻辑
        │   └── chat-row.tsx                                # React 组件：该功能块的界面渲染与交互逻辑
        ├── event-bus.test.ts                               # 单元测试：验证对应模块的正确行为与边界条件
        ├── i18n-init.ts                                    # TypeScript 模块：该功能块的业务逻辑与工具函数
        ├── index.css                                       # 样式文件：定义该模块的视觉样式与布局规则
        ├── index.html                                      # 文件：该功能块的实现或资源定义，负责对应功能的具体实现
        ├── index.tsx                                       # React 组件：该功能块的界面渲染与交互逻辑
        ├── plugins-host.ts                                 # TypeScript 模块：该功能块的业务逻辑与工具函数
        ├── theme-context.tsx                               # React 组件：该功能块的界面渲染与交互逻辑
        └── ui-store.ts                                     # TypeScript 模块：该功能块的业务逻辑与工具函数
```

## packages/

```text
└── packages/                                               # 发布面包目录：shared/react 等 workspace 包
    ├── my-harness-fit-pi-extension/                        # pi 内核桌面适配扩展：五能力合一入口，负责对应功能的具体实现
    │   ├── skills/                                         # 子目录：按域组织该功能块的源码与资源文件
    │   │   ├── chatroom-collab.md                          # Markdown 文档：说明文档、技能或设计文档
    │   │   ├── delegate-task.md                            # Markdown 文档：说明文档、技能或设计文档
    │   │   ├── orchestrate.md                              # Markdown 文档：说明文档、技能或设计文档
    │   │   ├── parallel-fanout.md                          # Markdown 文档：说明文档、技能或设计文档
    │   │   └── supervise-worker.md                         # Markdown 文档：说明文档、技能或设计文档
    │   ├── tools/                                          # 子目录：按域组织该功能块的源码与资源文件
    │   │   ├── abort-subagent.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── bus-status.ts                               # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── channel-member.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── list-subagents.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── send-to-subagent.ts                         # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── session-abort.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── session-create.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── spawn-subagent.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── tap-start.ts                                # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── tap-stop.ts                                 # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   └── wait-subagent.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── bus.ts                                          # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── context-probe.ts                                # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── index.ts                                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── runtime.ts                                      # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── scanner.ts                                      # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── skills.ts                                       # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   ├── subagent.ts                                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   └── toolgate.ts                                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    ├── react/                                              # React 发布面：组件、hooks、事件总线、stores 与 KernelApi
    │   ├── src/                                            # 子目录：按域组织该功能块的源码与资源文件
    │   │   ├── manager/                                    # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── kernel-config-form.tsx                  # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── kernel-version-page.tsx                 # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── model-config-page.tsx                   # React 组件：该功能块的界面渲染与交互逻辑
    │   │   ├── panel/                                      # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── index.ts                                # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── panel-card.tsx                          # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── panel-icon-button.tsx                   # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── panel-row.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── panel-search-input.tsx                  # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── panel-section-title.tsx                 # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── panel-stat-row.tsx                      # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── panel-tabs.tsx                          # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── panel-toolbar.tsx                       # React 组件：该功能块的界面渲染与交互逻辑
    │   │   ├── widgets/                                    # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── button.tsx                              # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── context-menu.tsx                        # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── control-geometry.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   │   ├── empty-state.tsx                         # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── file-tree.css                           # 样式文件：定义该模块的视觉样式与布局规则
    │   │   │   ├── file-tree.tsx                           # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── kernel-logo.tsx                         # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── pagination.tsx                          # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── plugin-icon.tsx                         # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── section.tsx                             # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── select.tsx                              # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   ├── sortable-list.tsx                       # React 组件：该功能块的界面渲染与交互逻辑
    │   │   │   └── toast.tsx                               # React 组件：该功能块的界面渲染与交互逻辑
    │   │   ├── aux-block-parsers.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── block-renderers.ts                          # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── code-block-renderers.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── composer-actions.ts                         # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── composer-attachments.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── composer-policies.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── composer-stats.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── error-boundary.tsx                          # React 组件：该功能块的界面渲染与交互逻辑
    │   │   ├── event-bus.ts                                # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── file-actions.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── file-icons.ts                               # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── index.ts                                    # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── inline-confirm.tsx                          # React 组件：该功能块的界面渲染与交互逻辑
    │   │   ├── kernel-extensions-page.tsx                  # React 组件：该功能块的界面渲染与交互逻辑
    │   │   ├── list-item.tsx                               # React 组件：该功能块的界面渲染与交互逻辑
    │   │   ├── message-actions.ts                          # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── plugin-context.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── plugin-id-context.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── plugin-modules.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── plugin-overlays.tsx                         # React 组件：该功能块的界面渲染与交互逻辑
    │   │   ├── session-groupings.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   ├── settings-groups.ts                          # TypeScript 模块：该功能块的业务逻辑与工具函数
    │   │   └── settings-section.tsx                        # React 组件：该功能块的界面渲染与交互逻辑
    │   └── package.json                                    # JSON 数据：结构化配置、清单或文案资源
    └── shared/                                             # 圆心 workspace 包：前后端共用的纯契约，零依赖
        ├── src/                                            # 子目录：按域组织该功能块的源码与资源文件
        │   ├── channel/                                    # 子目录：按域组织该功能块的源码与资源文件
        │   │   ├── channel-contract.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   └── channel-meta.ts                         # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   ├── domain/                                     # 子目录：按域组织该功能块的源码与资源文件
        │   │   ├── events/                                 # 子目录：按域组织该功能块的源码与资源文件
        │   │   │   ├── kernel-event.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   │   ├── session-bus.ts                      # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   │   ├── session-state.test.ts               # 单元测试：验证对应模块的正确行为与边界条件
        │   │   │   └── session-state.ts                    # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── slots/                                  # 子目录：按域组织该功能块的源码与资源文件
        │   │   │   └── theme-tokens.ts                     # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── aux-blocks.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
        │   │   ├── aux-blocks.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── backend.test.ts                         # 单元测试：验证对应模块的正确行为与边界条件
        │   │   ├── backend.ts                              # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── context.ts                              # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── contributions.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── custom-order.ts                         # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── extensions.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── file-icons.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
        │   │   ├── file-icons.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── host.ts                                 # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── kernel-manager.ts                       # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── kernel-warmup.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── kernel.ts                               # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── layout.ts                               # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── path-utils.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
        │   │   ├── path-utils.ts                           # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── remote.ts                               # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── restart.ts                              # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── session-neutral.test.ts                 # 单元测试：验证对应模块的正确行为与边界条件
        │   │   ├── session-neutral.ts                      # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── sessions.ts                             # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── skills.ts                               # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   │   ├── working-phase.test.ts                   # 单元测试：验证对应模块的正确行为与边界条件
        │   │   └── working-phase.ts                        # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   ├── wire/                                       # 子目录：按域组织该功能块的源码与资源文件
        │   │   └── wire.ts                                 # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   ├── index.ts                                    # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   ├── paths.ts                                    # TypeScript 模块：该功能块的业务逻辑与工具函数
        │   └── style-presets.ts                            # TypeScript 模块：该功能块的业务逻辑与工具函数
        └── package.json                                    # JSON 数据：结构化配置、清单或文案资源
```
