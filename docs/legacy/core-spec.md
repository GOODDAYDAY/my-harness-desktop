# 核心规范 · 运行态（数据目录 · 废弃术语 · 可检验清单）

> **定位**：本文**不是**术语和数据结构的单一真相源——那些以 `docs/design/kernel-design-spec.md` 为准
> （§4 术语表、§8–§13 圆心契约、§21 类层次），并以其分册 `session-neutral-layer.md` 为准
> （会话级中立坐标系）。本文只补两样 `kernel-design-spec.md` 没有集中覆盖的：
> **废弃术语对照表** 和 **运行时数据目录总表**，外加一份可落到 CI 的**可检验清单**。

---

## 1 废弃术语（定名边界）

现行术语单源在 `kernel-design-spec.md` §4（+ CLAUDE.md 高频术语）。此处只列**已被取代、不得再写**的旧口径：

| 废弃 | 原因 | 现行替代 |
|---|---|---|
| **底座**（pi 底座） | 暗示"被管理资源"又暗含"pi 那一套"，两个意思混一词 | **内核**（kernel） |
| 旧"内核" = 壳机制（`docs/DESIGN.md` 口径） | 与"pi/dsh 各是一个内核"冲突 | **壳**（shell） |
| `Anchor = { lineageId, boundary, opaque }`（带 `opaque`） | `opaque` 是内核私有 token，跨内核失效（`8d9a59a` 已去） | `NeutralAnchor = { lineageId, entryId }` |

> ⚠ `docs/DESIGN.md` 仍是旧术语稿（"pi 底座"、"内核"=壳机制），已标历史稿，以 `kernel-design-spec.md` 为准。新代码不得再写"底座"。

---

## 2 运行时数据目录（定址）

### 2.1 桌面数据根（分流）

- 单源：`client/paths.ts` `resolveMyHarnessDesktopDir()`。
- 打包态 `~/.my-harness-desktop`；dev 态 `~/.my-harness-desktop-dev`。
- **逻辑前缀契约**：插件 manifest/renderer 里写的 `~/.my-harness-desktop/...` 是逻辑前缀，
  经 `expandDesktopPath` 映射到当前数据根——契约不变，物理落点随打包态分流。

### 2.2 数据根内的目录树

| 路径（相对数据根） | 内容 | 归属 |
|---|---|---|
| `config/` | `general.json` + electron-store prefs + 全局插件配置 `{pluginId}.json` | 壳配置 |
| `sessions/` | 中立会话存储（`NeutralSessionStore`）+ 会话绑定表（`SessionBindingStore`） | 壳会话层 |
| `pi/` | pi 内核 npm 安装目录（`PI_INSTALL_DIR`） | 内核版本管理 |
| `dsh/` | dsh 内核 npm 安装目录（`DSH_INSTALL_DIR`，含 cordis 插件 node_modules） | 内核版本管理 |
| `plugins/` | 用户级壳插件（`user` tier） | 插件加载器 |
| `installed/` | 已安装壳插件（`installed` tier，经插件管理器装） | 插件加载器 |
| `skills/` | 内置 skills 镜像（受管目录，启动时强制覆盖） | 壳技能层 |
| `stickers/bundled/` | 内置表情包镜像（受管目录） | 壳内容层 |

### 2.3 数据根之外（内核自有标准目录）

| 路径 | 内容 | 说明 |
|---|---|---|
| `~/.pi/agent/` | pi 底座标准目录（**不分流**，两版共享） | 非桌面数据根 |
| `~/.pi/agent/sessions/{bucket}/{ts}_{uuid}.jsonl` | pi 会话文件（JSONL + parentId 树） | pi 会话真相源 |
| `~/.pi/agent/settings.json` | pi 底座 settings（skills[] / packages 开关） | pi-settings 插件读写 |
| `~/.pi/agent/models.json` | pi 模型配置 | ModelsStore 读写 |
| `~/.pi/agent/extensions/` | pi TS 扩展（toolgate/subagent/bus/context-probe） | pi 扩展安装器 |
| `~/.dsh/cordis.yml` | dsh Cordis 配置（插件组成 + base） | `DSH_CORDIS_PATH`，env `DSH_CORDIS_CONFIG` 可覆盖 |
| `~/.dsh/settings.yaml` | dsh 用户覆盖 namespace | 解析链 = schema 默认 → cordis base → 用户分节 |
| `DSH_SESSION_ROOT`（env） | dsh 会话根；ephemeral 时指向临时目录（stop 清理） | dsh 会话真相源 |

### 2.4 项目级（跟 cwd 走）

| 路径 | 内容 |
|---|---|
| `<cwd>/.my-harness-desktop/config/{pluginId}.json` | 项目级插件配置（全局兜底） |
| `<cwd>/.my-harness-desktop/plugins/` | 项目级壳插件（`project` tier；打包态无"当前项目"，降级为另一用户级，M8 演进） |

### 2.5 随壳分发（resources，打包态）

| 路径 | 内容 |
|---|---|
| `resources/my-harness-desktop-builtin` | 内置壳插件（dev 态 = `src/plugins`） |
| `resources/my-harness-desktop-skills` | 内置 skills（dev 态 = `.claude/skills`） |
| `resources/my-harness-desktop-stickers` | 内置表情包（dev 态 = `assets/stickers`） |

### 2.6 路径纪律

1. **路径单源**：每个目录一处定义（`client/paths.ts` 数据根、`bootstrap/index.ts` 各常量），
   application 层不直读 `process.cwd()`/`process.env.HOME`，由 bootstrap 注入。
2. **内核专属路径不进契约**：`cliPath`/`cordisConfig`/`env` 是 spawn 细节，工厂闭包捕获，
   不进 `BackendCreateOptions`。
3. **已知偏离**：`BackendCreateOptions.agentDir` 名义中性、实际 dsh 忽略（pi 泄漏），
   终态应下沉到 `PiFactoryOptions`。

---

## 3 可检验清单

- [ ] 术语以 `kernel-design-spec.md` §4 + CLAUDE.md 为准，"底座"/旧"内核"不再出现（见 §1 废弃表）。
- [ ] 全仓 `"pi" | "dsh"` 字面量只在 `core/domain/kernel.ts` 一处。
- [ ] `core/domain/` 零外部 import；`core/application` 对 `client/` 零非 type-only import。
- [ ] 每个目录一处定义，无散落的 `join(HOME_DIR, ...)` 副本。
- [ ] 壳只认中性事件与 `LineageTree`，不读任何内核存储格式。
