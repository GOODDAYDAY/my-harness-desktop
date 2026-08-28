# my-harness-desktop 文档集

这是 my-harness-desktop 的完整技术文档集，全部以当前真实代码为准（`packages/shared` 圆心 + `src/server` 壳后端 + `src/web` 前端 + `src/plugins` 50 插件），在 2026 年前后端分离重构之后重写。

## 阅读顺序

文档是一个整体，建议按这个顺序读：

1. **`glossary.md`** — 术语表。先扫一遍，后面所有文档默认你读过这些词的定义。
2. **`core-design.md`** — 核心设计（约 1.5 万字）。整个架构的「统一理论」：圆心、内核抽象、中立层、单线执行器、薄壳、依赖倒置、三分法。这是锚点文档。
3. **`desktop-kernel-pi-dsh.md`** — desktop 与 pi & dsh 的完整说明（约 5 万字）。多内核集成的主文档，逐契约方法对照 pi/dsh 两个实现。
4. **`desktop-understanding.md`** — 我对 desktop 的理解（约 3 万字）。运行态全景：装配链、进程模型、会话生命周期、插件运行时、前后端通信。
5. **按需读深挖文档**：`session-flow.md`（会话流）、`session-mapping.md`（会话标识映射）、`thin-shell.md`（薄壳论证）、`add-new-kernel.md`（新增内核论证）、`directory-structure.md`（目录与设计风格）、`goal.md`（goal 理解）、`sidebar.md`（左栏）、`sidepanel.md`（右栏）、`i18n.md`（i18n 机制）、`new-plugin.md`（新建插件指南）。
6. **查具体插件**：`plugins/<域>/<插件>.md`。

## 文档清单

### 架构层（docs/ 根目录）

| 文档 | 主题 | 字数 |
|---|---|---|
| `core-design.md` | 核心设计：圆心/内核抽象/中立层/单线执行器/薄壳/依赖倒置/三分法 | ~1.5w |
| `desktop-kernel-pi-dsh.md` | desktop + pi & dsh 完整说明，逐契约对照 | ~5w |
| `desktop-understanding.md` | 我对 desktop 的理解（运行态全景） | ~3w |
| `goal.md` | 我对 goal 的理解 | ~3.9w |
| `session-flow.md` | 会话流：一条消息从输入到渲染的完整链路 | ~3.7w |
| `session-mapping.md` | 壳 session ↔ pi/dsh session 映射 | ~2.8w |
| `thin-shell.md` | 薄壳架构论证 | ~2.7w |
| `add-new-kernel.md` | 新增第三个内核：抽象是否合理 | ~2.9w |
| `directory-structure.md` | 项目目录结构与设计风格 | ~4w |
| `sidebar.md` | 左侧栏 | ~1.9w |
| `sidepanel.md` | 右侧栏 | ~2.1w |
| `i18n.md` | i18n 机制 | ~2.7w |
| `new-plugin.md` | 如何新建一个插件 | ~4.2w |
| `glossary.md` | 术语表 | — |

### 插件文档（docs/plugins/<域>/）

按六域组织，每个插件一篇：

- **insight/**：blind-review、llm-recorder、token-stats
- **manager/**：dsh-manager、pi-manager、plugin-manager、skill-manager、theme-manager、tool-manager
- **project/**：file-preview、file-tree、git-review、projects、stickers
- **sessions/**：ask、continue、goal、graphviz、im-graph、markdown、mermaid、message-blocks、puml、retry、review、session-bookmarks、session-colors、session-tree、sessions-list、sub-agent、timeline、voice-input
- **system/**：debug-bar、general-config、goody-hao、i18n、key-hints、keybindings、notifier、read-claude-md、remote-access
- **themes/**：font-presets、theme、theme-chatgpt、theme-everforest、theme-midnight、theme-mocha、theme-new-york、theme-stone、theme-terminal

每篇插件文档都含一节「与其他插件交互」，说明该插件贡献哪些槽位、emit/invoke 哪些 channel、声明哪些 dependsOn，以及和谁发生耦合。

## 关于文档长度

架构文档和「重」插件（timeline、sessions-list、goal、i18n、session-store 相关）写得很详，达到 2–5 万字；「数据型」插件（theme-* 配色方案、font-presets）只有几十行 JSON，写透它们的结构、token 值、merge 管线里的角色、和 theme-manager/i18n 的交互即可，诚实标注为「数据型插件」，不灌水凑字数。

## 与旧文档的关系

旧文档（`docs/design/`、`docs/core/`、`docs/desktop/`、`docs/plugins/*.md` 平铺旧文件、`DESIGN.md`、`core-spec.md`）是前后端分离重构之前写的，引用的还是 `src/core/`+`src/client/`+`api/ipc` 旧路径，已被本套文档取代。它们保留作历史参照（设计文档里的论证仍有价值），但结论一律以当前代码和本套文档为准。
