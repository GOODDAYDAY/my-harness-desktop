# 底座进程配置依赖失效机制

## 背景与根因

改模型配置(models.json / settings.json)后无法发起会话:`set_model` 报 `Model not found`,必须重启应用才恢复。

根因(实证验证,2026-08-07):

1. **底座进程的模型快照在 spawn 时一次性加载**(`ModelConfig.load` 是"一次不可变加载",运行中不重读)。
2. 桌面端发起会话**复用存活进程**(`ensureForSend` 的 `if (this.alive) return`),不重新 spawn。
3. 结论:配置写盘后,老进程永远持旧快照 → 每次 `set_model` 失败;杀进程后新 spawn 立即恢复。

验证链路:单独 spawn 的新底座进程 `set_model DeepSeek/deepseek-v4-flash` 成功(probe 实验)↔ 复用老进程失败(应用日志 45 条同类错误)。

## 方案:进程配置依赖失效

进程失效是进程生命周期管理的职责,由管进程的模块(session-store,application 层)内聚承担:

- **spawn 时记录**:SessionProc 带配置依赖快照(`models.json` + `settings.json` 的 mtime)。
- **复用前校验**:`ensureForSend` 复用进程前重读 mtime 对比,任一文件变化(含存在性变化)→ 进程过期。
- **过期即重建**:停旧进程,走既有 `start()` spawn 新进程读新配置。

为什么是这两个文件:底座进程 spawn 时读 `~/.pi/agent/models.json`(模型)与 `~/.pi/agent/settings.json`(默认模型/思考深度),这是底座标准契约。session-store 管底座进程,持有这份依赖清单是职责边界内知识(agentDir 已由 bootstrap 注入)。`models-store.json` 是底座自维护的运行时缓存(桌面端不产生、非用户配置),不纳入。

## 机制形态

```
spawn 时 ──→ SessionProc.configSnapshot = captureConfigSnapshot()
              = [{ path: <agentDir>/models.json, mtimeMs }, { path: <agentDir>/settings.json, mtimeMs }]
              (文件不存在记 mtimeMs: -1,存在性参与比较)

复用前 ──→ ensureForSend:
              if (alive && !isConfigStale(proc)) return;   // 未过期,复用
              if (alive) await stop();                       // 过期,停旧进程
              ... 走既有 start() spawn 新进程读新配置
```

## 改动点(全部在 session-store.ts)

| 改动 | 内容 |
|---|---|
| SessionProc 加字段 | `configSnapshot: ConfigSnapshotEntry[]`(`{ path: string; mtimeMs: number }`) |
| 新增 `captureConfigSnapshot()` | `statSync` 两个文件,mtimeMs 取数,不存在记 `-1` |
| 新增 `isConfigStale(proc)` | 重读快照逐项对比(按 path 匹配),任一 mtimeMs 不同 → true |
| `ensureForSend` 复用分支 | 复用前校验,过期则 stop 后重建 |
| `createProc` 装配后 | `proc.configSnapshot = this.captureConfigSnapshot()` |

## 边界与行为

- **完整覆盖**:桌面端保存、编辑器手改、外部工具、未来任何插件——一切修改来源都经文件 mtime 捕获。
- **不打断**:正在进行的生成不受影响,只在下次发起会话时重建。
- **多会话**:每进程独立快照、独立校验(懒校验天然按会话)。
- **pref flush 覆盖**:`setModel`/`setThinkingLevel` 前置调用走同一 `ensureForSend` 校验点。
- **文件删除**:存在性变化 → 重建进程读空配置(底座对缺失文件的原生行为,不报错)。
- **失败语义**:`stop` 失败静默(进程存活不致命,下次发起再校验);校验只读 stat,无竞态(mtime 单调)。

## 测试

- 单元(session-store.test.ts 既有 FakeAdapter 模式):
  - 进程活且配置未变:复用(spawn 次数不增)。
  - touch models.json → `ensureForSend` → 旧进程 stop + 重建(spawn +1)。
  - touch settings.json → 同样重建。
  - 文件删除/新增(存在性变化)→ 重建。
- 手动:改模型配置 → 发消息 → 进程重建 set_model 成功(断言进程 PID 变化)。

## 不做(YAGNI 标注)

- **保存后立即杀进程**(`onSave` 契约 / `restartAll` 能力):懒校验已覆盖"保存后下次发起生效",且不打断进行中的会话;保存事件驱动只覆盖桌面端一条路径,是多余机制。
- **底座补丁热重载**(`reload_models` RPC):侵入底座 dist,升级要维护,收益不抵成本。
