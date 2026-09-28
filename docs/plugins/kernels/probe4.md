# probe4 内核插件（开闭原则的实测探针，**不是产品内核**）

> ⚠ 这个插件存在的唯一目的是**把一条口头承诺变成可运行的证据**：
> 「加第四个内核 = 加一个目录（含 `plugin.ts`），壳零改动」
> （`electron.vite.config.ts` 与 `docs/design/kernel-plugin.md` §1 都这么写，但此前从未被实测过）。
>
> 它是 `minimal` 的**整体克隆 + 改名**（`minimal` → `probe4`），没有任何独有功能。
> 产品内核清单只有 pi / dsh；`minimal` 与 `probe4` 都是测试专用插件
> （`test-plugins/**` 不在任何生产扫描根里，见 `docs/design/kernel-plugin.md`）。

## 1 实测结论（r48）

新增 probe4 之后：

| 项 | 结果 |
|---|---|
| 壳机制层改动 | **0 个文件**（`src/web`、`src/server/{application,bootstrap,controllers,kernel/core,transport,routing}`、`packages/{shared,react}/src`；以 probe4 创建时刻为界用 mtime 核过） |
| 圆心改动 | **0**（`KernelId = string`，身份早已去字面量化，`KERNEL_IDS` 已删） |
| 构建 | 自动产出 `out/main/server/kernel/probe4/plugin.js` 与三个 renderer chunk（两侧都是 glob，无白名单） |
| 功能对等 | `minimal-smoke.e2e.mjs --kernel probe4` 与 `--kernel minimal` **跑同一组 24 条判据、双双通过** |
| 本轮为接入它改的文件 | 只有 2 个，且都在验证侧：冒烟剧本参数化、`TEST_KERNEL_IDS` 加一个 id |

24 条判据覆盖：模型合流 / 选模型 / 发送 / echo 回复 / 多轮 append / 会话文件格式（头行 + message 条目 + role）/
中立层 `header.kernel` / 落盘到 `~/.probe4/agent/sessions/` / pi 目录无串台 / ⌘N 新会话 /
重开后历史仍在 / 续跑第三条。

## 2 但"零改动"有一个边界：验证层不是零改动

加 probe4 打红了 4 处，**全是守卫在正确工作**，也全是本文档要记录的代价：

1. `kernel-registry-n.test.ts`：三处写死内核清单的断言（`["pi","dsh","minimal"]`）+ 一张写死三行的卸载矩阵
   → 已改为**从文件系统派生**（`TEST_KERNEL_IDS` / `ALL_KERNEL_IDS`），矩阵现在自动覆盖每一个在场内核，
   比原来写死的三行更强。写死清单守的不是"存在性/卸载语义"，而是"内核恰好三个"——那不是这些用例的不变量。
2. `plugin-doc-coverage.test.ts`：每个壳插件都要有同名文档 → 本文档。
3. `locale-kernel-identity.test.ts`：语言包描述里的「与 pi/dsh 同级」被拦下要求解释
   → 已登记进 LEDGER（对等性陈述，CLAUDE.md §1.4；这正是该守卫的设计意图）。
4. 文档交叉引用门：克隆时 blanket 改名把注释里的 `docs/design/minimal-kernel.md` 也改成了不存在的
   `probe4-kernel.md`，12 处断链 → 已指回 minimal 的那份（probe4 的设计依据就是它）。

**结论**：壳的机制层对"第四个内核"是真正开放的；但**验证层里有若干处把"内核恰好三个"写死了**，
那才是加内核的真实成本所在。这批写死已在本轮改成派生。

## 3 维护约定

- probe4 是 minimal 的**快照克隆**，不跟随 minimal 演进。
- 若它的冒烟红了，先分辨两种原因：**壳新增了按内核名分支的代码**（真缺陷，修壳）
  vs **minimal 改了而克隆体没跟**（重新克隆即可）。
- 不要因为"它只是测试内核"就删掉——删了，§1 那条承诺就又变回口头的了。

## 4 怎么跑

```bash
npm run build
node scripts/demo/minimal-smoke.e2e.mjs --kernel minimal   # 基线
node scripts/demo/minimal-smoke.e2e.mjs --kernel probe4    # 第四内核，同一组判据
```
