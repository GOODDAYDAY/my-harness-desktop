// renderer 侧 `await ctx.*` 的失败处理普查（账本 + 棘轮，r81）。
//
// ## 缺陷类（r80 在 plugin-manager 上查出的那一类的推广）
//
// 服务端 → renderer 的失败有**两种形态**：
//   ① 返回 `{ ok:false, error }` —— transport **resolve**，`await` 得到对象；
//   ② handler **抛错** —— gateway 转成 `{ok:false,error:{code:"HANDLER_ERROR",message}}`
//      （`routing/gateway.ts:61-66`），transport 据此 **reject**（`ws-transport.ts:102`）⇒ `await` **throw**。
//
// 只处理①、不处理②的调用点，在服务端抛错时的表现是：**什么都没发生**——
// 没有提示、状态不更新、后续代码全部跳过。r80 实测 plugin-manager 的 install 就是这样：
// 安装失败后按钮永久停在 installing 态、对话框不关、一点提示都没有。
//
// 本轮把普查扩到全部 renderer：实测 `await ctx.*(` 共 **72** 处，其中
// 在 try 块内 39 处、带行内 `.catch(` 4 处，**既不在 try 内也无 .catch 的 29 处**。
// 分布（按 API）：`ctx.config.set` 9、`ctx.configFile.readBinary` 4、`ctx.config.all` 3、
// `ctx.dialog.openDirectory` 2，其余各 1（plugins.list / window.isFocused / sessions.openSession /
// sessions.setContext / sessions.getLastAssistantText / configFile.writeBinary / config.getScope /
// configFile.get / dialog.writeImages / dialog.openImages / dialog.openZip）。
//
// ## 为什么是账本 + 棘轮，而不是一次改 29 处
//
// 29 处的影响面差别很大：`ctx.config.set` 失败 = 用户的设置**静默不生效**（§7.6 禁止，该修）；
// `ctx.dialog.openDirectory` 失败 ≈ 用户取消选择（多数情况无需提示）；
// `ctx.window.isFocused` 失败 = 通知策略退化为"当作未聚焦"（可接受）。
// 所以先**分类登记**（每条写清失败后果与处置），再用棘轮保证总数只减不增；
// 高影响的那组（config.set / configFile.writeBinary）标为待修，逐轮消化。
// 这与 r79 对 controllers 层中文错误的处置同一套方法。
//
// ## 判据
//
// 未保护 = `await ctx.<api>(` 既不在 `try {…}` 的花括号范围内，
// 其所在语句里也没有 `.catch(`。⚠ 必须认行内 `.catch(` 这种形态，否则会产假阳性
// （首版就漏了它，把 sub-agent / timeline 里已保护的 4 处也算成未保护）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CORPUS = ["src/plugins", "src/web"];

/** 已分类登记的未保护调用点：每条写清「失败后果」与「处置」。 */
const LEDGER: { api: string; count: number; consequence: string; disposition: "acceptable" | "todo" }[] = [
  { api: "ctx.config.set", count: 9, disposition: "acceptable",
    // r82 已修：兜底收进**框架一处**（packages/react/src/plugin-context.ts 的 config.set），
    // 失败时 announceTransient 播报 shell.configWriteFailed（role=alert 可打断）并重新抛出。
    // 所以这 9 个调用点虽然语法上仍未包 try/catch，失败**不再静默**：用户会听到/看到提示。
    // 之所以不改判据把这 9 处算成"已保护"：判据守的是"调用点自身有没有处理"，
    // 框架兜底是另一层——把它算进来会让判据失去发现"框架兜底被删"的能力（见 ⑤）。
    consequence: "设置写盘失败 ⇒ 框架级兜底播报「设置保存失败：<原因>」（role=alert），并重新抛出供调用方自行处理；不再静默" },
  { api: "ctx.configFile.writeBinary", count: 1, disposition: "acceptable",
    // r83 已修：stickers 的 create/save 走新的 mutate() 助手——失败时 announceTransient
    // 播报（role=alert 可打断）+ 仍尝试 reload() 让列表回到真实状态（不显示半截）。
    // 用的是 r82 为框架兜底建的命令式原语（本组件没有自己的瞬时提示态：flash/msg 住在
    // useStickerTransfer 里，作用域不通），本轮它有了第一个插件侧消费方，故补进发布面导出。
    consequence: "表情包图片/配置写入失败 ⇒ 播报「保存失败：<原因>」（role=alert），并 reload 让列表回到真实状态；编辑器不再卡在半提交态" },
  { api: "ctx.configFile.readBinary", count: 4, disposition: "acceptable",
    consequence: "读取失败 ⇒ 图片渲染为空（已有占位/alt），不影响其它功能；调用方多为渲染期批量读，逐条弹提示会更吵" },
  { api: "ctx.config.all", count: 3, disposition: "acceptable",
    consequence: "读取失败 ⇒ 该插件面板显示空态；用户重开面板即恢复" },
  { api: "ctx.config.getScope", count: 1, disposition: "acceptable", consequence: "stickers 分层配置读取失败 ⇒ 该层显示空态；不影响其它层，用户重开面板即恢复" },
  { api: "ctx.configFile.get", count: 1, disposition: "acceptable", consequence: "stickers 读取配置文件失败 ⇒ 表情包列表显示空态；用户重开面板即恢复，不会误以为已保存了什么" },
  // r137 删除本条目：3 处调用点已收敛到发布面原语 pickDirectory（try/catch + 播报）。
  //   原理由『多数情况是用户取消选择；真失败时对话框自身会报错』与 r136 删掉的
  //   openImages 那条**一模一样地错**：远程/浏览器宿主下对话框能力是 UNSUPPORTED_HOST，
  //   系统对话框根本没打开 ⇒ 没有任何东西会替它报错。
  //   ⚠ 这一族（dialog.openDirectory / openImages / openZip / writeImages）的理由
  //   都默认了"本地 Electron 宿主"，r136/r137 已逐条证伪其中两条；
  //   剩下的 openZip / writeImages 在 store 层（stickers-store.ts），
  //   按 r83/r84 的分层结论 store 该抛、由 UI 层兜——**待查其 UI 调用方是否兜了**（记入待办）。
  // r136 删除本条目：调用点已修（sticker-card.tsx 的 pickBanner 现在 try/catch + 播报），
  //   按 r83 的规则「调用点修好 ⇒ 删条目」。顺带更正原条目的理由——它写着
  //   『真失败时系统对话框自身会报错，用户不会误以为图片已添加』，这是**错的**：
  //   远程/浏览器宿主下对话框能力是 UNSUPPORTED_HOST，**系统对话框根本没打开**，
  //   所以没有任何东西会替它报错；而 handler 裸 await 抛错 ⇒ unhandled rejection ⇒ 零反馈。
  //   > 教训：账本里 acceptable 的理由也要能被证伪。这条理由听起来合理（本地确实如此），
  //   > 但它默认了"对话框总是能打开"，而这正是 Host 抽象存在的原因（多宿主）。
  { api: "ctx.dialog.openZip", count: 1, disposition: "acceptable",
    // r138 更正理由（原理由『真失败时系统对话框自身会报错』被 r137 的逐宿主检验证伪：
    //   远程/浏览器宿主下能力是 UNSUPPORTED_HOST，对话框根本没打开，没有东西会替它报错）。
    //   真实理由是**分层**：这处 await 在 store 层（stickers-store.ts 的 importStickersZip），
    //   按 r83/r84 的结论 store 就该把失败抛给调用方；而它的 UI 调用方
    //   stickers/renderer/index.tsx 的 doImport **确实兜住了**（try/catch + flash(…, "error")
    //   + console.error），所以用户会看到「导入失败：<原因>」。已逐行核实（r138）。
    consequence: "store 层抛出 ⇒ UI 调用方 doImport 的 try/catch 接住并 flash 错误（含原因）；远程宿主下对话框不可用也会走这条路径，不会静默" },
  { api: "ctx.dialog.writeImages", count: 1, disposition: "acceptable",
    // r138 更正理由（原理由『导出失败 ⇒ 无文件产出，用户会立刻发现』在远程宿主下不成立：
    //   点了导出什么都没发生，用户只会以为"没反应"）。
    //   真实情况更好也更该写清：这处 await 在 store 层的 `exportStickerImages` 里，
    //   而该函数**全仓零调用方**——它是 docs/plugins/project/stickers.md:106/357 明确记载的
    //   「遗留代码（已不接线，别误当功能）」之一（zip 方案上线前的旧入口，同族还有
    //   exportStickers / importStickers / importImages）。所以这条路径**用户根本走不到**。
    //   ⚠ 不删的理由：删除要同批更新文档（§5.5 结构改动随批义务），且涉及 4 个函数的整族，
    //   半删会留下更糟的"删了一半的遗留族"。已记入待办：整族一起删 + 同批改文档。
    consequence: "所在函数 exportStickerImages 全仓零调用方（文档记载的遗留死代码，用户走不到这条路径）；待整族删除时一并消失" },
  // ⚠ `ctx.plugins.list` 的条目在 r83 被**删除**（不是改成 acceptable）：
  //   那处已在调用点包了 try/catch，扫描不再命中它。账本只登记"仍然存在的未保护点"，
  //   留着一条扫不到的条目会让 ② 的腐烂检查永久红——这正是 ② 的作用（守卫自己提醒我删）。
  { api: "ctx.window.isFocused", count: 1, disposition: "acceptable", consequence: "查询失败 ⇒ 通知策略退化为按未聚焦处理（多发一条系统通知，可接受）" },
  { api: "ctx.sessions.openSession", count: 1, disposition: "acceptable", consequence: "打开失败 ⇒ 停留在当前会话；调用方另有 .catch 兜底的路径" },
  { api: "ctx.sessions.setContext", count: 1, disposition: "acceptable", consequence: "盲审 squad 流程内部步骤，失败由外层流程捕获并汇报" },
  { api: "ctx.sessions.getLastAssistantText", count: 1, disposition: "acceptable", consequence: "盲审 squad 取上一条助手文本失败 ⇒ 该轮评审拿不到素材，由外层 squad 流程捕获并在评审结果里汇报，不会静默装作成功" },
];
/** 棘轮上限（r81 实测 29）。只许减少。 */
const CEILING = 28;   // r81 基线 29 → r83 修掉 plugins.list 那处后 28（只许继续减少）

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !full.includes("/locales/")) out.push(full);
  }
  return out;
}

interface Site { file: string; line: number; api: string }

function unprotected(): Site[] {
  const out: Site[] = [];
  for (const root of CORPUS) {
    for (const f of walk(join(ROOT, root))) {
      const src = readFileSync(f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
      // try 块范围（按花括号深度）
      const ranges: [number, number][] = [];
      for (const m of src.matchAll(/\btry\s*\{/g)) {
        let i = m.index! + m[0].length - 1;
        let depth = 0;
        while (i < src.length) {
          if (src[i] === "{") depth += 1;
          else if (src[i] === "}") { depth -= 1; if (depth === 0) break; }
          i += 1;
        }
        ranges.push([m.index!, i]);
      }
      const lines = src.split("\n");
      for (const m of src.matchAll(/\bawait\s+(ctx\.[\w.]+?)\s*\(/g)) {
        const pos = m.index!;
        if (ranges.some(([a, b]) => a <= pos && pos <= b)) continue;
        const rest = src.slice(m.index! + m[0].length, m.index! + m[0].length + 240);
        const semi = rest.indexOf(";");
        const stmt = semi > 0 ? rest.slice(0, semi) : rest;
        if (stmt.includes(".catch(")) continue; // 行内 .catch 视为已保护
        out.push({ file: relative(ROOT, f), line: src.slice(0, pos).split("\n").length, api: m[1] });
      }
      void lines;
    }
  }
  return out;
}

describe("renderer 侧 await ctx.*：失败形态②（抛错/reject）的处理普查", () => {
  const sites = unprotected();
  const byApi = new Map<string, number>();
  for (const s of sites) byApi.set(s.api, (byApi.get(s.api) ?? 0) + 1);

  it("判据不空转：扫到了调用点，且行内 .catch 形态被正确排除", () => {
    expect(sites.length, `只扫到 ${sites.length} 处未保护调用（r81 实测 29）⇒ 判据可能坏了`).toBeGreaterThan(10);
    // 自检：这两处带行内 .catch，**不得**被算成未保护（首版漏了 .catch 形态就会误报）
    expect(sites.some((s) => s.file.endsWith("sub-agent/renderer/dialog-state.ts") && s.api === "ctx.sessions.openSession"),
      "自检失败：sub-agent 的 openSession 带行内 .catch(() => null)，不该被判成未保护").toBe(false);
    expect(sites.some((s) => s.file.endsWith("timeline/renderer/index.tsx") && s.api === "ctx.dialog.openFiles"),
      "自检失败：timeline 的 openFiles 带行内 .catch，不该被判成未保护").toBe(false);
    // 自检：已知的未保护点必须在（否则判据太松）
    expect(byApi.get("ctx.config.set") ?? 0, "自检失败：ctx.config.set 的未保护点一个都没扫到（r81 实测 9）").toBeGreaterThan(0);
  });

  it("① 每个未保护的 API 都已在账本里分类（未分类 = 没人判断过它失败时会怎样）", () => {
    const unclassified = [...byApi.entries()].filter(([api]) => !LEDGER.some((l) => l.api === api));
    expect(unclassified.map(([api, n]) => `${api}（${n} 处）`), [
      `${unclassified.length} 个 API 的未保护调用点未分类：`,
      "      判据：服务端 handler **抛错**时（transport 会 reject），这个调用点会发生什么？",
      "        · 用户能察觉 / 有兜底 / 等价于用户取消 ⇒ 登记为 acceptable 并写清后果；",
      "        · 静默不生效、用户以为成功了 ⇒ 登记为 todo 并逐轮消化（补 try/catch + 用户可见反馈）。",
    ].join("\n")).toEqual([]);
  });

  it("② 账本条数与实际扫到的 API 集合一致（不得有失效条目）", () => {
    const stale = LEDGER.filter((l) => !byApi.has(l.api)).map((l) => l.api);
    expect(stale, `账本里这些 API 已不再有未保护调用点（修好了就删条目或下调 count）：${stale.join(", ")}`).toEqual([]);
    const wrongCount = LEDGER.filter((l) => byApi.has(l.api) && byApi.get(l.api) !== l.count)
      .map((l) => `${l.api}: 账本 ${l.count} / 实际 ${byApi.get(l.api)}`);
    expect(wrongCount, `账本条数与实际不符（改了就要更新，否则账本失去意义）：\n      ${wrongCount.join("\n      ")}`).toEqual([]);
  });

  it("③ 棘轮：未保护调用点总数只许减少（r81 基线 29，r83 起 28）", () => {
    expect(sites.length, [
      `未保护的 await ctx.* 从 ${CEILING} 涨到了 ${sites.length}。`,
      "      新增的点在服务端抛错时会**静默失败**（无提示、后续代码跳过）。",
      "      修法：包 try/catch 并给用户可见反馈，或加行内 .catch(…) 明确兜底语义；",
      "            确实可接受的，登记进 LEDGER 并**上调该条 count 与 CEILING**（要写明理由）。",
    ].join("\n")).toBeLessThanOrEqual(CEILING);
  });

  it("⑤ 回归锚：config.set 的**框架级兜底**不得被删（删了那 9 处就又变回静默失败）", () => {
    const pc = readFileSync(join(ROOT, "packages/react/src/plugin-context.ts"), "utf-8");
    expect(pc.includes("announceTransient"), "plugin-context 里不再有 announceTransient ⇒ config.set 的失败兜底被删了").toBe(true);
    expect(/config\.set\([\s\S]{0,200}?\.catch\(/.test(pc), "config.set 的 promise 上没挂 .catch ⇒ 失败又会静默").toBe(true);
    expect(pc.includes("shell.configWriteFailed"), "兜底文案的键不见了").toBe(true);
    expect(pc.includes("throw err"), "兜底后必须**重新抛出**（吞掉会让已自己 try/catch 的调用方以为成功了）").toBe(true);
    const lr = readFileSync(join(ROOT, "packages/react/src/widgets/live-region.tsx"), "utf-8");
    expect(lr.includes("export function announceTransient"), "announceTransient（Announce 的命令式孪生）不见了").toBe(true);
  });

  it("④ 每条账本都要写清失败后果，且 todo 项必须是真会静默不生效的那类", () => {
    for (const l of LEDGER) {
      expect(l.consequence.length, `${l.api} 的后果写得太短（要说清用户会看到什么/看不到什么）`).toBeGreaterThan(12);
      if (l.disposition === "todo") {
        expect(/静默|以为/.test(l.consequence), `${l.api} 标了 todo 但后果里没说明"静默/用户以为成功"——todo 的判据就是这一条`).toBe(true);
      }
    }
    // r83：账本里最后两条 todo（plugins.list / configFile.writeBinary）都已修完 ⇒ 现在应为 0。
    // ⚠ 这条断言从 ">0" 翻成 "=0" 是**有意的**：todo 清空是进展，不是判据失效。
    //   将来若又登记了新的 todo，本条会红——那时应把它改回 >0 并在报告里说明。
    const todos = LEDGER.filter((l) => l.disposition === "todo");
    expect(todos.map((l) => l.api), "账本里仍有待修项（消化掉或说明为何搁置）").toEqual([]);
  });
});
