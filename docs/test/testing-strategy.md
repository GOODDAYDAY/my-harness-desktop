# pi-desktop 测试方案设计文档

**前置知识**：pi-desktop 是一个基于 Electron 的 AI coding agent 桌面应用，通过六层洋葱架构组织代码。项目根目录的 CLAUDE.md 是架构纪律文档，定义了六条核心原则——依赖只向内（§1.1）、机制与内容分离（§1.2）、契约单源（§1.3）、无特权差异（§1.4）、事件驱动不轮询（§3.6）、根因修复（§3.7）——本文反复引用其条目，每个引用处都有对应的一句话解释。几个核心概念：**pi 底座**是被 pi-desktop 通过 RPC 管理的独立子进程，经 stdin/stdout 收发 JSON Lines 消息；**window.pi** 是 Electron 的 `contextBridge.exposeInMainWorld` 暴露给渲染进程的受控 IPC 桥接对象，插件通过 `usePluginContext` hook 间接消费它；**中性事件/中性消息**是去掉了底座协议细节的结构化数据，由 gateway 层从 pi 原始事件翻译而来；**槽位**是内核预定的插件挂载点（如侧栏 sidebar、侧面板 sidePanel、设置页 settings、主题 themes、语言 languages），插件在 manifest 里声明贡献，内核按槽位契约渲染。**本文的测试章节按 mock 边界划分，不按源码目录划分**——一个纯函数即使源码在 `application/`，只要它零外部依赖、mock 边界和 domain 一致，就归入 Domain 测试章节讨论。

## 0 问题：一个零测试的项目要从哪开始

pi-desktop 的六层洋葱架构已经落地——`domain/` 里有槽位契约和中性事件类型，`gateway/` 里有 RPC 适配和事件翻译，`application/` 里有插件加载器和配置存储，`shell/` 里有 Electron 主进程和 preload 桥接，`plugins/` 里有十几个功能插件，`packages/` 里有 React hooks 和组件发布面。代码行数不少，架构纪律也守住了。

但测试基础设施为零。没有 vitest 配置，没有 jest，没有 playwright，`devDependencies` 里连一个测试框架都没有。`package.json` 的 scripts 只有 `dev`、`build`、`preview`、`start`——没有 `test`。

### 0.1 现状：六层架构代码已落地，测试基础设施为零

这不是一个"测试覆盖率不够"的问题——覆盖率不够意味着有测试框架、有测试文件、只是数量不够。这里是连框架都没有装、第一个测试文件都还没写。所以这份文档不是"怎么提高覆盖率"，而是"从零建立一套和六层架构对齐的测试体系"。

从头建测试体系的好处是：没有技术债。不用迁就一个已经存在的、和架构不对齐的测试风格——可以从第一行测试就按架构分层来写。坏处是：要做的决策多——选什么框架、每层测什么、mock 什么不 mock 什么、CI 怎么跑——每一个都要从头想清楚。这份文档就是把这些决策一次性想透。

### 0.2 目标：建立和架构镜像的测试体系

目标不是"写一堆测试"，而是建立一套**测试纪律**：每层测它该测的东西，mock 它该 mock的东西，不碰别的层该测的。这套纪律的核心是——测试的 mock 边界就是架构的依赖方向边界。domain 测试不 mock 任何东西，因为它零依赖；gateway 测试 mock SubprocessHandle，因为进程管理是 shell 层的职责；application 测试 mock 文件系统，因为 IO 是外层细节；plugin 测试 mock window.pi，因为 IPC 是外部能力；E2E 不 mock 任何东西，因为测的是全链路。

这套纪律不是"建议"，是硬约束——违反它就是架构违规的信号。domain 测试如果需要 mock，说明 domain 依赖了外层，这是 CLAUDE.md §1.1 明令禁止的红线。所以测试不只是验证功能正确性，它还是架构守卫的第二道防线（第一道是物理目录结构）。

### 0.3 不做什么

有些东西不测，不是因为懒，是因为测了反而有害——测错的东西比不测更糟。

- 不测第三方库的内部行为。zustand 的 `set` 会不会触发 re-render 是 zustand 的事，不是 pi-desktop 的事。测的是"组件在 store 变化后是否正确渲染"，不是"zustand 的发布订阅机制是否工作"。
- 不测 CSS 具体值（在 jsdom 里）。jsdom 没有真实渲染引擎，CSS 断言全是空字符串。CSS 的正确性交给 Playwright 视觉回归测试或人工验证。
- 不测实现细节。不访问 React 内部 state，不测"useEffect 被调用了"。测的是"组件挂载后数据加载了没有"，不是"React 的生命周期机制对不对"。
- 不测框架机制本身。Electron 的 IPC 通不通是 Electron 的事——但 E2E 层会覆盖真实 IPC 往返，因为那是 pi-desktop 的集成链路，不是 Electron 本身。

## 1 核心原则：测试是架构的镜像

pi-desktop 的 CLAUDE.md 定了六条核心纪律：依赖只向内、机制与内容分离、契约单源、无特权差异、事件驱动不轮询、根因修复。这六条不只是写代码的纪律——它们也是写测试的纪律。测试方案不是独立于架构的另一套东西，它是架构在测试领域的投影。下面逐条讲清楚每条架构纪律在测试中长什么样。

### 1.1 为什么不能"先写几个测试再说"

最常见的错误起点是"先装个 jest，随便写几个测试跑起来再说"。这样做的问题是：第一个测试的写法会成为后续所有测试的模板。如果第一个测试在 domain 里 mock 了 fs，后面的人会以为 domain 可以 mock fs——这种错误的"先例"一旦立下来，要纠正就得改一堆已有测试，比从头建还难。

正确的起点是先想清楚分层：domain 层的测试长什么样、gateway 层的测试长什么样、plugin 层的测试长什么样。想清楚了，第一行测试就是对的模板。这份文档就是把这个"想清楚"的过程固化下来。

### 1.2 依赖方向决定 mock 边界

CLAUDE.md §1.1 说依赖只向内——外层可以依赖内层，内层绝不依赖外层。这条纪律在测试中的投影是：**mock 边界从外到内逐层收窄**。

- `domain/` 零依赖 → 零 mock。纯函数，输入到输出的映射，不需要任何替身。
- `gateway/` 依赖 domain + 自己的 SubprocessHandle 接口 → mock SubprocessHandle。RPC 适配逻辑是真的，进程管理是假的。
- `application/` 依赖 domain + gateway + fs → mock fs。用例编排逻辑是真的，文件读写是假的。
- `plugins/` 依赖 `window.pi`（IPC）→ mock `window.pi`。组件渲染和交互逻辑是真的，IPC 调用是假的。
- 集成测试：mock 后端数据，前端全真。
- E2E：全真，零 mock。

这条镜像纪律的检查方式很简单：打开任何一个测试文件，看它 mock 了什么。如果 domain 测试 mock 了 fs，就是依赖方向反了——domain 不该碰 fs。如果 plugin 测试 mock 了 React 本身，就是在测假的东西——React 不是外部依赖，它是渲染层本身。

### 1.3 机制与内容分离在测试中的投影

CLAUDE.md §1.2 说内核只有机制，内容全部外挂。在测试中，这条纪律的投影是：**机制层的测试用 mock 隔离外部依赖，内容层的测试用真实渲染验证交互行为——但内容层并非"零 mock"，它 mock 的是能力入口（window.pi），渲染是真的**。

机制部分（domain + gateway + application 的机制代码）是稳定的、不常变的。它的测试用 mock 隔离外部依赖，测的是逻辑正确性——RPC 适配的 id 配对对不对、事件翻译的 type 映射对不对、配置读写的深合并对不对。

内容部分（plugins 里的 UI 组件）是会变的、频繁迭代的。它的测试用真实渲染（jsdom 里的 React 组件），测的是交互行为——用户点击会话项会不会触发 select、修改设置会不会标 dirty、切换主题会不会更新 CSS 变量。但"真实渲染"不等于"零 mock"——插件测试 mock 了 `window.pi`（IPC 能力入口），React 组件本身是真的。这是混合策略：渲染是真的，IPC 是假的。

如果反过来——用真实渲染测机制（太慢、太脆弱），或用 mock 测内容的渲染本身（测的不是真实交互）——都是错的。机制测稳定的东西，内容测变化的东西，各测各的。

### 1.4 契约单源与测试夹具

CLAUDE.md §1.3 说一个概念只有一份定义。在测试中，这条纪律的投影是：**测试夹具的数据结构从圆心类型出发，不在测试里重新定义一份**。

具体做法是：测试用的数据工厂函数 import 圆心的类型定义（如 `SessionInfo`、`ThemeContribution`、`PluginManifest`），按类型生成测试数据。不在测试文件里手写一个"差不多的"对象——两份定义必然从第一天开始漂移。

类型是圆心的，测试数据是外层的。测试数据工厂放在 `test-fixtures/factories/` 下，是外层资产，不进圆心。但它的形状由圆心类型约束——圆心类型改了，测试数据工厂编译就报错，逼着你同步。

### 1.5 事件驱动不轮询：测试里也用 waitFor 不用 sleep

CLAUDE.md §3.6 说用事件驱动替代轮询和固定延迟，固定 sleep 是对时序竞争的赌注。在测试中，这条纪律的投影是：**异步等待用 `waitFor` / `expect.poll`，不用 `waitForTimeout`**。

`waitForTimeout(1000)` 是固定 sleep——赌 1 秒后异步操作一定完成了。赌赢了测试通过，赌输了测试 flaky，而且 flaky 的原因极难复现。正确做法是等条件：`waitFor(() => expect(screen.getByText('loaded')).toBeInTheDocument())`——数据加载完了就过，没加载完就等到超时。等的是事件（DOM 出现了"loaded"文本），不是时间。

Playwright 同理：`expect(page.locator('.loaded')).toBeVisible({ timeout: 5000 })` 等条件，不 `page.waitForTimeout(2000)` 等时间。CLAUDE.md §3.6 的"事件驱动不轮询"原则在测试里的形态就是：等条件不等时间。

## 2 六层测试金字塔

### 2.1 为什么 pi-desktop 的金字塔不是标准形状

标准测试金字塔是"单元测试多、集成测试中、E2E 少"的正三角形。pi-desktop 的金字塔不是这个形状，因为它的架构不是平铺的——它是六层洋葱，每一层的稳定性、变化频率、测试方式都不同。

pi-desktop 的金字塔长这样：domain 层测试数量最多（纯函数，最快，分支多），gateway 和 application 层中等（有 mock 但快），plugin 层代码量最大但覆盖率目标不追求最高（大量 UI 组件，jsdom 跑得快，但组件变化频繁，覆盖核心交互路径即可），integration 层薄（关键路径覆盖），E2E 层最薄（只覆盖核心链路）。这不是标准三角形，是一个"中间凸"的形状——domain 和 plugin 层是两个代码量峰值，但 plugin 的覆盖率目标比 domain 低（§2.3 详述），因为 UI 组件变化频率高，过度追求覆盖率会变成维护负担。

为什么不把 gateway/application 测得和 domain 一样多？因为它们的逻辑量比 domain 少——domain 有所有类型定义和纯函数（`sessionEntryToNeutral` 这种映射逻辑就很复杂），gateway 主要是翻译和配对（逻辑量小但关键），application 主要是编排（加载器、配置读写，逻辑量中等）。测试数量跟着逻辑量走，不跟着目录数量走。

### 2.2 六层一览：测什么、工具、mock 什么

| 层 | 测什么 | 工具 | mock 什么 | 不 mock 什么 |
|---|---|---|---|---|
| Domain | 纯函数、类型映射、合并逻辑 | Vitest | **什么都不 mock** | 全不 mock |
| Gateway | RPC 适配、事件翻译、id 配对 | Vitest | SubprocessHandle 接口 | RPC 逻辑、翻译逻辑 |
| Application | 加载器、配置读写、会话扫描 | Vitest + memfs | 文件系统 | 编排逻辑、合并逻辑 |
| Plugin | 组件渲染、交互行为、store 流转 | Vitest + Testing Library | window.pi | React 渲染、组件逻辑 |
| Integration | 多组件协作、CSS、跨插件流转 | Playwright | window.pi 后端 | 真实浏览器事件、CSS |
| E2E | preload、IPC 往返、子进程生命周期 | Playwright _electron | **什么都不 mock** | 全链路 |

这张表是整个测试方案的核心。后面六节（§3–§8）逐层展开，但核心就是这张表。记住一个判据：mock 什么取决于这层依赖什么外部——domain 不依赖外部所以不 mock，gateway 依赖子进程所以 mock SubprocessHandle，application 依赖文件系统所以 mock fs，plugin 依赖 IPC 所以 mock window.pi，E2E 不依赖任何 mock 因为它测的就是全链路。

### 2.3 覆盖率按层稳定性分配，不是均权

不是所有层都要追求高覆盖率。按层的稳定性定覆盖率目标：

- `domain/` 目标 95%+。最稳定、最重要、最容易测（纯函数），没有理由不覆盖。`sessionEntryToNeutral` 这种函数有七八种分支（message、custom_message、model_change、compaction、label、custom、session、unknown），每个分支都要测到。
- `gateway/` 目标 90%+。协议翻译逻辑关键，bug 直接导致通信失败。`translateEvent` 的 type 映射表、`RpcAdapter` 的 JSONL 解析和 id 配对，每个路径都要覆盖。
- `application/` 目标 80%+。编排逻辑中等复杂，部分 IO mock 有成本，但核心逻辑（插件发现、配置深合并、主题解析）要覆盖。
- `plugins/` 目标 70%+。UI 组件变化频繁，过度追求覆盖率不现实。覆盖核心交互路径即可。
- E2E：不追求行覆盖率，追求核心用户路径覆盖。启动 → 加载插件 → 切换会话 → 发消息 → 切换主题——这条路径走通了，就算合格。

覆盖率是参考不是信仰。一个 100% 覆盖率的测试套件如果测的都是实现细节，改一行代码要改十个测试——这种测试是负担不是资产。覆盖率用于发现盲区（哪些代码完全没测到），不用于追求数字。

## 3 Layer 1：Domain 圆心——零 mock 纯函数测试

### 3.1 测什么：纯类型和纯函数

`domain/` 是圆心——零外部依赖，只有类型定义和纯函数。这里测的是业务本质：主题合并的优先级对不对、会话条目到中性消息的映射对不对、事件类型的判别联合是否正确。

domain 层当前有两个值得测的纯函数：

- `sessionEntryToNeutral`（`domain/events/session-state.ts:184`）——把 pi 底座吐出的 JSONL 一行（会话条目）映射成中性消息。它有七八种分支：`message` 型原样透传、`custom_message` 型看 display 字段、`model_change` 映射成分隔线、`compaction` 带 token 数格式化、`label` 映射成书签分隔线、`custom` 和 `session` 型隐藏（返回 null）、未知类型兜底展示。每个分支都是一条测试路径。
- `resolveTheme` / `buildTheme` / `buildCurrentTheme`（`application/theme/merge.ts`——注意：这几个函数在 application 层，但它们的输入输出是 domain 类型，测试的 mock 边界和 domain 一致：零外部依赖）。`resolveTheme` 做递归 base 继承 + 环检测，`buildTheme` 在失败时回退默认值，`buildCurrentTheme` 组合字号倍率和字体选择。

### 3.2 工具：Vitest 零配置起步

```bash
npm install -D vitest @vitest/coverage-v8
```

Vitest 是 Vite 原生的测试框架。pi-desktop 已经用了 Vite（`vite` 在 devDependencies 里，electron-vite 基于 Vite），所以 Vitest 的转译管线和项目一致——不需要额外配 Babel、ts-jest，不需要处理 Vite 的 alias 配置在测试里对不上。

配置文件放在项目根目录：

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',  // domain 测试不需要 jsdom，但统一配一个不碍事
    globals: true,
    setupFiles: ['./test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@pi-desktop/core': path.resolve(__dirname, 'packages/core/src'),
      '@pi-desktop/react': path.resolve(__dirname, 'packages/react/src'),
    },
  },
})
```

domain 测试不需要 jsdom——它是纯函数，不碰 DOM。但统一配 `environment: 'jsdom'` 不碍事，省得分文件配不同 environment。后续 plugin 层测试需要 jsdom，统一配省心。

### 3.3 代码示例：会话条目映射

`sessionEntryToNeutral` 是 domain 层最值得测的函数——分支多、边界多、每种映射都有微妙的行为差异。

```ts
// domain/events/session-state.test.ts
import { describe, it, expect } from 'vitest'
import { sessionEntryToNeutral } from './session-state'

describe('sessionEntryToNeutral', () => {
  it('message 型原样透传 message 字段', () => {
    const entry = {
      type: 'message',
      message: { role: 'assistant', content: 'hello', id: 'm1' },
      timestamp: '2024-01-15T10:00:00Z',
    }

    const result = sessionEntryToNeutral(entry)

    expect(result).not.toBeNull()
    expect(result!.role).toBe('assistant')
    expect(result!.content).toBe('hello')
    expect(result!.id).toBe('m1')
    expect(result!.timestamp).toBe(Date.parse('2024-01-15T10:00:00Z'))
  })

  it('custom_message display=false 返回 null（隐藏层）', () => {
    const entry = {
      type: 'custom_message',
      customType: 'plan-mode-state',
      content: '{"plan":"..."}',
      display: false,
    }

    expect(sessionEntryToNeutral(entry)).toBeNull()
  })

  it('custom_message display 未设或 true 时展示，role 取 customType', () => {
    const entry = {
      type: 'custom_message',
      customType: 'approval-request',
      content: '请批准执行此命令',
    }

    const result = sessionEntryToNeutral(entry)!

    expect(result.role).toBe('approval-request')
    expect(result.content).toBe('请批准执行此命令')
  })

  it('model_change 映射成 divider，文本含 provider/modelId', () => {
    const entry = {
      type: 'model_change',
      provider: 'anthropic',
      modelId: 'claude-3-opus',
    }

    const result = sessionEntryToNeutral(entry)!

    expect(result.role).toBe('divider')
    expect(result.kind).toBe('model')
    expect(result.content).toContain('anthropic')
    expect(result.content).toContain('claude-3-opus')
  })

  it('compaction 带 token 数格式化（12345 → 12.3k）', () => {
    const entry = {
      type: 'compaction',
      tokensBefore: 12345,
      summary: '对话已压缩',
    }

    const result = sessionEntryToNeutral(entry)!

    expect(result.kind).toBe('compaction')
    expect(result.content).toContain('12.3k')
    expect(result.detail).toBe('对话已压缩')
  })

  it('label 型映射成书签分隔线', () => {
    const entry = { type: 'label', label: '重要节点' }

    const result = sessionEntryToNeutral(entry)!

    expect(result.role).toBe('divider')
    expect(result.kind).toBe('label')
    expect(result.content).toContain('重要节点')
  })

  it('custom 和 session 型隐藏（返回 null）', () => {
    expect(sessionEntryToNeutral({ type: 'custom', data: '...' })).toBeNull()
    expect(sessionEntryToNeutral({ type: 'session', name: 'test' })).toBeNull()
  })

  it('未知类型兜底：展示类型名 + 原始 JSON（截断 2000 字符）', () => {
    const entry = { type: 'future_event_type', data: 'something' }

    const result = sessionEntryToNeutral(entry)!

    expect(result.role).toBe('divider')
    expect(result.kind).toBe('entry')
    expect(result.content).toBe('future_event_type')
    expect(result.detail).toContain('future_event_type')  // 原始 JSON
  })

  it('null 或非对象输入返回 null', () => {
    expect(sessionEntryToNeutral(null)).toBeNull()
    expect(sessionEntryToNeutral('string')).toBeNull()
    expect(sessionEntryToNeutral(undefined)).toBeNull()
  })

  it('session_info 有 name 时展示重命名分隔线，无 name 时隐藏', () => {
    expect(sessionEntryToNeutral({ type: 'session_info', name: '新名字' })!.content)
      .toContain('新名字')
    expect(sessionEntryToNeutral({ type: 'session_info', name: '' })).toBeNull()
    expect(sessionEntryToNeutral({ type: 'session_info' })).toBeNull()
  })
})
```

主题合并的测试类似——`resolveTheme` 做递归继承，要测正常继承、环检测、base 不存在、token 覆盖优先级：

```ts
// application/theme/merge.test.ts
import { describe, it, expect } from 'vitest'
import { resolveTheme, buildTheme, buildCurrentTheme } from './merge'
import type { ThemeContribution } from '@/domain/contributions'

const registry: Record<string, ThemeContribution> = {
  dark: { id: 'dark', name: 'Dark', tokens: { 'color.bg': '#1e1e2e', 'color.text': '#cdd6f4' } },
  'dark-blue': { id: 'dark-blue', name: 'Dark Blue', base: 'dark', tokens: { 'color.bg': '#0d1b2a' } },
}

describe('resolveTheme', () => {
  it('递归继承 base 的 token', () => {
    const theme = resolveTheme('dark-blue', registry)
    expect(theme['color.bg']).toBe('#0d1b2a')     // 自身覆盖
    expect(theme['color.text']).toBe('#cdd6f4')  // 从 base 继承
  })

  it('环检测抛错', () => {
    const cyclic: Record<string, ThemeContribution> = {
      a: { id: 'a', name: 'A', base: 'b', tokens: {} },
      b: { id: 'b', name: 'B', base: 'a', tokens: {} },
    }
    expect(() => resolveTheme('a', cyclic)).toThrow(/循环继承/)
  })

  it('主题不存在抛错', () => {
    expect(() => resolveTheme('nonexistent', registry)).toThrow(/主题不存在/)
  })

  it('派生 token 被剥离（插件显式赋值忽略）', () => {
    const reg: Record<string, ThemeContribution> = {
      t: { id: 't', name: 'T', tokens: { 'color.bg': '#000', 'border.color': '#fff' } },
    }
    const theme = resolveTheme('t', reg)
    expect(theme['color.bg']).toBe('#000')
    expect(theme['border.color']).toBeUndefined()  // 派生 token 被剥离
  })
})

describe('buildTheme', () => {
  it('解析失败回退默认值', () => {
    const theme = buildTheme('nonexistent', registry)
    expect(theme).toBeDefined()
    expect(Object.keys(theme).length).toBeGreaterThan(0)
  })
})

describe('buildCurrentTheme', () => {
  it('组合字号倍率和字体选择', () => {
    const theme = buildCurrentTheme('dark', registry, 1.5, 'jetbrains', 'sans')
    expect(theme['font.family.mono']).toContain('JetBrains Mono')
    expect(theme['font.family.sans']).toContain('BlinkMacSystemFont')
    // 字号倍率：默认值 × 1.5
    const fontSize = theme['font.size.base']
    if (fontSize) {
      const match = fontSize.match(/^([\d.]+)/)
      if (match) expect(Number(match[1])).toBeGreaterThan(14)  // 放大了
    }
  })
})
```

### 3.4 守卫作用：domain 测试需要 mock 就是架构红线

domain 测试有一个别的层没有的特殊作用：**架构守卫**。

打开 `domain/` 下任何一个测试文件，如果看到 `vi.mock(...)` 或 `vi.fn(...)`，不用看具体内容——这就是架构违规。domain 层零依赖（CLAUDE.md §1.1），不需要任何 mock。需要 mock 说明 domain 碰了外层——fs、electron、react、第三方包——这些都是红线。

这个守卫不需要人盯，CI 可以自动化：grep `domain/` 下所有 `.test.ts` 文件里的 `vi.mock` 调用，有就报错。比 code review 抓违规可靠得多。

### 3.5 坑：别验类型、别碰 Date.now

- **别在 domain 测试里验证类型**。Vitest 只做转译不做类型检查（它用 esbuild 转译 TypeScript，剥离类型）。类型检查靠 `tsc --noEmit` 单独跑，不靠测试框架。如果想在 CI 里卡类型，加一个 `npm run typecheck` 步骤，别指望测试框架做这件事。
- **别碰 `Date.now()` 或 `Math.random()`**。`sessionEntryToNeutral` 里用 `Date.parse(timestamp)` 做时间转换——这个是纯的，给定输入输出确定。但如果某个纯函数依赖 `Date.now()`（比如算"距今多久"），把时间作为参数注入，测试时传固定值。这呼应 CLAUDE.md §3.4 的依赖注入原则。
- **`crypto.randomUUID()` 在测试环境可用**。Node 19+ 和 jsdom 都有 `crypto.randomUUID()`，不需要 polyfill。`session-store.ts` 里用了它生成乐观回显 id，测试时正常跑就行。

## 4 Layer 2：Gateway 协议边界——mock SubprocessHandle 的单元测试

### 4.1 测什么：RPC 适配、事件翻译、id 配对

`gateway/` 做协议翻译：pi 底座经 stdout 吐 JSONL，gateway 翻成 TypeScript 对象。这里测三件事：

- **RPC 适配**（`rpc-adapter.ts`）——发送命令时生成唯一 id 写到 stdin，收到带 id 的 response 按 id 配对 resolve。测的是 id 配对逻辑、JSONL 解析逻辑、进程退出时的错误处理。
- **事件翻译**（`event-translator.ts`）——pi 事件的 `type` 字段（`tool_execution_start`）映射成中性事件的 `type`（`toolCallStart`）。映射表有二十多条，未识别的 type 原样透传。
- **id 配对**（`correlator.ts`）——请求注册、响应匹配、超时拒绝。这是 RPC 的可靠性核心。

gateway 不 spawn 进程——它只消费 `SubprocessHandle` 接口（`subprocess-handle.ts`）。所以测试里 mock 这个接口，验证 gateway 对接口的调用是否正确。这是 CLAUDE.md §3.4 依赖倒置的落地：接口归 gateway 拥有，实现在 shell。

### 4.2 mock 边界：SubprocessHandle 接口

mock 一个东西：`SubprocessHandle`。接口定义在 `gateway/subprocess-handle.ts`，有 `stdin`、`stdout`、`alive`、`stop()`、`onceExit()`、`onceError()`、`onStderr()`。测试里提供假实现——不需要真的 spawn 进程，只需要模拟 stdin.write 被调了、stdout 推了数据进来。

```ts
// gateway/rpc-adapter.test.ts
import { describe, it, expect, vi } from 'vitest'
import { RpcAdapter, RpcProcessError } from './rpc-adapter'
import type { SubprocessHandle, ProcessExit } from './subprocess-handle'

/** 假的子进程句柄——不需要 spawn 进程，只模拟接口行为。 */
function createMockHandle(): SubprocessHandle & {
  _stdoutData: (data: string) => void
  _exit: (exit: ProcessExit) => void
  _error: (err: Error) => void
  _writtenLines: string[]
} {
  const writtenLines: string[] = []
  let stdoutCb: ((chunk: Buffer) => void) | null = null
  let exitCb: ((exit: ProcessExit) => void) | null = null
  let errorCb: ((err: Error) => void) | null = null
  let stderrCb: ((chunk: Buffer) => void) | null = null

  return {
    stdin: { write: vi.fn((line: string) => { writtenLines.push(line) }) } as any,
    stdout: { on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
      if (event === 'data') stdoutCb = cb
    }) } as any,
    alive: true,
    stop: vi.fn(async () => {}),
    onceExit: vi.fn((cb: (exit: ProcessExit) => void) => { exitCb = cb }),
    onceError: vi.fn((cb: (err: Error) => void) => { errorCb = cb }),
    onStderr: vi.fn((cb: (chunk: Buffer) => void) => { stderrCb = cb }),
    _stdoutData: (data: string) => stdoutCb?.(Buffer.from(data)),
    _exit: (exit: ProcessExit) => exitCb?.(exit),
    _error: (err: Error) => errorCb?.(err),
    _writtenLines: writtenLines,
  } as any
}

describe('RpcAdapter', () => {
  it('send 写 JSONL 到 stdin，带唯一 id', async () => {
    const handle = createMockHandle()
    const adapter = new RpcAdapter(handle)
    await adapter.start()

    adapter.send({ method: 'ping', params: { data: 'hello' } })

    expect(handle.stdin!.write).toHaveBeenCalledTimes(1)
    const written = JSON.parse(handle._writtenLines[0])
    expect(written.method).toBe('ping')
    expect(written.params).toEqual({ data: 'hello' })
    expect(written.id).toBe('req1')  // correlator prefix="req"，第一个 id
  })

  it('response 按 id 配对 resolve 对应的 Promise', async () => {
    const handle = createMockHandle()
    const adapter = new RpcAdapter(handle)
    await adapter.start()

    const p1 = adapter.send({ method: 'cmd1', params: {} })
    const p2 = adapter.send({ method: 'cmd2', params: {} })

    // 故意先回复 cmd2 再回复 cmd1——验证配对不依赖顺序
    handle._stdoutData(JSON.stringify({ type: 'response', id: 'req2', result: { ok: 'second' } }) + '\n')
    handle._stdoutData(JSON.stringify({ type: 'response', id: 'req1', result: { ok: 'first' } }) + '\n')

    expect(await p1).toEqual({ ok: 'first' })
    expect(await p2).toEqual({ ok: 'second' })
  })

  it('非 response 的 stdout 行当 event 转发给监听器', async () => {
    const handle = createMockHandle()
    const adapter = new RpcAdapter(handle)
    await adapter.start()

    const events: unknown[] = []
    adapter.onEvent((e) => events.push(e))

    handle._stdoutData(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'tc1' }) + '\n')
    handle._stdoutData(JSON.stringify({ type: 'message_start', message: { role: 'assistant' } }) + '\n')

    expect(events).toHaveLength(2)
    expect((events[0] as any).type).toBe('tool_execution_start')
    expect((events[1] as any).type).toBe('message_start')
  })

  it('进程异常退出时 rejectAll 所有 pending 请求', async () => {
    const handle = createMockHandle()
    const adapter = new RpcAdapter(handle)
    await adapter.start()

    const p = adapter.send({ method: 'long-running', params: {} })
    // 模拟进程崩溃
    handle._exit({ code: 1, signal: null })

    await expect(p).rejects.toThrow(RpcProcessError)
  })

  it('非 JSON 行静默忽略（stderr 混入 stdout 不崩）', async () => {
    const handle = createMockHandle()
    const adapter = new RpcAdapter(handle)
    await adapter.start()

    const events: unknown[] = []
    adapter.onEvent((e) => events.push(e))

    handle._stdoutData('this is not json\n')
    handle._stdoutData(JSON.stringify({ type: 'agent_start' }) + '\n')

    expect(events).toHaveLength(1)  // 只有那行 JSON 被处理
  })
})
```

### 4.3 事件翻译测试

`translateEvent` 是纯函数——输入 pi 事件，输出中性事件。不需要 mock 任何东西，直接测映射表：

```ts
// gateway/event-translator.test.ts
import { describe, it, expect } from 'vitest'
import { translateEvent } from './event-translator'

describe('translateEvent', () => {
  it('tool_execution_start → toolCallStart', () => {
    const result = translateEvent({ type: 'tool_execution_start', toolCallId: 'tc1' })
    expect(result.type).toBe('toolCallStart')
    expect((result as any).toolCallId).toBe('tc1')
  })

  it('message_start → messageStart', () => {
    expect(translateEvent({ type: 'message_start' }).type).toBe('messageStart')
  })

  it('agent_start → agentStart', () => {
    expect(translateEvent({ type: 'agent_start' }).type).toBe('agentStart')
  })

  it('未识别 type 原样透传（兜底）', () => {
    const result = translateEvent({ type: 'some_new_future_event', data: 'x' })
    expect(result.type).toBe('some_new_future_event')
    expect((result as any).data).toBe('x')
  })

  it('字段名保持原名（pi 已用 camelCase）', () => {
    const result = translateEvent({ type: 'tool_execution_end', toolCallId: 'tc1', result: 'done' })
    expect((result as any).toolCallId).toBe('tc1')
    expect((result as any).result).toBe('done')
  })
})
```

### 4.4 JSONL 流式解析的边界测试

`rpc-adapter.ts` 里的 `attachJsonlLineReader` 做的是按 `\n` 切行的流式解析。它有两个边界必须测到：

- **半行分包**：底座一次吐出的数据可能是一行的前半段，下次 data 事件才补全。JSONL reader 必须缓存半行，等下一次数据到达拼成完整行再解析。
- **一次多行**：底座一次吐出的数据可能包含多行 JSON（带多个 `\n`）。reader 必须在一次 data 事件里切出多行，逐行调 onLine。

```ts
describe('JSONL reader: 边界情况', () => {
  it('半行分包：先到半行不处理，补全后处理', async () => {
    const handle = createMockHandle()
    const adapter = new RpcAdapter(handle)
    await adapter.start()

    const events: unknown[] = []
    adapter.onEvent((e) => events.push(e))

    // 先到半行
    handle._stdoutData('{"type":"agent_sta')
    expect(events).toHaveLength(0)  // 不完整，不处理

    // 补全
    handle._stdoutData('rt"}\n')
    expect(events).toHaveLength(1)  // 现在完整了
    expect((events[0] as any).type).toBe('agent_start')
  })

  it('一次多行：一个 data 事件里多行 JSON 逐行处理', async () => {
    const handle = createMockHandle()
    const adapter = new RpcAdapter(handle)
    await adapter.start()

    const events: unknown[] = []
    adapter.onEvent((e) => events.push(e))

    handle._stdoutData(
      JSON.stringify({ type: 'agent_start' }) + '\n' +
      JSON.stringify({ type: 'message_start' }) + '\n' +
      JSON.stringify({ type: 'message_end' }) + '\n'
    )

    expect(events).toHaveLength(3)
  })

  it('空行跳过', async () => {
    const handle = createMockHandle()
    const adapter = new RpcAdapter(handle)
    await adapter.start()

    const events: unknown[] = []
    adapter.onEvent((e) => events.push(e))

    handle._stdoutData('\n\n' + JSON.stringify({ type: 'agent_start' }) + '\n\n')

    expect(events).toHaveLength(1)
  })

  it('\\r\\n 行尾正确处理（去 \\r）', async () => {
    const handle = createMockHandle()
    const adapter = new RpcAdapter(handle)
    await adapter.start()

    const events: unknown[] = []
    adapter.onEvent((e) => events.push(e))

    handle._stdoutData('{"type":"agent_start"}\r\n')

    expect(events).toHaveLength(1)
  })
})
```

### 4.5 坑：别测 spawn、别漏半行分包

- **别测 spawn**。`RpcAdapter` 不负责 spawn 进程——那是 `shell/electron-main/subprocess-lifecycle.ts` 的职责（CLAUDE.md §3.2 构造与执行分开）。如果 gateway 测试在调 `spawn`，说明依赖方向反了。gateway 只消费 `SubprocessHandle` 接口，不管进程怎么来的。
- **别漏半行分包**。这是 JSONL 流式解析最容易出 bug 的地方——底座的 stdout 不保证一次 data 事件就是一行完整 JSON。TCP 缓冲区分包、Node stream 内部缓冲、底座自身的 flush 策略，都可能导致一行被拆成两段到达。不测这个边界，上线后偶发"解析失败"你永远复现不了。
- **`attachJsonlLineReader` 用 LF-only 不用 readline**。`rpc-adapter.ts:196` 的注释说得很清楚：readline 会拆 U+2028/U+2029（JSON 字符串内合法的 Unicode 行分隔符），自写按 `\n` 切不会。测试要覆盖"JSON 字符串值内含 `\n`"的边界——不过这个实际上不会出问题，因为 `JSON.stringify` 会把 `\n` 转义成 `\\n`，不会产生真的换行符。

## 5 Layer 3：Application 用例编排——mock 文件系统的单元测试

### 5.1 测什么：加载器、配置读写、会话扫描

`application/` 做用例编排：插件加载器（发现 → 校验 → 注册）、配置读写（config-store 的读/写/深合并/锁）、会话扫描、主题合并。这些逻辑需要读文件、扫目录，但文件操作是外层细节——mock 掉。

application 层当前值得测的模块：

- `discoverPlugins`（`application/loader/discover.ts:26`）——扫描一个根目录下的插件子目录，读 `plugin.json`，返回 `DiscoveredPlugin[]`。测的是目录扫描逻辑、manifest 解析、损坏 manifest 跳过不崩。
- `ConfigStore`（`application/config/config-store.ts:40`）——插件配置的读/写/合并/删除。测的是用户级和项目级配置的合并、pluginId 白名单校验、写盘失败抛错、缓存失效。
- `resolveTheme` / `buildTheme` / `buildCurrentTheme`——已经在 §3.3 测了，因为它们是纯函数（application 层的纯函数，mock 边界和 domain 一致）。

### 5.2 mock 边界：memfs 替代真实 fs

application 层的 `discoverPlugins` 和 `ConfigStore` 都用 Node 内置 `fs` 模块读文件。测试里用 `memfs` 包替代真实文件系统——在内存里造一个虚拟文件系统，不需要碰真实磁盘。

```bash
npm install -D memfs
```

### 5.3 代码示例：插件发现

`discoverPlugins` 的逻辑简单但边界多：目录不存在返回空数组、非目录跳过、没 `plugin.json` 跳过、`plugin.json` 损坏跳过不崩。

```ts
// application/loader/discover.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Volume, createFsFromVolume } from 'memfs'

describe('discoverPlugins', () => {
  let vol: Volume

  beforeEach(() => {
    vol = new Volume()
    vi.doMock('node:fs', () => createFsFromVolume(vol))
  })

  it('扫描到所有含 plugin.json 的子目录', async () => {
    vol.fromJSON({
      '/plugins/theme-dark/plugin.json': JSON.stringify({
        id: 'theme-dark', version: '1.0.0', renderer: './index.js',
        contributes: { themes: [{ id: 'dark', name: 'Dark', tokens: {} }] },
      }),
      '/plugins/theme-dark/index.js': '',
      '/plugins/sessions-list/plugin.json': JSON.stringify({
        id: 'sessions-list', version: '1.0.0', renderer: './index.js',
        contributes: { sidebar: [{ id: 'sessions', title: '对话', component: 'SessionsList' }] },
      }),
      '/plugins/sessions-list/index.js': '',
    })

    const { discoverPlugins } = await import('./discover')
    const result = discoverPlugins('/plugins', 'builtin')

    expect(result).toHaveLength(2)
    expect(result.map(p => p.manifest.id).sort()).toEqual(['sessions-list', 'theme-dark'])
    expect(result[0].source).toBe('builtin')
  })

  it('目录不存在返回空数组', async () => {
    const { discoverPlugins } = await import('./discover')
    expect(discoverPlugins('/nonexistent', 'builtin')).toEqual([])
  })

  it('跳过没有 plugin.json 的目录', async () => {
    vol.fromJSON({
      '/plugins/good/plugin.json': JSON.stringify({ id: 'good', version: '1.0.0' }),
      '/plugins/good/index.js': '',
      '/plugins/bad/README.md': 'no manifest',
    })

    const { discoverPlugins } = await import('./discover')
    const result = discoverPlugins('/plugins', 'builtin')

    expect(result).toHaveLength(1)
    expect(result[0].manifest.id).toBe('good')
  })

  it('损坏的 plugin.json 跳过不崩', async () => {
    vol.fromJSON({
      '/plugins/valid/plugin.json': JSON.stringify({ id: 'valid', version: '1.0.0' }),
      '/plugins/valid/index.js': '',
      '/plugins/corrupt/plugin.json': '{ invalid json',
    })

    const { discoverPlugins } = await import('./discover')
    const result = discoverPlugins('/plugins', 'builtin')

    expect(result).toHaveLength(1)
    expect(result[0].manifest.id).toBe('valid')
  })

  it('跳过非目录条目', async () => {
    vol.fromJSON({
      '/plugins/some-file.txt': 'not a directory',
      '/plugins/real/plugin.json': JSON.stringify({ id: 'real', version: '1.0.0' }),
      '/plugins/real/index.js': '',
    })

    const { discoverPlugins } = await import('./discover')
    const result = discoverPlugins('/plugins', 'builtin')

    expect(result).toHaveLength(1)
  })
})
```

### 5.4 代码示例：配置存储

`ConfigStore` 的测试覆盖四个方面：读合并（用户级 + 项目级）、写持久化、pluginId 白名单校验、缓存失效。

```ts
// application/config/config-store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Volume, createFsFromVolume } from 'memfs'

describe('ConfigStore', () => {
  let vol: Volume

  beforeEach(() => {
    vol = new Volume()
    vol.fromJSON({
      '/user-data/sessions-list/config.json': JSON.stringify({
        sortBy: 'modified',
        showArchived: false,
      }),
    })
    vi.doMock('node:fs', () => createFsFromVolume(vol))
    vi.doMock('node:fs/promises', () => ({
      ...createFsFromVolume(vol).promises,
      writeFile: createFsFromVolume(vol).promises.writeFile,
    }))
  })

  it('读用户级配置', async () => {
    const { ConfigStore } = await import('./config-store')
    const store = new ConfigStore({ userDir: '/user-data', projectDir: null })

    const config = store.all('sessions-list')
    expect(config.sortBy).toBe('modified')
    expect(config.showArchived).toBe(false)
  })

  it('项目级配置覆盖用户级（同名字段）', async () => {
    vol.fromJSON({
      '/user-data/sessions-list/config.json': JSON.stringify({ sortBy: 'modified', showArchived: false }),
      '/project-data/sessions-list/config.json': JSON.stringify({ sortBy: 'name' }),
    })

    const { ConfigStore } = await import('./config-store')
    const store = new ConfigStore({ userDir: '/user-data', projectDir: '/project-data' })

    const config = store.all('sessions-list')
    expect(config.sortBy).toBe('name')         // 项目级覆盖
    expect(config.showArchived).toBe(false)    // 用户级保留
  })

  it('写入配置后文件内容更新', async () => {
    const { ConfigStore } = await import('./config-store')
    const store = new ConfigStore({ userDir: '/user-data', projectDir: null })

    await store.set('sessions-list', 'sortBy', 'created')

    const raw = JSON.parse(vol.readFileSync('/user-data/sessions-list/config.json', 'utf8'))
    expect(raw.sortBy).toBe('created')
  })

  it('写入时保留未修改的字段', async () => {
    const { ConfigStore } = await import('./config-store')
    const store = new ConfigStore({ userDir: '/user-data', projectDir: null })

    await store.set('sessions-list', 'sortBy', 'created')

    const config = store.all('sessions-list')
    expect(config.sortBy).toBe('created')
    expect(config.showArchived).toBe(false)  // 没丢
  })

  it('非法 pluginId 抛错（防路径逃逸）', async () => {
    const { ConfigStore } = await import('./config-store')
    const store = new ConfigStore({ userDir: '/user-data', projectDir: null })

    expect(() => store.all('..')).toThrow(/非法 pluginId/)
    expect(() => store.all('/etc/passwd')).toThrow(/非法 pluginId/)
    expect(() => store.all('')).toThrow(/非法 pluginId/)
  })

  it('配置文件不存在时返回空对象', async () => {
    const { ConfigStore } = await import('./config-store')
    const store = new ConfigStore({ userDir: '/user-data', projectDir: null })

    const config = store.all('nonexistent-plugin')
    expect(config).toEqual({})
  })

  it('配置文件损坏时回退空对象并告警', async () => {
    vol.fromJSON({
      '/user-data/broken/config.json': '{ invalid json',
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ConfigStore } = await import('./config-store')
    const store = new ConfigStore({ userDir: '/user-data', projectDir: null })

    const config = store.all('broken')
    expect(config).toEqual({})
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
```

### 5.5 坑：vi.mock 的 hoisting、模块缓存

- **`vi.mock` 是 hoisted 的**。它会被 Vite 提到文件顶部执行，在所有 import 之前。所以 mock 工厂函数里不能引用外层变量（外层变量在 mock 执行时还没初始化）。解决办法是用 `vi.hoisted` 在工厂内部创建 mock 对象，或者用 `vi.doMock` + 动态 `import` 的组合——`doMock` 不是 hoisted 的，它按代码顺序执行。
- **模块缓存**。`vi.doMock` 后要重新 `import` 才能拿到 mock 后的版本——Node/Vite 会缓存模块，之前 import 过的版本不会自动更新。每个 `beforeEach` 里调 `vi.resetModules()` 清缓存，避免测试间互相污染。上面两段代码示例都用了 `vi.doMock` + `await import()` 的组合，就是这个原因。
- **`memfs` 的 `createFsFromVolume` 不是 100% 替代 Node fs**。它提供 `existsSync`、`readdirSync`、`readFileSync`、`statSync` 这些同步 API，但 `fs.promises` 要单独处理。`ConfigStore` 用了 `writeFile`（from `node:fs/promises`），需要额外 mock promise 版本。上面代码示例里同时 mock 了 `node:fs` 和 `node:fs/promises`。

## 6 Layer 4：插件组件测试——DOM 交互模拟的核心

这一层是整个测试方案的重心。domain、gateway、application 的测试都是传统单元测试——纯函数或带 mock 的函数测试。从 plugin 层开始，测试的对象变成了 React 组件——渲染出来的 DOM、用户的交互行为、组件对事件的响应。这就是用户问的"直接操作 DOM 和模拟输入"的落点。

### 6.1 测什么：单个插件的 UI 行为

pi-desktop 的插件 UI 入口是 `renderer/index.tsx`（每个 `plugins/` 子目录下），它是一个 React 组件，接收 `PluginContext` 作为能力来源，渲染插件的界面。测试要验证：

- 组件接收 props / 从 `window.pi` 拉数据后，渲染出正确的 DOM 结构
- 用户点击按钮 → 触发正确的回调 / 状态正确更新
- 表单输入 → onChange 被调用 / dirty 被标记
- 条件渲染逻辑：loading 状态、error 状态、空列表、有数据
- 跨组件的状态流转：store 变化 → 订阅 store 的组件自动更新

### 6.2 工具链：Vitest + React Testing Library + jsdom

```bash
npm install -D @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

三个包各司其职：

- `@testing-library/react` — 提供 `render`（挂载组件到虚拟 DOM）、`screen`（查 DOM 元素）、`fireEvent`（合成事件）、`waitFor`（异步等待）、`cleanup`（卸载组件）。它的核心理念是"以用户交互的方式测试"——不测实现细节，只测"用户能看到什么、能做什么"。
- `@testing-library/jest-dom` — 给 Vitest 的 `expect` 加 DOM 断言：`toBeInTheDocument()`、`toBeVisible()`、`toHaveTextContent()`、`toBeChecked()`。没有这个包，你只能用原生的 `expect(element).not.toBeNull()`。
- `@testing-library/user-event` — 比 `fireEvent` 更真实的事件模拟。`fireEvent.click` 只发一个 click 事件，`userEvent.click` 发完整的交互序列（hover → focus → mousedown → mouseup → click）。

`vitest.config.ts` 已经在 §3.2 配好了（`environment: 'jsdom'`、`setupFiles: ['./test-setup.ts']`）。还需要一个 setup 文件做全局初始化：

```ts
// test-setup.ts
import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// 每个 test 后卸载组件，防止 DOM 残留
afterEach(() => {
  cleanup()
})

// 全局 mock window.pi——所有 plugin 测试共享的默认替身
// 每个测试可以覆盖特定方法的返回值
vi.stubGlobal('pi', {
  config: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue({}),
  },
  sessions: {
    list: vi.fn().mockResolvedValue([]),
    select: vi.fn().mockResolvedValue(undefined),
    getSnapshot: vi.fn().mockResolvedValue(null),
    sync: vi.fn().mockResolvedValue(null),
    onEvent: vi.fn(() => () => {}),
    onSnapshot: vi.fn(() => () => {}),
    openSession: vi.fn().mockResolvedValue(null),
    setContext: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue({ ok: true }),
    stop: vi.fn().mockResolvedValue({ ok: true }),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  },
  themes: {
    list: vi.fn().mockResolvedValue([]),
    build: vi.fn().mockResolvedValue({}),
  },
  i18n: {
    resources: vi.fn().mockResolvedValue({ resources: {}, ns: [], supportedLngs: ['zh-CN'] }),
    list: vi.fn().mockResolvedValue([]),
    detect: vi.fn().mockResolvedValue('zh-CN'),
  },
  settings: {
    list: vi.fn().mockResolvedValue([]),
  },
  slots: {
    sidePanel: vi.fn().mockResolvedValue([]),
    sidebar: vi.fn().mockResolvedValue([]),
  },
  prefs: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
  fs: { listDir: vi.fn().mockResolvedValue([]) },
  git: {
    status: vi.fn().mockResolvedValue({ isRepo: false, files: [] }),
    fileDiff: vi.fn().mockResolvedValue(''),
    fileContent: vi.fn().mockResolvedValue(''),
  },
  dialog: {
    openDirectory: vi.fn().mockResolvedValue(null),
    openImages: vi.fn().mockResolvedValue([]),
  },
  openFile: vi.fn().mockResolvedValue(undefined),
  configFile: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue({}),
  },
})

// jsdom 局限的补丁
vi.stubGlobal('IntersectionObserver', class {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
})
vi.stubGlobal('ResizeObserver', class {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
})
vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: vi.fn(), removeListener: vi.fn(),
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
})))
```

### 6.3 基础模式：渲染 → 模拟输入 → 断言 DOM

这是 plugin 测试的三步范式。先看一个真实例子——sessions-list 插件。

sessions-list 插件的 `renderer/index.tsx` 渲染一个会话列表，用户点击会话项触发选中。测试验证：加载完数据后渲染了正确的列表项、点击触发 select、选中项被标记。

```tsx
// plugins/sessions-list/renderer/SessionList.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// mock @pi-desktop/react 的 usePluginContext
const mockSessionsList = vi.fn()
const mockSessionsSelect = vi.fn()

vi.mock('@pi-desktop/react', () => ({
  usePluginContext: () => ({
    pluginId: 'sessions-list',
    sessions: {
      list: mockSessionsList,
      select: mockSessionsSelect,
      openSession: vi.fn().mockResolvedValue(null),
      setContext: vi.fn().mockResolvedValue(undefined),
    },
    config: { get: vi.fn(), set: vi.fn(), all: vi.fn().mockReturnValue({}) },
    i18n: { t: (key: string) => key, locale: 'zh-CN' },
  }),
}))

describe('SessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionsList.mockResolvedValue([
      { id: 's1', name: 'Debug API', cwd: '/proj', path: '/sessions/s1',
        created: '2024-01-15T10:00:00Z', modified: '2024-01-15T10:30:00Z',
        lastMessage: '函数写好了' },
      { id: 's2', name: 'Refactor auth', cwd: '/proj', path: '/sessions/s2',
        created: '2024-01-14T15:00:00Z', modified: '2024-01-14T16:00:00Z',
        lastMessage: '认证重构成了' },
    ])
  })

  it('加载完成后渲染会话列表', async () => {
    const { SessionList } = await import('./index')
    render(<SessionList />)

    // 加载中——初始渲染
    // 等异步 list() resolve 后渲染列表项
    await waitFor(() => {
      expect(screen.getByText('Debug API')).toBeInTheDocument()
    })

    expect(screen.getByText('Refactor auth')).toBeInTheDocument()
    // 每项有副标题预览
    expect(screen.getByText('函数写好了')).toBeInTheDocument()
  })

  it('点击会话项触发 select', async () => {
    const user = userEvent.setup()
    const { SessionList } = await import('./index')
    render(<SessionList />)

    await waitFor(() => {
      expect(screen.getByText('Debug API')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Debug API'))

    expect(mockSessionsSelect).toHaveBeenCalled()
  })

  it('空列表显示空状态', async () => {
    mockSessionsList.mockResolvedValueOnce([])
    const { SessionList } = await import('./index')
    render(<SessionList />)

    await waitFor(() => {
      expect(screen.getByText(/暂无|空/i)).toBeInTheDocument()
    })
  })

  it('加载失败显示错误提示', async () => {
    mockSessionsList.mockRejectedValueOnce(new Error('Network error'))
    const { SessionList } = await import('./index')
    render(<SessionList />)

    await waitFor(() => {
      expect(screen.getByText(/error|错误|失败/i)).toBeInTheDocument()
    })
  })
})
```

这个测试的三步范式：

1. **渲染**：`render(<SessionList />)` 把组件挂到 jsdom 的虚拟 DOM 上。组件内部调 `usePluginContext` 拿到 mock 后的 sessions API，`list()` 返回预设的两条会话数据。
2. **模拟输入**：`user.click(screen.getByText('Debug API'))` 模拟用户点击。`userEvent.setup()` 创建一个用户交互实例，它的 `click` 发出完整的事件序列（hover → focus → mousedown → mouseup → click）。
3. **断言 DOM**：`expect(screen.getByText('Debug API')).toBeInTheDocument()` 查 DOM 里有没有这个文本。`expect(mockSessionsSelect).toHaveBeenCalled()` 验证点击触发了正确的回调。

### 6.4 fireEvent vs userEvent：精度差异详解

Testing Library 提供两套事件模拟 API，精度不同：

**`fireEvent`** 是低层级 API——每个事件单独发，直接 `dispatchEvent`：

```tsx
import { fireEvent } from '@testing-library/react'

fireEvent.click(element)
// 只发一个 click 事件，走 React 的合成事件系统
```

**`userEvent`** 是高层级 API——模拟完整的人类交互序列：

```tsx
import userEvent from '@testing-library/user-event'
const user = userEvent.setup()

await user.click(element)
// 发出的事件序列：
// 1. mouseover → mouseenter（进入元素）
// 2. mousemove（移动到元素上）
// 3. focus（元素获得焦点，如果是可聚焦元素）
// 4. mousedown（鼠标按下）
// 5. mouseup（鼠标抬起）
// 6. click（最终的 click 事件）
```

两者的选择标准：

- **默认用 `userEvent`**。它更接近真实用户行为，能覆盖 `fireEvent` 漏掉的边界——比如 focus 事件不触发导致 `:focus` 伪类不生效、mousedown 不触发导致拖拽逻辑不跑。
- **只在需要精确控制时用 `fireEvent`**。比如测"阻止冒泡的 click 不会触发父级 handler"、测"自定义事件"、测需要传特定 `MouseEvent` 初始化参数的场景。

一个具体差异：如果组件有"输入防抖"（每次按键延迟 300ms 才搜索），`userEvent.type` 能正确触发防抖逻辑——它逐字符输入，每次触发 `keydown`/`input`/`keyup`。`fireEvent.change` 只发一个 `change` 事件，跳过了所有按键过程，防抖逻辑根本不触发。

```tsx
// userEvent.type 逐字符输入——和人类打字一致
await user.type(inputElement, 'hello')
// 发出 5 次 keydown/input/keyup 事件序列

// fireEvent.change 一次性改值——跳过所有按键过程
fireEvent.change(inputElement, { target: { value: 'hello' } })
// 只发一个 change 事件
```

### 6.5 mock window.pi：插件能力入口的替身

插件不直接调 `window.pi`——它通过 `usePluginContext`（`packages/react/src/plugin-context.ts`）拿绑定后的上下文。但 `usePluginContext` 内部调 `window.pi` 的 IPC 方法。测试里有两个 mock 层位：

**方案一：mock `@pi-desktop/react` 的 `usePluginContext`**（推荐）

直接在 `vi.mock('@pi-desktop/react', ...)` 里替换 `usePluginContext` 的返回值。插件组件看到的是一个完整的 `PluginContext` 对象，里面的 `config`、`sessions`、`fs`、`git`、`dialog` 都是 mock 函数。

好处是：插件测试完全不知道 `window.pi` 的存在——它只认 `usePluginContext` 的返回值，而那个返回值是测试控制的。这和真实代码的依赖方向一致：插件依赖 `@pi-desktop/react`，不直接依赖 `window.pi`。

```tsx
vi.mock('@pi-desktop/react', () => ({
  usePluginContext: () => ({
    pluginId: 'test-plugin',
    config: { get: vi.fn().mockResolvedValue({ model: 'gpt-4' }) },
    sessions: { list: vi.fn().mockResolvedValue([]) },
    i18n: { t: (key: string) => key, locale: 'zh-CN' },
    // ...其余 API
  }),
}))
```

**方案二：mock 全局 `window.pi`**

在 `test-setup.ts` 里 `vi.stubGlobal('pi', {...})` 提供一个全局替身。`usePluginContext` 内部调 `window.pi.config.get(pluginId, key)` 会走到全局 mock。好处是所有测试共享同一套 mock 默认值，个别测试覆盖特定方法的返回值即可。

```tsx
// 全局 mock 在 test-setup.ts 里（见 §6.2）
// 个别测试覆盖特定方法：
;(window.pi.sessions.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
  { id: 'special', name: '特殊会话', /* ... */ },
])
```

两种方案不互斥——方案一适合需要精确控制每个 API 返回值的测试，方案二适合只需默认行为偶尔覆盖的测试。推荐方案一作为默认，因为它和插件的依赖方向一致。

### 6.6 jsdom 局限与绕过

jsdom 是纯 JavaScript 的 DOM 实现，没有真实渲染引擎。以下是已知局限和应对：

- **`getBoundingClientRect()` 返回全零**。jsdom 没有布局引擎，所有元素的 `width`/`height`/`top`/`left` 都是 0。如果组件依赖位置计算（如 popover 定位、虚拟列表滚动），需要 mock：`vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 200, height: 100, top: 0, left: 0, bottom: 100, right: 200, x: 0, y: 0, toJSON: () => ({}) })`。
- **没有 `IntersectionObserver`**。在 `test-setup.ts` 里 mock 一个空实现（见 §6.2 的 setup 文件）。
- **没有 `ResizeObserver`**。同上 mock。
- **`window.matchMedia` 不存在**。用了 media query 的组件（如响应式布局）会报错。在 setup 里 mock。
- **`scrollIntoView` 是空函数**。滚动测试不生效——mock 成 `vi.fn()`，验证被调了即可，不验滚动位置。
- **CSS 不生效**。jsdom 不渲染样式，`getComputedStyle` 返回空。不要在 jsdom 里断言 CSS 属性值——CSS 的正确性交给 Playwright 视觉回归测试。

### 6.7 测 store 交互：插件间间接通信验证

CLAUDE.md §8.2 说插件间通过共享 store（zustand）间接通信。`packages/react/src/session-store.ts` 是 renderer 侧的单一真相源——它从 main 推送的 `session:snapshot` 和 `session:event` 更新状态，组件只读 store。

`session-store.ts` 里有一个纯函数 `applyEvent`（`session-store.ts:48`），它做事件增量应用——给定当前消息列表和一个事件，返回更新后的消息列表。这个纯函数不需要 mock 任何东西，可以像 domain 测试一样直接测：

```ts
// packages/react/src/session-store.test.ts
import { describe, it, expect } from 'vitest'
import { applyEvent } from './session-store'
import type { NeutralMessage, SessionEvent } from '@pi-desktop/core'

describe('applyEvent', () => {
  const baseMessages: NeutralMessage[] = [
    { id: 'u1', role: 'user', content: 'hello' },
  ]

  it('messageStart 替换 pending 占位', () => {
    const messages: NeutralMessage[] = [
      ...baseMessages,
      { id: 'a1', role: 'assistant', content: '', pending: true },
    ]
    const event: SessionEvent = {
      type: 'messageStart',
      message: { id: 'a1', role: 'assistant', content: 'Hi' },
    }

    const result = applyEvent(messages, event)
    const last = result[result.length - 1]
    expect(last.content).toBe('Hi')
    expect(last.pending).toBe(true)
    expect(result).toHaveLength(2)  // 没有追加，是替换
  })

  it('messageUpdate 按 id 精确 patch', () => {
    const messages: NeutralMessage[] = [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: 'Hi', pending: true },
    ]
    const event: SessionEvent = {
      type: 'messageUpdate',
      message: { id: 'a1', role: 'assistant', content: 'Hi there!' },
    }

    const result = applyEvent(messages, event)
    expect(result[1].content).toBe('Hi there!')
    expect(result[1].pending).toBe(false)
  })

  it('messageEnd 按 id 定稿', () => {
    const messages: NeutralMessage[] = [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: 'Hi there!', pending: true },
    ]
    const event: SessionEvent = {
      type: 'messageEnd',
      message: { id: 'a1', role: 'assistant', content: 'Hi there! Done.' },
    }

    const result = applyEvent(messages, event)
    expect(result[1].content).toBe('Hi there! Done.')
    expect(result[1].pending).toBe(false)
    expect(result[1].stopped).toBe(false)
  })

  it('messageUpdate 无 id 时退回末条 assistant 替换', () => {
    const messages: NeutralMessage[] = [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: 'Hi', pending: true },
    ]
    const event = {
      type: 'messageUpdate',
      message: { role: 'assistant', content: 'Hi there!' },
    } as SessionEvent

    const result = applyEvent(messages, event)
    expect(result[1].content).toBe('Hi there!')
    expect(result[1].id).toBe('a1')  // 保留了原 id
  })

  it('messageEnd 末条 user 文本相同 → 去重乐观回显', () => {
    const messages: NeutralMessage[] = [
      { id: 'optimistic', role: 'user', content: 'hello' },
    ]
    const event: SessionEvent = {
      type: 'messageEnd',
      message: { id: 'real-u1', role: 'user', content: 'hello' },
    }

    const result = applyEvent(messages, event)
    expect(result).toHaveLength(1)  // 去重，不重复
    expect(result[0].id).toBe('real-u1')  // 用底座给的 id
  })

  it('entryAppended 非 message 型映射成中性消息追加', () => {
    const event: SessionEvent = {
      type: 'entryAppended',
      entry: { type: 'model_change', provider: 'anthropic', modelId: 'claude-3' },
    }

    const result = applyEvent(baseMessages, event)
    expect(result).toHaveLength(2)
    expect(result[1].role).toBe('divider')
  })

  it('entryAppended message 型不重复处理（由 messageEnd 通道进）', () => {
    const event: SessionEvent = {
      type: 'entryAppended',
      entry: { type: 'message', message: { role: 'user', content: 'test' } },
    }

    const result = applyEvent(baseMessages, event)
    expect(result).toHaveLength(1)  // 不追加
  })
})
```

这个测试是整个测试方案里一个特殊的点——它测的是 `packages/react` 里的纯函数，不是 `plugins/` 里的组件。但它的 mock 边界和 domain 一致：零 mock。`applyEvent` 是纯函数，输入是消息列表和事件，输出是更新后的消息列表，不碰 IO 不碰 DOM。

测 store 的 Zustand 行为（state 变化触发 re-render）则需要用真实 store：

```tsx
it('store 状态变化后订阅组件自动更新', async () => {
  // 用真实 zustand store
  const { useSessionStore } = await import('./session-store')

  // 渲染一个订阅 store 的组件
  const TestComponent = () => {
    const ready = useSessionStore((s) => s.ready)
    return <div data-testid="ready">{String(ready)}</div>
  }

  render(<TestComponent />)
  expect(screen.getByTestId('ready')).toHaveTextContent('false')

  // 模拟 main 推 snapshot
  act(() => {
    useSessionStore.setState({ ready: true })
  })

  expect(screen.getByTestId('ready')).toHaveTextContent('true')
})
```

### 6.8 常见模式速查

**模式 1：异步加载完成后再断言**

```tsx
// 错误：还没加载完就断言
render(<SessionList />)
expect(screen.getByText('Debug API')).toBeInTheDocument()  // 可能抛错

// 正确：waitFor 等异步完成
render(<SessionList />)
await waitFor(() => {
  expect(screen.getByText('Debug API')).toBeInTheDocument()
})
```

**模式 2：覆盖默认 mock返回值**

```tsx
it('超过 100 条会话分页', async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({
    id: `s${i}`, name: `Session ${i}`, cwd: '/p', path: `/s${i}`,
    created: '2024-01-01', modified: '2024-01-01',
  }))
  mockSessionsList.mockResolvedValueOnce(many)

  render(<SessionList />)
  await waitFor(() => {
    expect(screen.getAllByRole('option')).toHaveLength(50)  // 每页 50
  })
})
```

**模式 3：测试 dirty 追踪（框架管 save）**

```tsx
it('改设置项标 dirty，弹保存浮层', async () => {
  const user = userEvent.setup()
  render(<PiManagerSettings />)

  await waitFor(() => {
    expect(screen.getByTestId('auto-start-checkbox')).toBeInTheDocument()
  })

  // 切换 checkbox
  await user.click(screen.getByTestId('auto-start-checkbox'))

  // 框架的保存浮层出现
  await waitFor(() => {
    expect(screen.getByTestId('save-bar')).toBeVisible()
  })
})
```

**模式 4：键盘导航测试**

```tsx
it('Tab 键在会话项间切换', async () => {
  const user = userEvent.setup()
  render(<SessionList />)

  await waitFor(() => {
    expect(screen.getByText('Debug API')).toBeInTheDocument()
  })

  const firstItem = screen.getAllByRole('option')[0]
  firstItem.focus()

  await user.keyboard('{Tab}')
  expect(screen.getAllByRole('option')[1]).toHaveFocus()

  await user.keyboard('{Enter}')
  expect(mockSessionsSelect).toHaveBeenCalled()
})
```

## 7 Layer 5：集成测试——Playwright + 真实浏览器

### 7.1 测什么：多组件协作、CSS、跨插件流转

jsdom 测不了的东西交给 Playwright——真实事件链、真实 CSS 布局、多组件协作、跨插件的状态流转。这一层不追求行覆盖率，追求核心用户路径覆盖。

具体测什么：

- 真实的用户交互链：打开应用 → 侧栏出现会话列表 → 点击会话 → 主区域加载消息 → 输入消息 → 发送
- 跨组件的状态流转：插件 A 改了 store → 插件 B 的 UI 是否更新（需要 mock 能在运行时推送事件——扩展 §7.3 的静态 mock，通过 `onEvent` 回调注入增量事件）
- 真实的 CSS 布局：元素是否可见、是否被遮挡、滚动位置
- 主题切换后 CSS 变量是否注入到 `:root`

### 7.2 工具：Playwright 配置

```bash
npm install -D @playwright/test
npx playwright install chromium
```

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
})
```

### 7.3 mock 后端：浏览器侧 window.pi 替身

Playwright 在页面加载前注入一段脚本，替换 `window.pi` 为测试替身。这样前端全真（真实 React 渲染、真实事件链、真实 CSS），后端全假（IPC 调用返回预设数据）。

```ts
// e2e/mocks.ts
import { Page } from '@playwright/test'

export async function mockWindowPi(page: Page) {
  await page.addInitScript(() => {
    const sessions = [
      { id: 's1', name: 'Test Session 1', cwd: '/project',
        path: '/sessions/s1', created: '2024-01-15T10:00:00Z',
        modified: '2024-01-15T10:30:00Z', lastMessage: '函数写好了' },
      { id: 's2', name: 'Test Session 2', cwd: '/project',
        path: '/sessions/s2', created: '2024-01-14T15:00:00Z',
        modified: '2024-01-14T16:00:00Z', lastMessage: '认证重构完了' },
    ]

    ;(window as any).pi = {
      config: {
        get: async () => ({ model: 'test-model' }),
        set: async () => {},
        all: async () => ({ model: 'test-model' }),
      },
      sessions: {
        list: async () => sessions,
        select: async () => {},
        getSnapshot: async () => null,
        sync: async () => null,
        openSession: async () => ({ messages: [] }),
        setContext: async () => {},
        start: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
        onEvent: (cb: (e: unknown) => void) => {
          // 不模拟事件流
          return () => {}
        },
        onSnapshot: (cb: (s: unknown) => void) => {
          return () => {}
        },
        prompt: async () => {},
        abort: async () => {},
      },
      themes: {
        list: async () => [
          { id: 'dark', name: 'Dark' },
          { id: 'light', name: 'Light' },
        ],
        build: async () => ({
          'color.bg': '#1e1e2e',
          'color.text': '#cdd6f4',
        }),
      },
      i18n: {
        resources: async () => ({
          resources: { 'zh-CN': { common: { appTitle: 'pi-desktop' } } },
          ns: ['common'],
          supportedLngs: ['zh-CN'],
        }),
        list: async () => [{ id: 'zh-CN', name: '简体中文' }],
        detect: async () => 'zh-CN',
      },
      settings: { list: async () => [] },
      slots: { sidePanel: async () => [], sidebar: async () => [] },
      prefs: { get: async () => null, set: async () => {} },
      fs: { listDir: async () => [] },
      git: { status: async () => ({ isRepo: false, files: [] }),
         fileDiff: async () => '',
         fileContent: async () => '' },
      dialog: { openDirectory: async () => null, openImages: async () => [] },
      openFile: async () => {},
      configFile: { get: async () => ({}), set: async () => ({}) },
    }
  })
}
```

关键点：`addInitScript` 必须在 `page.goto` 之前调——它注入的脚本在页面任何其他脚本之前执行。如果页面已经加载了，`window.pi` 来不及替换。

### 7.4 代码示例：完整用户路径

```tsx
// e2e/session-flow.spec.ts
import { test, expect } from '@playwright/test'
import { mockWindowPi } from './mocks'

test.describe('会话流程', () => {
  test.beforeEach(async ({ page }) => {
    await mockWindowPi(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="app-ready"]')
  })

  test('侧栏显示会话列表', async ({ page }) => {
    await expect(page.locator('[data-testid="session-list"]')).toBeVisible()
    await expect(page.getByText('Test Session 1')).toBeVisible()
    await expect(page.getByText('Test Session 2')).toBeVisible()
  })

  test('点击会话 → 主区域更新', async ({ page }) => {
    await page.click('[data-testid="session-item-s1"]')
    // 主区域出现会话标题
    await expect(page.locator('[data-testid="main-header"]'))
      .toContainText('Test Session 1')
  })

  test('切换会话 → 旧选中消失、新选中生效', async ({ page }) => {
    await page.click('[data-testid="session-item-s1"]')
    await expect(page.locator('[data-testid="session-item-s1"]'))
      .toHaveAttribute('aria-selected', 'true')

    await page.click('[data-testid="session-item-s2"]')
    await expect(page.locator('[data-testid="session-item-s2"]'))
      .toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[data-testid="session-item-s1"]'))
      .toHaveAttribute('aria-selected', 'false')
  })

  test('键盘导航：Tab 切换 + Enter 选中', async ({ page }) => {
    await page.focus('[data-testid="session-item-s1"]')
    await page.keyboard.press('Tab')
    await expect(page.locator('[data-testid="session-item-s2"]')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-testid="session-item-s2"]'))
      .toHaveAttribute('aria-selected', 'true')
  })

  test('主题切换 → CSS 变量生效', async ({ page }) => {
    const initialBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-bg')
    )

    await page.click('[data-testid="theme-switcher"]')
    await page.click('[data-testid="theme-light"]')

    await expect.poll(async () => {
      return await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--color-bg')
      )
    }).not.toBe(initialBg)
  })
})
```

### 7.5 Playwright API 工具箱

Playwright 的事件模拟通过 CDP（Chrome DevTools Protocol）直接在浏览器引擎里注入事件，走完整的浏览器事件传播链——比 Testing Library 的合成事件更真实：

```tsx
// 鼠标
await page.click('#button')           // 点击
await page.dblclick('#button')         // 双击
await page.hover('#element')           // 悬停
await page.mouse.move(100, 200)       // 移动到坐标
await page.mouse.down()                // 按下
await page.mouse.up()                  // 抬起

// 键盘
await page.keyboard.type('hello')     // 逐字符输入
await page.keyboard.press('Enter')    // 按键
await page.keyboard.press('Shift+ArrowLeft')  // 组合键
await page.keyboard.down('Shift')     // 按住
await page.keyboard.up('Shift')       // 松开

// 文件上传
await page.setInputFiles('input[type=file]', '/path/to/file.json')

// 拖拽
await page.dragAndDrop('#source', '#target')

// 等待（等条件不等时间）
await expect(page.locator('.loaded')).toBeVisible({ timeout: 5000 })
await page.waitForLoadState('networkidle')
await expect.poll(async () => /* ... */).toBe('expected value')
```

### 7.6 坑：隔离、addInitScript 时机、flaky

- **测试隔离**。Playwright 默认每个 test 一个全新 page context。但如果 `reuseExistingServer: true` 跑 dev server，dev server 的状态可能被前一个 test 污染。解决办法：在 `beforeEach` 里重置 mock 数据，或用 `storageState` 管理状态。
- **`addInitScript` 时机**。必须在 `page.goto` 之前调。`mockWindowPi` 在 `beforeEach` 里调，然后才 `page.goto`，就是这个原因。
- **flaky test 的根源是固定等待**。`page.waitForTimeout(2000)` 是 flaky 的根源——赌 2 秒后操作一定完成了。正确做法是 `expect.poll` 或 `toBeVisible({ timeout })` 等条件。CLAUDE.md §3.6"事件驱动不轮询"在测试里的体现：等条件不等时间。

## 8 Layer 6：E2E Electron——真实 IPC 全链路

### 8.1 测什么：preload、IPC 往返、子进程生命周期

最接近真实使用场景的测试：起真正的 Electron 进程，走真实 IPC 通道，读真实文件系统。这一层覆盖 jsdom 和 Playwright 测不到的东西：

- preload 桥接：`contextBridge.exposeInMainWorld` 暴露的 `window.pi` 是否真的可用
- IPC 往返：renderer 调 `window.pi.config.get` → main 进程处理 → 返回结果
- 子进程生命周期：spawn pi 底座 → 发命令 → 收响应 → stop
- 插件加载的完整链路：发现 → 校验 → 注册 → 渲染

### 8.2 工具：Playwright _electron 模块

Playwright 的 `_electron` 模块专门测 Electron 应用：

```ts
// electron.playwright.config.ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e-electron',
  timeout: 60000,  // Electron 启动慢，给足超时
  use: {
    trace: 'on-first-retry',
  },
})
```

### 8.3 测试夹具目录管理

E2E 需要真实文件。准备一个测试用目录：

```
test-fixtures/
  plugins/
    builtin/
      theme-dark/
        plugin.json
        index.js
      sessions-list/
        plugin.json
        index.js
  sessions/
    s1/
      session.jsonl      # 测试会话
    s2/
      session.jsonl
  config/
    sessions-list.json   # 插件配置
```

应用通过环境变量 `PI_TEST_MODE` 切换到测试夹具目录：

```ts
// shell/electron-main/index.ts
const dataDir = process.env.PI_TEST_MODE
  ? path.join(__dirname, '..', '..', 'test-fixtures')
  : app.getPath('userData')
```

### 8.4 代码示例

```tsx
// e2e-electron/app.spec.ts
import { _electron as electron, test, expect } from '@playwright/test'
import path from 'node:path'

test('应用启动并显示主窗口', async () => {
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..', 'dist-electron', 'main.js')],
    env: { ...process.env, PI_TEST_MODE: 'true' },
  })

  const window = await app.firstWindow()
  await expect(window).toHaveTitle(/pi-desktop/)
  await window.waitForSelector('[data-testid="app-ready"]')
  await expect(window.locator('[data-testid="sidebar"]')).toBeVisible()

  await app.close()
})

test('IPC 真实往返：config.get 读到配置文件', async () => {
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..', 'dist-electron', 'main.js')],
    env: { ...process.env, PI_TEST_MODE: 'true' },
  })

  const win = await app.firstWindow()
  await win.waitForSelector('[data-testid="app-ready"]')

  // 走真实 IPC 通道
  const config = await win.evaluate(() =>
    (window as any).pi.config.all('sessions-list')
  )

  // 验证读到了测试夹具里的配置
  expect(config).toBeDefined()

  await app.close()
})

test('插件加载链路：发现 → 注册 → 渲染', async () => {
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..', 'dist-electron', 'main.js')],
    env: { ...process.env, PI_TEST_MODE: 'true' },
  })

  const win = await app.firstWindow()
  await win.waitForSelector('[data-testid="app-ready"]')

  // 内置插件被加载——sidebar 有 sessions-list
  await expect(win.locator('[data-testid="session-list"]')).toBeVisible()

  // 主题列表有 dark
  await win.click('[data-testid="theme-switcher"]')
  await expect(win.locator('[data-testid="theme-dark"]')).toBeVisible()

  await app.close()
})
```

### 8.5 什么不该放进 E2E

E2E 慢——每个 test 要起一个 Electron 进程，冷启动 3-5 秒。所以 E2E 不追求多，追求关键路径覆盖。以下不该放进 E2E：

- **单个组件的交互逻辑**——那是 Layer 4 的事（jsdom 快得多）。
- **纯函数逻辑**——那是 Layer 1 的事（毫秒级）。
- **协议翻译**——那是 Layer 2 的事（不需要起 Electron）。
- **CSS 细节**——那是视觉回归测试的事（Playwright 截图对比）。

E2E 只测"整条链路走通"：启动 → 插件加载 → 用户交互 → IPC 往返 → 子进程通信。

## 9 视觉回归测试（可选层）

### 9.1 为什么需要：DOM 断言抓不到 CSS 回归

Layer 4（plugin 组件测试）验证的是组件行为——点击对不对、渲染对不对。但它验证不了"看起来对不对"。jsdom 不渲染样式，`getComputedStyle` 返回空字符串，CSS 断言全是无意义的。

改了一个组件的样式，另一个组件跟着歪了——这种 CSS 回归靠人眼看不到，靠 DOM 断言也抓不到。需要专门的视觉回归测试：截图对比，像素级 diff。

### 9.2 Playwright 截图对比

```tsx
// e2e/visual.spec.ts
import { test, expect } from '@playwright/test'
import { mockWindowPi } from './mocks'

test.describe('视觉回归', () => {
  test.beforeEach(async ({ page }) => {
    await mockWindowPi(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="app-ready"]')
    // 禁用动画——动画会导致截图书不一致
    await page.emulateMedia({ reducedMotion: 'reduce' })
  })

  test('会话列表视觉一致性', async ({ page }) => {
    await expect(page.locator('[data-testid="session-list"]')).toHaveScreenshot(
      'session-list.png',
      { maxDiffPixelRatio: 0.01 }
    )
  })

  test('设置页视觉一致性', async ({ page }) => {
    await page.click('[data-testid="settings-tab"]')
    await expect(page.locator('[data-testid="settings-panel"]')).toHaveScreenshot(
      'settings-panel.png'
    )
  })

  test('暗色主题 vs 亮色主题', async ({ page }) => {
    await page.click('[data-testid="theme-switcher"]')
    await page.click('[data-testid="theme-dark"]')
    await expect(page).toHaveScreenshot('dark-theme.png')

    await page.click('[data-testid="theme-light"]')
    await expect(page).toHaveScreenshot('light-theme.png')
  })
})
```

第一次跑生成基线截图（存在 `e2e/visual.spec.ts-snapshots/` 下），后续每次跑和基线对比。差异超过阈值（`maxDiffPixelRatio: 0.01` = 允许 1% 像素差异）就失败，逼你确认变化是故意的还是回归。

### 9.3 坑：字体差异、flaky、基线维护

- **字体渲染差异**。不同 OS 的字体渲染不同——macOS 的 ClearType 和 Linux 的 FreeType 不一样。CI（通常 Linux）和本地（macOS）截图对不上。解决办法：在 Playwright 配置里用 `--font-render-hinting=none` 或在 CI 上装固定字体（如 Noto Sans），截图基线只在 CI 上生成和更新。
- **抗 flaky**。动画、懒加载图片、外部资源导致截图书不一致。用 `reducedMotion: 'reduce'` 禁用动画 + `waitForLoadState('networkidle')` 等所有资源加载完。
- **基线维护成本**。每改一次 UI 就要更新基线（`npx playwright test --update-snapshots`）。建议视觉测试只覆盖关键页面（3-5 个截图），不要全量——全量截图的维护成本会吃掉收益。

## 10 Mock 策略总表

### 10.1 六层 mock 边界一览

这是整个测试方案的核心纪律。Mock 边界和架构的依赖方向一一对应——依赖只向内（CLAUDE.md §1.1），所以 mock 从外到内逐层收窄：

| 层 | mock 什么 | 不 mock 什么 | 理由 |
|---|---|---|---|
| Domain | **什么都不 mock** | 全不 mock | 零依赖，不需要。需要 mock = 架构违规 |
| Gateway | SubprocessHandle 接口 | RPC 逻辑、事件翻译、id 配对 | 进程管理是 shell 层的事，gateway 只管协议翻译 |
| Application | 文件系统（memfs） | 加载编排逻辑、配置合并逻辑、主题解析 | IO 是外层细节，编排逻辑是本层职责 |
| Plugin | window.pi（IPC）、usePluginContext | React 渲染、组件逻辑、store 交互 | IPC 是外部能力，组件行为是本层职责 |
| Integration | window.pi 的后端实现（假数据） | React 渲染、真实浏览器事件、CSS | 测前端全链路，后端用假数据 |
| E2E | **什么都不 mock** | 全不 mock | 走真实链路，测全链路集成 |

### 10.2 违反 mock 纪律的信号

以下每个信号都意味着分层出了问题——不是"测试写得不好"的问题，是架构违规在测试领域的投影：

- Domain 测试里出现 `vi.mock` → domain 依赖了外层，架构红线（CLAUDE.md §1.1）
- Gateway 测试里 mock 了 React → gateway 不该碰 UI
- Application 测试里 mock 了 electron → application 不该依赖 shell（CLAUDE.md §6.2）
- Plugin 测试里 mock 了 React 本身 → 在测假的东西，React 不是外部依赖
- Integration 测试里 mock 了 React 渲染 → 那它就不是 integration 测试了，降级成 unit
- E2E 测试里 mock 了 IPC → 那它就不是 E2E 了，降级成 integration

这个检查不需要人盯——CI 可以自动化：grep 每个目录下的测试文件里的 `vi.mock` 调用，检查 mock 的对象是否越层。注意这条 grep 规则只覆盖 vitest 测试（domain/gateway/application/plugin 层）；Integration 和 E2E 层用的是 Playwright 的 `addInitScript` 做 mock，不走 `vi.mock`，需要单独 code review 确认 mock 边界。

## 11 测试数据管理

### 11.1 夹具工厂：统一数据源

测试数据散落各处是维护噩梦——同一个 `SessionInfo` 在五个测试文件里各写一份，改了字段五个地方要改。收拢到一个夹具目录：

```
test-fixtures/
  factories/
    session.ts      # 会话工厂
    plugin.ts       # 插件 manifest 工厂
    theme.ts        # 主题工厂
  data/
    sessions/       # 真实会话 JSONL 样本
    configs/        # 真实配置 JSON
```

```ts
// test-fixtures/factories/session.ts
import type { SessionInfo } from '@/domain/sessions'

let counter = 0

export function createSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  counter++
  return {
    id: `test-session-${counter}`,
    name: `Test Session ${counter}`,
    cwd: '/project',
    path: `/sessions/test-session-${counter}`,
    created: '2024-01-15T10:00:00Z',
    modified: '2024-01-15T10:30:00Z',
    lastMessage: '这是最后一条消息的预览',
    pinned: false,
    archived: false,
    ...overrides,
  }
}

export function createSessionList(count: number): SessionInfo[] {
  return Array.from({ length: count }, (_, i) =>
    createSession({
      id: `s${i + 1}`,
      name: `Session ${i + 1}`,
      lastMessage: `消息预览 ${i + 1}`,
    })
  )
}

export function createPinnedSession(): SessionInfo {
  return createSession({ pinned: true, name: '置顶会话' })
}

export function createArchivedSession(): SessionInfo {
  return createSession({ archived: true, name: '已归档会话' })
}
```

工厂函数 import 圆心的类型定义（`SessionInfo`），按类型生成测试数据。圆心类型改了，工厂函数编译就报错——这是契约单源（CLAUDE.md §1.3）在测试数据上的落地。

### 11.2 JSONL 会话夹具

会话是 JSONL 文件——每行一条消息。测试里用真实的 JSONL 样本，验证流式解析和条目映射：

```jsonl
{"type":"session","name":"测试会话","cwd":"/project"}
{"type":"message","message":{"role":"user","content":"帮我写一个函数","id":"m1"},"timestamp":"2024-01-15T10:00:00Z"}
{"type":"message","message":{"role":"assistant","content":"好的，我来帮你","id":"m2"},"timestamp":"2024-01-15T10:00:05Z"}
{"type":"custom_message","customType":"approval-request","content":"请批准执行此命令"}
{"type":"model_change","provider":"anthropic","modelId":"claude-3-opus"}
{"type":"compaction","tokensBefore":15000,"summary":"对话已压缩"}
{"type":"label","label":"重要节点"}
```

```ts
import { readFileSync } from 'node:fs'
import { sessionEntryToNeutral } from '@/domain/events/session-state'

test('JSONL 样本解析', () => {
  const raw = readFileSync('test-fixtures/data/sessions/test.jsonl', 'utf8')
  const lines = raw.trim().split('\n')
  const neutrals = lines.map(line => sessionEntryToNeutral(JSON.parse(line)))

  // session 行 → null（隐藏层）
  expect(neutrals[0]).toBeNull()
  // message 行 → 原样透传
  expect(neutrals[1]!.role).toBe('user')
  expect(neutrals[1]!.content).toBe('帮我写一个函数')
  // custom_message → role 取 customType
  expect(neutrals[3]!.role).toBe('approval-request')
  // model_change → divider
  expect(neutrals[4]!.role).toBe('divider')
  expect(neutrals[4]!.content).toContain('claude-3-opus')
  // compaction → divider with token format
  expect(neutrals[5]!.content).toContain('15.0k')
  // label → divider
  expect(neutrals[6]!.content).toContain('重要节点')
})
```

### 11.3 测试插件目录

E2E 测试需要一个完整的插件目录，包含真实 `plugin.json` 和入口文件。这些夹具放在 `test-fixtures/plugins/` 下，结构镜像真实插件目录：

```
test-fixtures/plugins/
  builtin/
    theme-dark/
      plugin.json        # 真实 manifest
      index.js           # 最小入口（module.exports = {}）
    sessions-list/
      plugin.json
      index.js
  user/
    theme-custom/
      plugin.json        # 用户级主题（覆盖测试用）
      index.js
```

E2E 启动时用 `PI_TEST_MODE=true` 让应用读这个目录，而不是真实用户目录。这验证了插件加载的完整链路——发现 → 校验 → 注册 → 渲染——用的是真实文件、真实目录结构。

## 12 CI 集成

### 12.1 GitHub Actions 配置

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test:unit -- --coverage
      - run: npm run test:lint

  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e

  electron:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run build:electron
      - run: npm run test:e2e-electron
```

三个 job 并行跑：unit（快，毫秒级）、integration（中等，秒级）、electron（慢，需要 macOS runner）。CI 失败时任何一个 job 红就拦 PR。

### 12.2 npm scripts 与覆盖率目标

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run",
    "test:unit:watch": "vitest",
    "test:e2e": "playwright test --config=playwright.config.ts",
    "test:e2e-electron": "playwright test --config=electron.playwright.config.ts",
    "test:visual": "playwright test --config=playwright.config.ts",
    "test:visual:update": "playwright test --config=playwright.config.ts --update-snapshots",
    "test:all": "npm run typecheck && npm run test:unit && npm run test:e2e && npm run test:e2e-electron"
  }
}
```

覆盖率目标按层分配（§2.3 已详述）：domain 95%+、gateway 90%+、application 80%+、plugins 70%+、E2E 不追行覆盖率追路径覆盖。这些数字是参考不是硬指标——更重要的是"有没有完全没测到的代码"。

## 13 不应该测什么

说够了该测什么，也说不该测什么——不测的比测的更重要，因为测错东西比不测更糟。

### 13.1 不测第三方库的内部行为

```tsx
// 错误：测 zustand 的内部实现
it('zustand 的 set 触发 re-render', () => { /* ... */ })

// 正确：测组件对 store 的消费
it('store 变化后组件正确渲染', () => { /* ... */ })
```

zustand 的发布订阅机制是 zustand 的事。pi-desktop 测的是"组件订阅了 store 的某个字段，store 变了组件更新了"——这是 pi-desktop 的行为，不是 zustand 的。

### 13.2 不测 CSS 具体值（在 jsdom 里）

```tsx
// 错误：jsdom 里 CSS 断言全空
expect(element).toHaveStyle({ color: 'rgb(137, 180, 250)' })

// 正确：测 CSS 类名或 data 属性
expect(element).toHaveClass('theme-dark')
// CSS 细节交给 Playwright 视觉回归
```

jsdom 不渲染样式，`toHaveStyle` 断言的是空字符串。CSS 的正确性交给 §9 的视觉回归测试。

### 13.3 不测实现细节

```tsx
// 错误：访问 React 内部 state
const { container } = render(<Counter />)
expect((container.firstChild as any)._reactInternals.memoizedState.count).toBe(0)

// 正确：测 DOM 输出
expect(screen.getByTestId('count')).toHaveTextContent('0')
```

实现细节是会变的——今天用 `useState`，明天改成 `useReducer`，内部 state 的形状就变了。但"计数显示为 0"这个 DOM 输出不会变。测输出不测内部。

### 13.4 不测框架机制本身

```tsx
// 错误：测 React useEffect 是否执行
it('useEffect 被调用', () => { /* ... */ })

// 正确：测 useEffect 执行后的效果
it('组件挂载后加载了数据', async () => {
  render(<Component />)
  await waitFor(() => {
    expect(screen.getByText('loaded')).toBeInTheDocument()
  })
})
```

React 的 useEffect 是 React 的机制，不是 pi-desktop 的逻辑。测的是"useEffect 执行后数据加载了没有"——这是 pi-desktop 的行为。React 本身好不好使，是 React 团队的事。

## 14 QA

**Q：pi 底座具体做什么？文档只说了它是"被 pi-desktop 通过 RPC 管理的独立子进程"，但没说它的职能。**

pi 底座是执行 AI 推理的独立进程——用户发消息、底座调 LLM 生成回复、底座执行工具调用。pi-desktop 是它的"壳"：负责起它、管它的生命周期、通过 JSONL RPC 收发消息、把它的输出渲染到桌面 UI。两者关系类似浏览器和渲染引擎——pi-desktop 不做 AI 推理，pi 底座不做 UI 渲染。本文不展开 pi 底座的内部机制（它有自己的代码库和文档），只从测试角度关心它的协议契约：stdin 收 JSONL 命令、stdout 吐 JSONL 响应和事件。

**Q：window.pi 上到底有哪些方法？文档没有一处集中列出全表。**

两处代码块给出了完整的方法集：§6.2 的 `test-setup.ts`（vitest 单元测试的 mock）和 §7.3 的 `e2e/mocks.ts`（Playwright 集成测试的 mock）。两处的方法集完全一致——12 个顶层键（config、sessions、themes、i18n、settings、slots、prefs、fs、git、dialog、openFile、configFile），约 30 个子方法。写测试时从这两处代码块复制 mock 模板，按需覆盖返回值。如果 `window.pi` 新增方法，两处 mock 要同步加——它们是同一份契约的两个投影。

**Q：§3 把 application 层的纯函数（resolveTheme 等）放在 Domain 章节讨论，这不是乱了层吗？**

不是。文档前言明确声明："本文的测试章节按 mock 边界划分，不按源码目录划分。" `resolveTheme` 虽然源码在 `application/theme/merge.ts`，但它是纯函数——输入 `(themeId, registry)` 输出 token 字典，零外部依赖，mock 边界和 domain 一致。所以归入 Layer 1（零 mock 纯函数测试）讨论，§5（Application 层）只标注"已在 §3.3 测过"不再重复。这是有意为之的组织方式：分类判据是"测试时需不需要 mock"，不是"源码在哪个目录"。

**Q：packages/react 里的 applyEvent 是业务逻辑还是 re-export？它不应该是"发布面"吗？**

`packages/react` 的定位是"React 组件和 hooks 的发布面"，但 `session-store.ts` 里的 `applyEvent` 确实是一个有实质逻辑的纯函数（消息列表增量应用，七种分支）。这不矛盾——发布面的含义是"插件从这里 import API"，不是说里面只能 re-export。`applyEvent` 是 `useSessionStore` 的内部实现细节，恰好因为它是纯函数，可以被直接单元测试。它的测试归入 §6.7 讨论（因为它的使用者是 plugin 组件），但测试方式是零 mock 的纯函数测试（和 domain 一致）。

**Q：fireEvent 什么时候才真正需要用？文档说"默认用 userEvent"但没给 fireEvent 的具体示例。**

三个场景用 fireEvent 而非 userEvent：1) 测事件阻止冒泡——验证"子元素 click 的 stopPropagation 不触发父级 onClick"，需要精确控制事件冒泡链；2) 测自定义事件——`element.dispatchEvent(new CustomEvent('pi-ready'))`，这种事件不在 userEvent 的模拟序列里；3) 测需要特定坐标的鼠标事件——`new MouseEvent('click', { clientX: 100, clientY: 200 })`，userEvent 的 click 不暴露坐标参数。日常 UI 交互测试（点击、输入、Tab、Enter）一律用 userEvent。

**Q：Integration（Layer 5）和 E2E（Layer 6）测同一条用户路径时，怎么分配到两层？**

判据是：这条路径要不要验证 IPC 真实性。以"用户点击会话 → 主区域加载消息"为例：如果验证的是"点击后选中态切换 + 标题更新"——前端交互正确性，归 Layer 5（mock window.pi 返回假数据，验证 React 渲染对不对）；如果验证的是"点击后 main 进程真的扫了会话文件、返回了消息列表、store 真的更新了"——跨进程链路正确性，归 Layer 6（不 mock，走真实 IPC）。同一条路径可以在两层各写一个测试，分别验证不同侧面——不冲突，不重复。

**Q：test-setup.ts 的全局 mock 和 e2e/mocks.ts 的浏览器侧 mock 要不要完全同步？**

方法集（有哪些方法）必须同步——它们是同一个 `window.pi` 契约的两个投影。默认返回值不需要同步——单元测试用空值/通用值（每个测试 `mockResolvedValueOnce` 覆盖），集成测试用真实数据（页面一加载就要有可渲染内容）。实现方式也不需要同步——单元测试用 `vi.fn()`（可断言调用次数），集成测试用裸 `async` 函数（Playwright 的 `addInitScript` 里没有 vitest）。新增 `window.pi` 方法时两边都要加，改返回值时只改对应那个。

**Q：plugin 层代码量最大但覆盖率目标最低（70%），这合理吗？**

合理。覆盖率目标按层的稳定性分配，不按代码量分配。plugin 层代码量最大（十几个插件，每个都有 UI 组件），但它是内容层——UI 组件变化频繁，今天改布局明天改交互。如果追求 95% 覆盖率，每次改 UI 都要重写一堆测试，维护成本吃掉测试收益。70% 覆盖核心交互路径（加载、点击、输入、状态切换、错误处理），放手边缘渲染细节——这是"够用就好"和"过度设计"的分界线。domain 层追求 95% 是因为纯函数不变，测了一次就一直有效。
