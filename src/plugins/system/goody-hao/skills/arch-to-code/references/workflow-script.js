// arch-to-code §7.1 — Workflow 脚本模板
//
// 这是模板，不是现成可跑的脚本。主对话从实际项目填占位符（形如 {{DOC}}）后，
// 用 Workflow 工具以 script 参数启动。脚本在后台跑，返回 task id，完成时通知主对话，
// 主对话拿返回值进 §8。
//
// 约束（Workflow 工具规则）：
//   - 纯 JS，不是 TS，不能有类型标注/接口/泛型。
//   - 脚本本身无文件系统/Node API 权限、无 Date.now/Math.random。
//   - 机械门（tsc/test）脚本自己跑不了 Bash —— 必须用 agent() 调一个跑 Bash 的 subagent 回报。
//   - agent 内部能用 Bash、能 Read/Write。多波写入不用 worktree（语义不保证合回，
//     见下 transform 注释），改用主工作区 + overlap 分组防并发写冲突。
//
// 调用原语：agent(prompt, {schema, isolation, phase, model, effort}) / parallel(thunks) /
//           log(msg) / phase(title) / budget
//
// 冻结基线：{{DOC}}（冻结 spec）+ {{IMPL_TASKS}}（§7.0 任务清单）是每轮重注入的不可变锚，
// 防目标漂移（长程实现头号失败模式）。

export const meta = {
  name: "arch-to-code-impl",
  description: "按冻结架构文档实现代码，直到无残余 gap 且机械门全绿",
  phases: [
    { title: "discover", detail: "映射每单元到真实符号" },
    { title: "transform", detail: "依赖波内按 overlap 分组实现各单元" },
    { title: "verify", detail: "机械门（agent 跑 Bash）+ spec-vs-impl gap 分类" },
    { title: "loop", detail: "重实现 partial/missing 单元直到收敛或预算耗尽" },
  ],
}

// ── 主对话填的占位符 ──────────────────────────────────────────────
const DOC = "{{DOC}}"                 // e.g. docs/arch-xxx.md  冻结 spec
const TASKS = "{{IMPL_TASKS}}"        // e.g. docs/arch-xxx.impl-tasks.md  §7.0 任务清单
const MAX_ROUNDS = 5
const GATE_TYPECHECK = "{{GATE_TYPECHECK}}"  // e.g. npx tsc --noEmit
const GATE_TEST = "{{GATE_TEST}}"            // e.g. npx vitest run

// ── Schemas ──────────────────────────────────────────────────────
const DiscoverySchema = {
  type: "object",
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          symbols: { type: "array", items: { type: "string" } },
          desiredBehavior: { type: "string" },
          acceptance: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          overlap: { type: "array", items: { type: "string" } },
        },
        required: ["id", "files", "desiredBehavior"],
      },
    },
  },
  required: ["units"],
}

const GapSchema = {
  type: "object",
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["implemented", "partial", "missing"] },
          evidence: { type: "string" },
          specAnchor: { type: "string" },
        },
        required: ["id", "status", "evidence"],
      },
    },
  },
  required: ["units"],
}

const GateSchema = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    output: { type: "string" },
  },
  required: ["pass", "output"],
}

// ── 纯 JS 辅助：拓扑排序分波 + overlap 分组 ──────────────────────
// 标准图算法，脚本内自写（非原语）。
function topoWaves(units) {
  const byId = new Map(units.map(u => [u.id, u]))
  const done = new Set()
  const waves = []
  while (done.size < units.length) {
    const ready = units.filter(u =>
      !done.has(u.id) &&
      (u.dependsOn || []).every(d => done.has(d))
    )
    if (ready.length === 0) {
      // 有环或孤立依赖，作为兜底波直接放进下一波
      const stuck = units.filter(u => !done.has(u.id))
      waves.push(stuck)
      stuck.forEach(u => done.add(u.id))
      break
    }
    waves.push(ready)
    ready.forEach(u => done.add(u.id))
  }
  return waves
}

// 波内按文件 overlap 分组：共享文件的单元必须串行（防合并冲突），不重叠的可 parallel。
function partitionByOverlap(units) {
  const groups = []
  for (const u of units) {
    const fset = new Set(u.files)
    let placed = false
    for (const g of groups) {
      const overlap = g.some(gu => gu.files.some(f => fset.has(f)))
      if (!overlap) { g.push(u); placed = true; break }
    }
    if (!placed) groups.push([u])
  }
  return groups
}

// ── 机械门：用 agent 跑 Bash 回报 pass/fail（脚本自己不能跑 Bash）──
function runGate(command, label) {
  return agent(
    `在项目里跑这条命令并只回报结果，不要修代码：\n  ${command}\n` +
    `如果退出码为 0，pass=true；否则 pass=false，把关键报错贴进 output。`,
    { schema: GateSchema, phase: "verify", effort: "low" }
  ).then(r => ({ label, pass: r.pass, output: r.output }))
}

// ── Phase 1: DISCOVER ────────────────────────────────────────────
phase("discover")
const discovery = await agent(
  `读冻结 spec ${DOC} 和实现任务清单 ${TASKS}，再看当前代码。` +
  `对每个 impl 单元，定位它真正要碰的代码符号，返回每单元的 files/symbols/desiredBehavior/acceptance/dependsOn/overlap。` +
  `这是 discover，不写代码。`,
  { schema: DiscoverySchema, phase: "discover", effort: "high" }
)
const units = discovery.units
log(`discover: ${units.length} 个实现单元`)

// ── Phase 2: TRANSFORM（依赖波；同波内不重叠单元并行）──────────
// 关键：不用 isolation:'worktree' 做多波写入——worktree 语义是"auto-cleaned if
// unchanged"，不保证自动合回主分支，跨波 agent 会看不到上一波的结果，dependsOn
// 在机械上失效。改为所有写入落到主工作区同一文件树，靠 partitionByOverlap 把共享
// 文件的单元串行（防并发写冲突），只对文件互不重叠的单元 parallel。
phase("transform")
const waves = topoWaves(units)
for (let wi = 0; wi < waves.length; wi++) {
  const wave = waves[wi]
  log(`transform 波 ${wi + 1}/${waves.length}: ${wave.length} 单元`)
  const groups = partitionByOverlap(wave) // 每组内单元共享文件
  // 组之间文件不重叠 → 并行；组内串行
  await parallel(groups.map(group => () =>
    (async () => {
      for (const unit of group) {
        await agent(
          `实现单元 ${unit.id}: ${unit.title || ""}\n` +
          `冻结 spec 锚（${unit.specAnchor || unit.id}，见 ${DOC}）—— 不得偏离，这是冻结基线。\n` +
          `要碰的文件: ${(unit.files || []).join(", ")}\n` +
          `期望行为: ${unit.desiredBehavior}\n` +
          `验收: ${unit.acceptance || "按 spec"}\n` +
          `铁律: 只改本单元声明范围内的文件；内容驱动别 kind-switch；不过度工程——只实现 spec 说的，不镀金；遵循文档架构（洋葱/开闭）。`,
          { phase: "transform", schema: GapSchema, effort: "high" }
        )
      }
    })()
  ))
}

// ── Phase 3: VERIFY ─────────────────────────────────────────────
phase("verify")
// (a) 机械门 —— 用 agent 跑 Bash（脚本自己无 Bash 权限）
let gates = await parallel([
  () => runGate(GATE_TYPECHECK, "typecheck"),
  () => runGate(GATE_TEST, "test"),
])
let tscOk = gates.find(g => g.label === "typecheck").pass
let testOk = gates.find(g => g.label === "test").pass
log(`verify 机械门: typecheck=${tscOk} test=${testOk}`)

// (b) spec-vs-impl gap 分类
const gap = await agent(
  `对比已实现代码与冻结 spec ${DOC} + 任务清单 ${TASKS}。` +
  `对每个 impl 单元分类 implemented / partial / missing，带证据（file:line）。`,
  { schema: GapSchema, phase: "verify", effort: "high" }
)
let remaining = gap.units.filter(u => u.status !== "implemented")
log(`verify: ${remaining.length} 个未完成单元`)

// ── Phase 4: LOOP 直到收敛或预算耗尽 ────────────────────────────
phase("loop")
let round = 0
while (remaining.length > 0 && budget.remaining > 0 && round < MAX_ROUNDS) {
  round++
  log(`loop 第 ${round}/${MAX_ROUNDS} 轮: 重实现 ${remaining.length} 个 partial/missing 单元`)
  // 重做未完成单元。同波逻辑：共享文件的串行，其余并行，都写主工作区。
  const groups = partitionByOverlap(remaining)
  await parallel(groups.map(group => () =>
    (async () => {
      for (const unit of group) {
        await agent(
          `单元 ${unit.id} 之前是 ${unit.status}: ${unit.evidence}。` +
          `重新实现以匹配冻结 spec 锚 ${unit.specAnchor || unit.id}（见 ${DOC}）。` +
          `冻结基线: ${DOC} + ${TASKS}，不得偏离。只改本单元范围内文件，不过度工程。`,
          { phase: "loop", schema: GapSchema, effort: "high" }
        )
      }
    })()
  ))
  // 重跑机械门 + 重分类 —— 把最新结果回写到 tscOk/testOk/remaining
  gates = await parallel([
    () => runGate(GATE_TYPECHECK, "typecheck"),
    () => runGate(GATE_TEST, "test"),
  ])
  tscOk = gates.find(g => g.label === "typecheck").pass
  testOk = gates.find(g => g.label === "test").pass
  const regap = await agent(
    `对比已实现代码与冻结 spec ${DOC} + 任务清单 ${TASKS}，对每个 impl 单元重分类 implemented/partial/missing，带证据。`,
    { schema: GapSchema, phase: "loop", effort: "high" }
  )
  remaining = regap.units.filter(u => u.status !== "implemented")
  log(`loop 第 ${round} 轮后: 剩余 ${remaining.length} typecheck=${tscOk} test=${testOk}`)
  if (remaining.length === 0 && tscOk && testOk) break
}

// ── 收敛：用循环回写后的最新门值，不是 Phase 3 的陈旧值 ─────────
const done = remaining.length === 0 && tscOk && testOk
log(`CONVERGED=${done} remaining=${remaining.length} tsc=${tscOk} test=${testOk} rounds=${round} budget_left=${budget.remaining}`)
return { done, remaining, tscOk, testOk, rounds: round }
