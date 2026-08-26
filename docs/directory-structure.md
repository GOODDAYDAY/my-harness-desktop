                                                            # 目录结构说明（带解释）

> 前后端分离后的完整目录结构，每行带说明（统一缩进）。i18n 语言包已折叠为一行，源码文件全量列出。

#                                                           # src/，实现见源码

```text

└── src/                                                    # 子目录：按域组织该功能块的源码与资源文件
    ├── plugins/                                            # 内容层壳插件：一切可插拔功能，按域分组管理
    │   ├── insight/                                        # 洞察类插件：盲审、LLM 录制、token 统计等
    │   │   ├── blind-review/                               # 盲审插件：提供代码盲审的工作流编排与界面
    │   │   │   ├── client/                                 # 后端适配：该插件与内核、系统交互的流出逻辑
    │   │   │   │   └── squad-runner.ts                     # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── assemble.ts                         # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   ├── config.ts                           # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   └── run-state.ts                        # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── llm-recorder/                               # LLM 录制插件：记录与回放大模型的请求与响应
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── log-model.test.ts                   # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   ├── log-model.ts                        # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   ├── payload-model.test.ts               # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   └── payload-model.ts                    # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── pi-extension/                           # pi 内核扩展：该插件注入内核侧的扩展实现
    │   │   │   │   └── index.ts                            # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── payload-views.tsx                   # React 组件：该功能块的界面渲染与交互
    │   │   │   │   └── record-modal.tsx                    # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── extension-flow.test.ts                  # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   └── token-stats/                                # token 统计插件：展示会话与模型的 token 用量统计
    │   │       ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │       ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │       │   ├── context-usage-bar.tsx               # React 组件：该功能块的界面渲染与交互
    │   │       │   ├── hover-tip.tsx                       # React 组件：该功能块的界面渲染与交互
    │   │       │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │       │   └── stats-titlebar.tsx                  # React 组件：该功能块的界面渲染与交互
    │   │       └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   ├── manager/                                        # 管理类插件：内核/插件/技能/主题/工具管理页
    │   │   ├── dsh-manager/                                # dsh 管理页：管理 dsh 内核的版本安装与状态
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── extensions.tsx                      # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── kernel.tsx                          # React 组件：该功能块的界面渲染与交互
    │   │   │   │   └── models.tsx                          # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── pi-manager/                                 # pi 管理页：管理 pi 内核的版本安装与状态
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── extensions.tsx                      # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   └── models.tsx                          # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── plugin-manager/                             # 插件管理页：壳插件的启用、禁用与卸载管理
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── skill-manager/                              # 技能管理页：管理技能的启用与模型可调用配置
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   └── skill-aux.tsx                       # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── theme-manager/                              # 主题管理页：主题配色与字体的可视化配置界面
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── tabs/                               # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   │   ├── font-tab.tsx                    # React 组件：该功能块的界面渲染与交互
    │   │   │   │   │   ├── sidebar-tab.tsx                 # React 组件：该功能块的界面渲染与交互
    │   │   │   │   │   ├── sidepanel-tab.tsx               # React 组件：该功能块的界面渲染与交互
    │   │   │   │   │   ├── theme-tab.tsx                   # React 组件：该功能块的界面渲染与交互
    │   │   │   │   │   └── timeline-tab.tsx                # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── sidebar-style-preview.tsx           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── sidepanel-style-preview.tsx         # React 组件：该功能块的界面渲染与交互
    │   │   │   │   └── theme-preview.tsx                   # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   └── tool-manager/                               # 工具管理页：管理各工具能力的启用与禁用
    │   │       ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │       │   ├── types.test.ts                       # 单元测试：验证对应模块的正确行为与边界条件
    │   │       │   └── types.ts                            # TypeScript 模块：该功能块的逻辑与工具函数
    │   │       ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │       ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │       │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │       └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   ├── project/                                        # 项目类插件：文件预览/文件树/git-review/项目/贴纸
    │   │   ├── file-preview/                               # 文件预览插件：在界面上预览文件的内容
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── file-tree/                                  # 文件树插件：在侧栏展示项目目录树结构
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── git-review/                                 # git review 面板：审查变更并执行提交
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── projects/                                   # 项目列表插件：项目的侧栏展示与切换管理
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   └── stickers/                                   # 贴纸包插件：贴纸资源的打包导出与导入
    │   │       ├── client/                                 # 后端适配：该插件与内核、系统交互的流出逻辑
    │   │       │   ├── stickers-store.test.ts              # 单元测试：验证对应模块的正确行为与边界条件
    │   │       │   └── stickers-store.ts                   # TypeScript 模块：该功能块的逻辑与工具函数
    │   │       ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │       ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │       │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │       │   ├── sticker-card.tsx                    # React 组件：该功能块的界面渲染与交互
    │   │       │   ├── sticker-composer-button.tsx         # React 组件：该功能块的界面渲染与交互
    │   │       │   └── sticker.tsx                         # React 组件：该功能块的界面渲染与交互
    │   │       └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   ├── sessions/                                       # 会话类插件：时间线/会话树/会话列表/ask/goal 等
    │   │   ├── ask/                                        # ask 插件：提供单次问答的会话交互模式
    │   │   │   ├── pi-extension/                           # pi 内核扩展：该插件注入内核侧的扩展实现
    │   │   │   │   └── index.ts                            # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── ask-host.tsx                        # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── ask-question-card.tsx               # React 组件：该功能块的界面渲染与交互
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── continue/                                   # 续跑插件：支持会话的继续运行与追加
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── goal/                                       # 目标插件：提供目标导向的会话工作流
    │   │   │   ├── pi-extension/                           # pi 内核扩展：该插件注入内核侧的扩展实现
    │   │   │   │   ├── goal-fold.test.ts                   # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   ├── goal-fold.ts                        # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   ├── goal-store.ts                       # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   └── index.ts                            # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── goal-card.tsx                       # React 组件：该功能块的界面渲染与交互
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── graphviz/                                   # graphviz 渲染插件：渲染 graphviz 图表
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── im-graph/                                   # 图渲染插件：渲染交互式图结构
    │   │   │   ├── client/                                 # 后端适配：该插件与内核、系统交互的流出逻辑
    │   │   │   │   └── bus-observer.ts                     # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── flow-events.test.ts                 # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   ├── flow-events.ts                      # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   ├── graph-model.test.ts                 # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   └── graph-model.ts                      # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── EventFlow.tsx                       # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── GraphCanvas.tsx                     # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── im-graph.css                        # 样式文件：定义该模块的视觉样式与布局
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── markdown/                                   # markdown 渲染插件：渲染 markdown 块内容
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── markdown-body.tsx                   # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── markdown.tsx                        # React 组件：该功能块的界面渲染与交互
    │   │   │   │   └── stream-utils.tsx                    # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── mermaid/                                    # mermaid 渲染插件：渲染 mermaid 图表
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── message-blocks/                             # 消息块插件：渲染块级消息内容
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── comments-only-bubble.tsx            # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── entry-divider.tsx                   # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── stream-text-reveal.tsx              # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── thinking-chain-block.tsx            # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── tool-cards.tsx                      # React 组件：该功能块的界面渲染与交互
    │   │   │   │   └── user-bubble.tsx                     # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── puml/                                       # plantuml 渲染插件：渲染 plantuml 图表
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── retry/                                      # 重试插件：提供消息重试的交互入口
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── review/                                     # 审查插件：提供会话内容的审查流程
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── basket-bar.tsx                      # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   └── review-basket-store.ts              # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── session-bookmarks/                          # 会话书签插件：管理会话的书签标记
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── session-colors/                             # 会话颜色插件：管理会话的配色标识
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── pin.test.ts                         # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   └── pin.ts                              # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── pin-store.ts                        # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   └── pin-svg.tsx                         # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── DESIGN.md                               # Markdown 文档：说明文档或技能/设计文档
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── session-tree/                               # 会话树插件：可视化展示会话的 lineage 树
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── tree-model.test.ts                  # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   ├── tree-model.ts                       # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   └── tree-visual.ts                      # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── fullscreen-map.tsx                  # React 组件：该功能块的界面渲染与交互
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── sessions-list/                              # 会话列表插件：左侧栏的会话清单展示
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── sub-agent/                                  # 子代理插件：编排子代理的会话与任务
    │   │   │   ├── client/                                 # 后端适配：该插件与内核、系统交互的流出逻辑
    │   │   │   │   └── ports.ts                            # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   └── orchestrator.ts                     # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── dialog-state.ts                     # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   ├── dialog.tsx                          # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── orchestrator-singleton.ts           # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   ├── panel.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── settings.tsx                        # React 组件：该功能块的界面渲染与交互
    │   │   │   │   └── spawn-card.tsx                      # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── tools/                                  # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   ├── abort-subagent.ts                   # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   ├── list-subagents.ts                   # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   ├── send-to-subagent.ts                 # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   ├── spawn-subagent.ts                   # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   └── wait-subagent.ts                    # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   └── timeline/                                   # 时间线插件：渲染会话消息流的核心组件
    │   │       ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │       │   ├── attach-images.ts                    # TypeScript 模块：该功能块的逻辑与工具函数
    │   │       │   ├── retry-collapse.test.ts              # 单元测试：验证对应模块的正确行为与边界条件
    │   │       │   ├── retry-collapse.ts                   # TypeScript 模块：该功能块的逻辑与工具函数
    │   │       │   ├── tool-result-fold.test.ts            # 单元测试：验证对应模块的正确行为与边界条件
    │   │       │   └── tool-result-fold.ts                 # TypeScript 模块：该功能块的逻辑与工具函数
    │   │       ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │       ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │       │   ├── block-renderer.tsx                  # React 组件：该功能块的界面渲染与交互
    │   │       │   ├── blocks.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
    │   │       │   ├── blocks.ts                           # TypeScript 模块：该功能块的逻辑与工具函数
    │   │       │   ├── composer.tsx                        # React 组件：该功能块的界面渲染与交互
    │   │       │   ├── image-block.tsx                     # React 组件：该功能块的界面渲染与交互
    │   │       │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │       │   ├── message-actions.tsx                 # React 组件：该功能块的界面渲染与交互
    │   │       │   ├── queue-basket.tsx                    # React 组件：该功能块的界面渲染与交互
    │   │       │   └── timeline-scroll-bridge.tsx          # React 组件：该功能块的界面渲染与交互
    │   │       └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   ├── system/                                         # 系统类插件：远程访问/通用配置/键绑定/通知等
    │   │   ├── debug-bar/                                  # debug 栏插件：复制 DOM 等调试工具集合
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── general-config/                             # 通用配置页：桌面端通用配置的设置界面
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   │   └── plugin.md                               # Markdown 文档：说明文档或技能/设计文档
    │   │   ├── goody-hao/                                  # goody-hao 集成插件：接入第三方工具与能力
    │   │   │   ├── skills/                                 # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   ├── arch-to-code/                       # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   │   ├── references/                     # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   │   │   ├── blind-review-prompts.md     # Markdown 文档：说明文档或技能/设计文档
    │   │   │   │   │   │   └── workflow-script.js          # JavaScript 脚本：辅助脚本或工具
    │   │   │   │   │   └── SKILL.md                        # Markdown 文档：说明文档或技能/设计文档
    │   │   │   │   └── write-design-doc/                   # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │       └── SKILL.md                        # Markdown 文档：说明文档或技能/设计文档
    │   │   │   ├── CLAUDE.md                               # Markdown 文档：说明文档或技能/设计文档
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── i18n/                                       # 语言包插件：提供壳自身界面文案的翻译
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── key-hints/                                  # 快捷键提示插件：浮层展示可用快捷键
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── hints.test.ts                       # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   └── hints.ts                            # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   ├── key-hints.css                       # 样式文件：定义该模块的视觉样式与布局
    │   │   │   │   └── settings.tsx                        # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── DESIGN.md                               # Markdown 文档：说明文档或技能/设计文档
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── keybindings/                                # 键绑定插件：快捷键的注册与绑定管理
    │   │   │   ├── core/                                   # 插件私有编排：该插件的业务逻辑与状态管理
    │   │   │   │   ├── bindings.test.ts                    # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   ├── bindings.ts                         # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   ├── combo.test.ts                       # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   │   └── combo.ts                            # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   ├── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   │   └── settings.tsx                        # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── DESIGN.md                               # Markdown 文档：说明文档或技能/设计文档
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── notifier/                                   # 通知插件：负责系统通知的发送与展示
    │   │   │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │   │   ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │   │   │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   ├── read-claude-md/                             # read-claude-md 插件：读取 claude.md 作为上下文
    │   │   │   ├── pi-extension/                           # pi 内核扩展：该插件注入内核侧的扩展实现
    │   │   │   │   ├── extension/                          # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   │   └── index.ts                        # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   │   └── package.json                        # JSON 数据：结构化配置或资源清单
    │   │   │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   │   └── remote-access/                              # 远程访问设置页：开关/密码/二维码/隧道的设置 UI
    │   │       ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │   │       ├── renderer/                               # 前端部分：该插件的 React 渲染界面所在目录
    │   │       │   └── index.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │       └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │   └── themes/                                         # 主题类插件：主题机制与各配色主题
    │       ├── font-presets/                               # 字体预设插件：提供字体预设的清单
    │       │   ├── locales/                                # i18n 语言包：各语种文案资源（已折叠，共四语）
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │       ├── theme/                                      # 主题机制：主题插件的抽象机制与契约
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │       ├── theme-chatgpt/                              # ChatGPT 配色主题：仿 ChatGPT 的界面配色方案
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │       ├── theme-everforest/                           # Everforest 配色主题
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │       ├── theme-midnight/                             # Midnight 配色主题：深夜风格的界面配色方案
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │       ├── theme-mocha/                                # Mocha 配色主题：暖棕色调的界面配色方案
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │       ├── theme-new-york/                             # New York 配色主题：纽约风格的界面配色方案
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │       ├── theme-stone/                                # Stone 配色主题：石材风格的界面配色方案
    │       │   └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    │       └── theme-terminal/                             # Terminal 配色主题：终端风格的界面配色方案
    │           └── plugin.json                             # 插件清单：声明该插件的槽位贡献、权限与渲染入口
    ├── server/                                             # 后端：跑在 node / Electron main 侧的全部服务端逻辑
    │   ├── application/                                    # 后端用例编排：会话、配置、加载器、模型合流等业务编排层
    │   │   ├── bundled/                                    # 内置资源镜像：把仓库内的 skills/stickers 镜像到数据根受管目录
    │   │   │   └── mirror.ts                               # 资源镜像：把内置目录镜像到数据根受管位置
    │   │   ├── config/                                     # 配置读写：config-store/config-file/json-prefs/json-merge 四件套
    │   │   │   ├── config-file.ts                          # JSON 原语：readJsonFile/writeJsonFile/withDirLock/appendJsonl
    │   │   │   ├── config-store.ts                         # 插件配置存储：项目级与全局级双层读写合并
    │   │   │   ├── json-merge.ts                           # 深合并：递归合并两层配置对象的工具函数
    │   │   │   └── json-prefs.ts                           # 简单 JSON 键值偏好：替代 electron-store 的桌面偏好持久化
    │   │   ├── extensions/                                 # 内核扩展管理：统一管理内核侧扩展的安装与状态
    │   │   │   └── kernel-extension-manager.ts             # 内核扩展管理：统一内核扩展的发现与状态
    │   │   ├── i18n/                                       # i18n 资源合并与翻译器：服务端合并语言包后下发给前端
    │   │   │   ├── merge.ts                                # i18n 合并：合并各语言包资源与命名空间
    │   │   │   └── translator.ts                           # 翻译器：语言探测与 key 翻译的纯函数
    │   │   ├── installer/                                  # 安装器：统一封装各类资源的下载与安装流程
    │   │   │   └── index.ts                                # 安装器：下载与安装各类外部资源的统一入口
    │   │   ├── lifecycle/                                  # 插件生命周期：activate / deactivate / dispose 编排
    │   │   │   └── index.ts                                # 插件生命周期：activate/deactivate/dispose 的编排
    │   │   ├── loader/                                     # 插件发现与注册表：扫描、校验、注册壳插件
    │   │   │   ├── discover.ts                             # 插件发现：扫描各来源目录并识别插件清单
    │   │   │   ├── registry.test.ts                        # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   └── registry.ts                             # 插件注册表：按优先级注册槽位贡献并合并
    │   │   ├── models/                                     # 多内核模型合流：ModelCatalog 合并 pi/dsh 的模型清单
    │   │   │   ├── model-catalog.test.ts                   # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   └── model-catalog.ts                        # ModelCatalog：持多个 KernelModelSource 合并成统一模型清单
    │   │   ├── restart/                                    # 重启协调：RestartCoordinator 管理会话重启状态机
    │   │   │   └── restart-coordinator.ts                  # RestartCoordinator：协调会话重启与 pending 状态流转
    │   │   ├── sessions/                                   # 会话编排核心：session-store 只依赖 BaseBackend 接口
    │   │   │   ├── neutral-session-store.test.ts           # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── neutral-session-store.ts                # 中性会话存储：把内核会话投影成 lineage 树的中性层
    │   │   │   ├── session-bus.ts                          # 会话总线：会话间消息通道的编排实现
    │   │   │   ├── session-role.test.ts                    # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── session-store.dsh.integration.test.ts   # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── session-store.test.ts                   # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   └── session-store.ts                        # 会话编排核心：经 BaseBackend 接口驱动会话生命周期
    │   │   ├── skills/                                     # 多内核技能聚合：合并 pi/dsh 两侧的 SkillProvider
    │   │   │   ├── bundled-skills.ts                       # 内置技能镜像：仓库内置 skill 同步到数据根
    │   │   │   └── skill-aggregator.ts                     # 技能聚合：合并多内核 SkillProvider 成统一清单
    │   │   └── theme/                                      # 主题合并与对比度审计：服务端构建主题并做 WCAG 审计
    │   │       ├── contrast.ts                             # 对比度审计：WCAG AA 对比度计算与诊断报告
    │   │       └── merge.ts                                # 主题合并：把主题贡献与字体预设合并成完整主题
    │   ├── bootstrap/                                      # 组装根：最外层，把接口与实现绑定后启动应用
    │   │   ├── host/                                       # 宿主能力实现：electron-host 与 node-host 两套运行时适配
    │   │   │   ├── electron-host.ts                        # Host 的 Electron 实现：生命周期/窗口/对话框/通知
    │   │   │   └── node-host.ts                            # Host 的 Node 降级实现：窗口对话框不支持、通知 no-op
    │   │   ├── kernel/                                     # 内核注册表：kernel-factories/logos/managers 绑接口到实现
    │   │   │   ├── kernel-factories.ts                     # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── kernel-logos.ts                         # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   └── kernel-managers.ts                      # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── assemble.ts                                 # 共享组装：零 electron，建 stores/ctx/gateway/起服务器
    │   │   ├── electron.ts                                 # Electron 入口：调 assemble 后开窗并挂 app 生命周期
    │   │   └── server.ts                                   # Node 入口：调 assemble 后绑信号做优雅退出
    │   ├── client/                                         # 其他外部适配器：内核之外的文件系统/git/npm/远程探测
    │   │   ├── fs/                                         # 文件系统读写：目录树、文本文件增删改、同步
    │   │   │   ├── fs-ops.ts                               # 文件操作：文件的读写与增删改等操作
    │   │   │   ├── fs-sync.ts                              # 文件同步：项目文件的同步逻辑实现
    │   │   │   ├── fs-tree.test.ts                         # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   └── fs-tree.ts                              # 目录树：项目目录树的构建与遍历
    │   │   ├── git/                                        # Git 读写：只读状态查询 + 收敛写面 commit/push
    │   │   │   ├── git-status.ts                           # Git 只读状态：仓库状态的只读查询
    │   │   │   └── git-write.ts                            # Git 收敛写面：commit/push
    │   │   ├── npm/                                        # npm 集成：npm install 与 registry 版本查询
    │   │   │   └── kernel-runtime.ts                       # npm 运行时：install + registry
    │   │   ├── remote/                                     # 远程探测：局域网 IP、cloudflared 隧道、二维码生成
    │   │   │   ├── cloudflared-download.ts                 # cloudflared 下载：镜像下载二进制
    │   │   │   ├── cloudflared.ts                          # cloudflared 隧道：spawn 与解析
    │   │   │   ├── lan-ip.ts                               # 局域网 IPv4 探测：取本机地址
    │   │   │   └── qr.ts                                   # 二维码生成：URL 转 data URL
    │   │   ├── kernel-extension.ts                         # 内核扩展统一入口：五能力的聚合声明
    │   │   ├── paths.ts                                    # 数据根单源：打包态 ~/.my-harness-desktop 与 dev 态分流
    │   │   └── skill-frontmatter.ts                        # skill frontmatter 解析：读取技能文件的元信息
    │   ├── controllers/                                    # controller 层：14 个 channel 域，解包 wire 参数后委托 application
    │   │   ├── app-info.ts                                 # app:info/restart 控制器：经 conn.host.app 暴露应用信息
    │   │   ├── appearance.ts                               # 外观控制器：i18n 资源、主题构建、settings 槽清单
    │   │   ├── bus.ts                                      # 会话总线控制器：转发 bus:event 事件通道
    │   │   ├── config.ts                                   # 插件配置控制器：config 通道的读写入口
    │   │   ├── extensions.ts                               # 内核扩展控制器：enable/disable/install/uninstall
    │   │   ├── fs-git.ts                                   # 文件与 git 控制器：文件系统与 git 读写通道
    │   │   ├── kernel.ts                                   # 内核版本控制器：status/install/listVersions 管理
    │   │   ├── notification.ts                             # 通知控制器：经 conn.host.notify 发系统通知
    │   │   ├── plugins.ts                                  # 壳插件控制器：插件 list/enable/disable/install
    │   │   ├── remote.ts                                   # remote 控制器：远程访问控制面 status/start/stop/tunnel
    │   │   ├── sessions.ts                                 # 会话控制器：48 个 session 通道，最厚的 controller
    │   │   ├── skills.ts                                   # 技能控制器：list/getCapabilities/setEnabled 通道
    │   │   ├── slots-dialog.ts                             # 槽位与对话框控制器：槽位清单 + 系统对话框
    │   │   └── window.ts                                   # 窗口控制器：经 conn.host.window 做窗口操作
    │   ├── kernel/                                         # 内核域：抽象基类 + pi/dsh 两个同级内核实现
    │   │   ├── dsh/                                        # dsh 内核全部：json-rpc + DshBackend + 安装器 + warmup 等内聚一处
    │   │   │   ├── dsh-extension/                          # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   │   ├── extension.json                      # 扩展清单：内核扩展的声明文件
    │   │   │   │   └── index.mjs                           # dsh 扩展入口：可执行入口
    │   │   │   ├── dsh-backend.integration.test.ts         # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── dsh-backend.test.ts                     # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── dsh-backend.ts                          # DshBackend：JSON-RPC 后端
    │   │   │   ├── dsh-catalog.ts                          # DshSessionCatalog：会话目录
    │   │   │   ├── dsh-config-source.test.ts               # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── dsh-config-source.ts                    # 配置源：cordis.yml + settings.yaml
    │   │   │   ├── dsh-event-translator.test.ts            # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── dsh-event-translator.ts                 # dsh 事件翻译：转为中性事件
    │   │   │   ├── dsh-extension-installer.test.ts         # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── dsh-extension-installer.ts              # 扩展安装：内核扩展的安装器实现
    │   │   │   ├── dsh-extension-manager.ts                # 扩展管理：内核扩展的状态管理
    │   │   │   ├── dsh-extension-manifest.ts               # 扩展清单：内核扩展清单的类型定义
    │   │   │   ├── dsh-kernel-api.test.ts                  # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── dsh-kernel-api.ts                       # dsh 内核 API：内核接口
    │   │   │   ├── dsh-kernel-config.ts                    # dsh 内核配置：dsh 内核的配置读写
    │   │   │   ├── dsh-kernel.ts                           # DshKernelManager：版本管理
    │   │   │   ├── dsh-logo.ts                             # dsh logo：dsh 内核的图标资源
    │   │   │   ├── dsh-methods.ts                          # dsh 方法枚举：方法名常量
    │   │   │   ├── dsh-question-bridge.ts                  # 提问桥接：dsh 提问能力的桥接通道
    │   │   │   ├── dsh-skill-provider.ts                   # 技能提供：dsh 内核的技能发现与提供
    │   │   │   ├── dsh-warmup.ts                           # warmup：内核的启动预热逻辑
    │   │   │   ├── json-rpc.test.ts                        # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── json-rpc.ts                             # JSON-RPC：行传输实现
    │   │   │   └── subprocess-lifecycle.ts                 # 子进程生命周期：内核子进程的启停管理
    │   │   ├── pi/                                         # pi 内核全部：协议 + PiBackend + 安装器 + warmup 等内聚一处
    │   │   │   ├── commands.ts                             # pi 命令构造纯函数：拼装内核命令
    │   │   │   ├── context-binding.test.ts                 # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── context-binding.ts                      # RPC 上下文绑定：映射到 domain 类型
    │   │   │   ├── correlator.ts                           # 事件关联：pi 事件的配对与关联
    │   │   │   ├── event-translator.ts                     # pi 事件翻译：转为中性事件
    │   │   │   ├── known-tools.ts                          # 已知工具：pi 已知工具的清单
    │   │   │   ├── models-config.ts                        # 模型配置：models.json 读写
    │   │   │   ├── models-store.ts                         # 模型存储：pi 模型清单的存储读写
    │   │   │   ├── my-harness-fit-pi-extension-installer.ts  # 五能力安装：统一安装 pi 内置的五能力扩展
    │   │   │   ├── patch-rpc-mode.ts                       # rpc 模式补丁：pi 的 rpc 模式修正
    │   │   │   ├── pi-backend-extensions.ts                # pi 扩展面：pi 扩展能力的类型定义
    │   │   │   ├── pi-backend.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── pi-backend.ts                           # PiBackend：JSONL 后端实现
    │   │   │   ├── pi-bundled-skills.ts                    # 内置技能：pi 内置 skill 同步
    │   │   │   ├── pi-catalog.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
    │   │   │   ├── pi-catalog.ts                           # PiSessionCatalog：会话目录
    │   │   │   ├── pi-cli.ts                               # pi cli：可执行路径与调用
    │   │   │   ├── pi-extension-installer.ts               # 扩展安装：插件的私货扩展安装
    │   │   │   ├── pi-extension-manager.ts                 # 扩展管理：pi 扩展的状态管理
    │   │   │   ├── pi-kernel-api.ts                        # pi 内核 API：内核接口
    │   │   │   ├── pi-kernel-config.ts                     # pi 内核配置：pi 内核的配置读写
    │   │   │   ├── pi-kernel.ts                            # PiKernelManager：版本管理
    │   │   │   ├── pi-logo.ts                              # pi logo：pi 内核的图标资源
    │   │   │   ├── pi-model-source.ts                      # 模型源：pi 模型清单的来源提供
    │   │   │   ├── pi-oneshot.ts                           # 一次性调用：pi 的单次运行入口
    │   │   │   ├── pi-settings-store.ts                    # pi 设置存储：settings.json 读写
    │   │   │   ├── pi-skill-provider.ts                    # 技能提供：pi 内核的技能发现与提供
    │   │   │   ├── pi-warmup.ts                            # warmup：内核的启动预热逻辑
    │   │   │   ├── resync.ts                               # 重同步：pi 状态的重新同步
    │   │   │   ├── rpc-adapter.ts                          # rpc 适配器：JSONL 读写与配对
    │   │   │   ├── rpc-types.ts                            # pi 消息类型：RPC 类型定义
    │   │   │   ├── subprocess-handle.ts                    # 子进程句柄：内核子进程的句柄引用
    │   │   │   ├── subprocess-lifecycle.ts                 # 子进程生命周期：内核子进程的启停管理
    │   │   │   └── versions.ts                             # 协议版本：pi 协议版本常量
    │   │   ├── abstract-backend.ts                         # AbstractBackend 抽象基类：15 抽象方法 + 4 缺面默认
    │   │   ├── kernel-manager.install.test.ts              # 单元测试：验证对应模块的正确行为与边界条件
    │   │   ├── kernel-manager.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
    │   │   ├── kernel-manager.ts                           # KernelManager 基类：内核装/查/状态合成通用机制
    │   │   └── kernel-runtime.ts                           # KernelRuntime 接口：npm install 与 registry 查询抽象
    │   ├── remote/                                         # web 鉴权：auth/token/password/rate-limiter/remote-config 远程访问安全
    │   │   ├── auth.test.ts                                # 单元测试：验证对应模块的正确行为与边界条件
    │   │   ├── auth.ts                                     # RemoteAuth：复合 verifyToken + 密码校验 + 远程 token 签发
    │   │   ├── password.test.ts                            # 单元测试：验证对应模块的正确行为与边界条件
    │   │   ├── password.ts                                 # 密码哈希：scrypt 加盐哈希与常量时间比较
    │   │   ├── rate-limiter.ts                             # 失败限速器：同 key 5 错锁 60 秒，成功清零
    │   │   ├── remote-config.ts                            # remote.json 读写：远程访问开关/绑定/密码 hash 持久化
    │   │   ├── token.test.ts                               # 单元测试：验证对应模块的正确行为与边界条件
    │   │   └── token.ts                                    # HMAC token：base64url(payload)+hmac 签名的签发与校验
    │   ├── routing/                                        # channel 路由：传输无关的 gateway 编排，负责分发与广播
    │   │   ├── gateway.test.ts                             # 单元测试：验证对应模块的正确行为与边界条件
    │   │   └── gateway.ts                                  # 网关：register/dispatch/broadcast/authenticate 四原语
    │   ├── transport/                                      # 传输层：HTTP 与 WebSocket 两个服务，物理拆开
    │   │   ├── http/                                       # HTTP 服务：静态托管 + /login /logout + /status.json
    │   │   │   └── http-server.ts                          # HTTP 服务：静态托管 + 登录登出 + 健康状态接口
    │   │   └── ws/                                         # WS 服务：/rpc 升级 + hello/cookie 鉴权 + 帧解析
    │   │       ├── ws-server.test.ts                       # 单元测试：验证对应模块的正确行为与边界条件
    │   │       └── ws-server.ts                            # WS 服务：/rpc 升级 + hello/cookie 鉴权 + 帧分发
    │   ├── broadcast.ts                                    # 广播工具：broadcastSettingsChanged 统一广播设置变更
    │   └── main-context.ts                                 # MainContext 依赖契约 + Prefs + DEFAULT_PREFS 默认值定义
    └── web/                                                # 前端：跑在浏览器侧的 React 渲染与交互逻辑
        ├── components/                                     # 槽壳组件：标题栏/侧栏/布局引擎/设置页等
        │   ├── layout-engine.tsx                           # 布局引擎：拖拽分栏的布局管理与持久化
        │   ├── right-panel.tsx                             # 右侧面板：sidePanel 槽的容器组件
        │   ├── settings-page.tsx                           # 设置页容器：settings 槽的整页覆盖层
        │   ├── sidebar.tsx                                 # 左侧栏：sidebar 槽的容器组件
        │   └── titlebar.tsx                                # 标题栏：自绘无边框窗口的拖拽区与按钮
        ├── kernel/                                         # window.kernel 构建：把 transport 包装成 KernelApi
        │   └── build-kernel.ts                             # window.kernel 构建：机械迁移 preload 的 kernel 对象
        ├── stores/                                         # 运行时 store：ui/session/layout 等前端状态
        │   ├── general-config.ts                           # 通用配置 store：debugMode 等桌面偏好
        │   ├── kernel-logos.ts                             # 内核 logo store：各内核图标的缓存
        │   ├── layout-store.test.ts                        # 单元测试：验证对应模块的正确行为与边界条件
        │   ├── layout-store.ts                             # 布局 store：分栏布局的前端状态
        │   ├── session-store.image.test.ts                 # 单元测试：验证对应模块的正确行为与边界条件
        │   ├── session-store.test.ts                       # 单元测试：验证对应模块的正确行为与边界条件
        │   ├── session-store.ts                            # 会话 store：前端会话列表与状态
        │   └── ui-store.ts                                 # UI store：activeView 等界面状态
        ├── transport/                                      # 客户端 WS 传输：invoke/on/off 三原语 + 连接期缓冲
        │   ├── ws-transport.test.ts                        # 单元测试：验证对应模块的正确行为与边界条件
        │   └── ws-transport.ts                             # WS 传输三原语：invoke 配对 result、on/off 订阅 push
        ├── ui/                                             # 通用 UI：button/chat-row 等基础组件
        │   ├── button.tsx                                  # 通用按钮：壳插件统一的按钮基础组件
        │   └── chat-row.tsx                                # 聊天行：消息流的一行渲染基础组件
        ├── event-bus.test.ts                               # 单元测试：验证对应模块的正确行为与边界条件
        ├── i18n-init.ts                                    # i18n 初始化：初始化 i18next 并订阅语言切换
        ├── index.css                                       # 入口样式：全局样式与 CSS 变量定义
        ├── index.html                                      # Vite 入口 html：前端页面挂载点
        ├── index.tsx                                       # React 入口：初始化 wsTransport + buildKernel 后挂载应用
        ├── plugins-host.ts                                 # 插件宿主：把插件贡献挂到槽位并注入 PluginContext
        ├── theme-context.tsx                               # 主题上下文：主题的加载与切换 React Context
        └── ui-store.ts                                     # UI store：activeView 等界面状态管理
```

#                                                           # packages/，实现见源码

```text

└── packages/                                               # 子目录：按域组织该功能块的源码与资源文件
    ├── my-harness-fit-pi-extension/                        # pi 内核桌面适配扩展：toolgate/context-probe/bus/subagent/skills 五能力合一
    │   ├── skills/                                         # 子目录：按域组织该功能块的源码与资源文件
    │   │   ├── chatroom-collab.md                          # Markdown 文档：说明文档或技能/设计文档
    │   │   ├── delegate-task.md                            # Markdown 文档：说明文档或技能/设计文档
    │   │   ├── orchestrate.md                              # Markdown 文档：说明文档或技能/设计文档
    │   │   ├── parallel-fanout.md                          # Markdown 文档：说明文档或技能/设计文档
    │   │   └── supervise-worker.md                         # Markdown 文档：说明文档或技能/设计文档
    │   ├── tools/                                          # 子目录：按域组织该功能块的源码与资源文件
    │   │   ├── abort-subagent.ts                           # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── bus-status.ts                               # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── channel-member.ts                           # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── list-subagents.ts                           # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── send-to-subagent.ts                         # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── session-abort.ts                            # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── session-create.ts                           # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── spawn-subagent.ts                           # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── tap-start.ts                                # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── tap-stop.ts                                 # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   └── wait-subagent.ts                            # TypeScript 模块：该功能块的逻辑与工具函数
    │   ├── bus.ts                                          # TypeScript 模块：该功能块的逻辑与工具函数
    │   ├── context-probe.ts                                # TypeScript 模块：该功能块的逻辑与工具函数
    │   ├── index.ts                                        # TypeScript 模块：该功能块的逻辑与工具函数
    │   ├── runtime.ts                                      # TypeScript 模块：该功能块的逻辑与工具函数
    │   ├── scanner.ts                                      # TypeScript 模块：该功能块的逻辑与工具函数
    │   ├── skills.ts                                       # TypeScript 模块：该功能块的逻辑与工具函数
    │   ├── subagent.ts                                     # TypeScript 模块：该功能块的逻辑与工具函数
    │   └── toolgate.ts                                     # TypeScript 模块：该功能块的逻辑与工具函数
    ├── react/                                              # React 发布面：组件、hooks、事件总线、stores 与 KernelApi
    │   ├── src/                                            # 子目录：按域组织该功能块的源码与资源文件
    │   │   ├── manager/                                    # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── kernel-config-form.tsx                  # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── kernel-version-page.tsx                 # React 组件：该功能块的界面渲染与交互
    │   │   │   └── model-config-page.tsx                   # React 组件：该功能块的界面渲染与交互
    │   │   ├── panel/                                      # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── index.ts                                # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── panel-card.tsx                          # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── panel-icon-button.tsx                   # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── panel-row.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── panel-search-input.tsx                  # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── panel-section-title.tsx                 # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── panel-stat-row.tsx                      # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── panel-tabs.tsx                          # React 组件：该功能块的界面渲染与交互
    │   │   │   └── panel-toolbar.tsx                       # React 组件：该功能块的界面渲染与交互
    │   │   ├── widgets/                                    # 子目录：按域组织该功能块的源码与资源文件
    │   │   │   ├── button.tsx                              # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── context-menu.tsx                        # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── control-geometry.ts                     # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   │   ├── empty-state.tsx                         # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── file-tree.css                           # 样式文件：定义该模块的视觉样式与布局
    │   │   │   ├── file-tree.tsx                           # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── kernel-logo.tsx                         # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── pagination.tsx                          # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── plugin-icon.tsx                         # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── section.tsx                             # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── select.tsx                              # React 组件：该功能块的界面渲染与交互
    │   │   │   ├── sortable-list.tsx                       # React 组件：该功能块的界面渲染与交互
    │   │   │   └── toast.tsx                               # React 组件：该功能块的界面渲染与交互
    │   │   ├── aux-block-parsers.ts                        # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── block-renderers.ts                          # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── code-block-renderers.ts                     # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── composer-actions.ts                         # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── composer-attachments.ts                     # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── composer-policies.ts                        # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── composer-stats.ts                           # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── error-boundary.tsx                          # React 组件：该功能块的界面渲染与交互
    │   │   ├── event-bus.ts                                # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── file-actions.ts                             # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── file-icons.ts                               # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── index.ts                                    # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── inline-confirm.tsx                          # React 组件：该功能块的界面渲染与交互
    │   │   ├── kernel-extensions-page.tsx                  # React 组件：该功能块的界面渲染与交互
    │   │   ├── list-item.tsx                               # React 组件：该功能块的界面渲染与交互
    │   │   ├── message-actions.ts                          # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── plugin-context.ts                           # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── plugin-id-context.ts                        # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── plugin-modules.ts                           # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── plugin-overlays.tsx                         # React 组件：该功能块的界面渲染与交互
    │   │   ├── session-groupings.ts                        # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   ├── settings-groups.ts                          # TypeScript 模块：该功能块的逻辑与工具函数
    │   │   └── settings-section.tsx                        # React 组件：该功能块的界面渲染与交互
    │   └── package.json                                    # JSON 数据：结构化配置或资源清单
    └── shared/                                             # 圆心 workspace 包 @my-harness-desktop/shared：前后端共用的纯契约，零依赖
        ├── src/                                            # 圆心源码：domain/channel/wire 三块
        │   ├── channel/                                    # 通道契约：channel-contract 与 channel-meta
        │   │   ├── channel-contract.ts                     # 通道树：所有合法 channel 名
        │   │   └── channel-meta.ts                         # 通道元数据：channel 元信息
        │   ├── domain/                                     # 纯类型：backend/kernel/host/remote 等契约
        │   │   ├── events/                                 # 子目录：按域组织该功能块的源码与资源文件
        │   │   │   ├── kernel-event.ts                     # 内核事件类型：内核投喂的中性事件定义
        │   │   │   ├── session-bus.ts                      # 会话总线类型：会话总线消息的类型定义
        │   │   │   ├── session-state.test.ts               # 单元测试：验证对应模块的正确行为与边界条件
        │   │   │   └── session-state.ts                    # 会话状态类型：会话状态投影的类型定义
        │   │   ├── slots/                                  # 子目录：按域组织该功能块的源码与资源文件
        │   │   │   └── theme-tokens.ts                     # 主题 token 契约：配色 token
        │   │   ├── aux-blocks.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
        │   │   ├── aux-blocks.ts                           # 辅助块契约：辅助块的解析契约定义
        │   │   ├── backend.test.ts                         # 单元测试：验证对应模块的正确行为与边界条件
        │   │   ├── backend.ts                              # BaseBackend 中立契约：壳向内核索取的最小意图集
        │   │   ├── context.ts                              # 上下文类型：PluginContext/AppInfo 等
        │   │   ├── contributions.ts                        # 槽位贡献：插件往槽位挂载的贡献类型
        │   │   ├── custom-order.ts                         # 自定义排序：列表自定义排序的契约
        │   │   ├── extensions.ts                           # 扩展类型：内核扩展相关的类型定义
        │   │   ├── file-icons.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
        │   │   ├── file-icons.ts                           # 文件图标契约：文件名到图标的映射契约
        │   │   ├── host.ts                                 # Host 接口：六样宿主能力聚合
        │   │   ├── kernel-manager.ts                       # KernelSpec：内核规格纯数据
        │   │   ├── kernel-warmup.ts                        # warmup 契约：预热接口
        │   │   ├── kernel.ts                               # KernelId 单源：pi 与 dsh 身份常量
        │   │   ├── layout.ts                               # 布局类型：布局引擎的中性类型定义
        │   │   ├── path-utils.test.ts                      # 单元测试：验证对应模块的正确行为与边界条件
        │   │   ├── path-utils.ts                           # 路径工具纯函数：路径处理的纯函数工具
        │   │   ├── remote.ts                               # 线协议类型：Invoke/Result/Push/Hello 等
        │   │   ├── restart.ts                              # 重启状态类型：会话重启状态机的类型定义
        │   │   ├── session-neutral.test.ts                 # 单元测试：验证对应模块的正确行为与边界条件
        │   │   ├── session-neutral.ts                      # 中性会话层：lineage 树投影
        │   │   ├── sessions.ts                             # 会话类型：会话信息与操作接口
        │   │   ├── skills.ts                               # 技能契约：技能相关的契约类型定义
        │   │   ├── working-phase.test.ts                   # 单元测试：验证对应模块的正确行为与边界条件
        │   │   └── working-phase.ts                        # 工作阶段：工作阶段的状态类型定义
        │   ├── wire/                                       # 线协议实现：parse/serialize 纯函数
        │   │   └── wire.ts                                 # 线协议 parse/serialize：帧编解码
        │   ├── index.ts                                    # barrel 再导出：圆心唯一发布面
        │   ├── paths.ts                                    # 配置路径常量：GENERAL_CONFIG_PATH 等
        │   └── style-presets.ts                            # 样式预设清单：侧栏/面板风格 ID
        └── package.json                                    # JSON 数据：结构化配置或资源清单
```

