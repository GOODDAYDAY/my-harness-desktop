# E2E 验证:一键跑通整个服务

`scripts/verify-e2e.mjs` 一条命令完成五件事(即验收口径):

1. **运行整个服务**——拉起 electron(`out/` 构建产物,真实 HOME = 真实 dev profile),等 CDP + WS 链路就绪;
2. **前端页面元素全部存在**——标题栏 / 左栏(`[data-sidebar-style]`)/ 右栏(`[data-sidepanel-style]`)/ 输入框(`[data-timeline-composer]`)逐项验收 + 非黑屏断言;
3. **所有插件全部 load 成功**——`plugins.list` 全量 state 校验(内置 49 个全在册、无非 active、无 renderer 加载失败上报、关键插件点名);
4. **能通过 DOM 交互**——⌘B 切左栏、点击右栏页签、点击输入框键入;
5. **成功发送一个 ping**——composer 键入 `ping` 回车,事件流判 user 消息发出 + 模型回复落屏,全程截图。

## 用法

```bash
npm run build                  # 确保 out/ 是最新(构建产物时间晚于源码即可跳过)
npm run verify:e2e             # 验收构建产物(electron .,renderer 由 8420 静态服务)
node scripts/verify-e2e.mjs --dev   # 验收 dev 态(npm run dev 同款链路:Vite renderer + /rpc 反代)
```

产物在 `/tmp/mhd-verify-<时间戳>/`:

| 文件 | 内容 |
|---|---|
| `report.json` | 全部验收项 PASS/FAIL + 插件事件明细 + ping 事件流 |
| `electron.log` | 主进程 stdout/stderr(内核 spawn / 服务器日志) |
| `01-ui-ready.png` … `05-ping-done.png` | 各阶段截屏 |

退出码 0 = 全部通过。

## 配套静态守卫:候选类覆盖(`verify:classes`)

`scripts/class-coverage.mjs` 是一条**不拉起应用**的静态回归守卫,专治这次
「重构后圆角/直角/宽度失效」的根因类别——`@source` 漂移(1516ebcb 把
`index.css` 移进 `src/web/` 时相对路径未 rebase)会让某棵源码树的 Tailwind
工具类**整批静默漏生成**:构建不报错、类型检查不报错,但圆角/宽度/命中全失效。

它把「源码里出现的每个候选类」与「构建产物 CSS 里实际生成的规则」对账:

```bash
npm run build          # 先出产物
npm run verify:classes # 全覆盖打 ✅;有缺失列出类名并退出码 1
```

- 扫 `src/plugins` + `src/web` + `packages/react/src` 的 `className` 字面量,
  按 Tailwind v4 转义规则构造选择器去产物 CSS 里查;
- 变体(`hover:`/`md:`/`group-hover:`/`data-[…]`)各自按其生成形态匹配;
- 纯内联样式的语义钩子类(`stream-caret`/`laneHead`/`markdown-body` 等)在
  脚本内 `HOOK_CLASSES` 白名单登记并注明理由,新增钩子类需同步登记。

这条守卫与 `verify:e2e` 互补:`verify:classes` 保证「该生成的样式都生成了」
(无需起服务、秒级),`verify:e2e` 保证「运行时真的渲染 + 交互 + 通信跑通」。

## 注意

- 脚本要求 **8420 / 9222 端口空闲**(有实例在跑会拒绝启动,避免误操作用户窗口);
- 必须在**沙箱外**跑:服务要监听 127.0.0.1:8420、前端要走 loopback WS、ping 要访问模型网关——
  Codex workspace-write 沙箱禁 bind/connect(含 loopback),沙箱内跑必失败;
- ping 走兜底模型(`models.getFallbackModel`,清单第一个可用模型,当前 = dsh `us-new/bifrost/tencent/deepseek-v4-pro`),
  冷启动内核 + 模型往返最长等 5 分钟;
- 会在真实 dev profile 的最近项目里新建一条会话(与手动发一条消息同款副作用)。
