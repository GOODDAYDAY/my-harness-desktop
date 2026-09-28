// 能力面「谁在 renderer 侧被消费」的显式清单守卫。
//
// ## 为什么要有这条
//
// 圆心把 `BackendCapabilities` 投影成 renderer 的 `SessionCapabilities.faces`（逐轴布尔旗标，
// `projectCapabilityFlags`）。实测（r25）：**11 轴里只有 2 轴在 renderer 侧被读**
// （`retry`、`thinking`），其余 9 轴投影出去后**没有任何 renderer 消费者**——它们由
// **服务端强制**（后端不产数据 / `faceOf` 直接抛可行动错误），renderer 靠可选链隐式降级。
//
// 这个分工本身是合理的，但它是**隐含知识**：没人写下"哪一轴靠谁强制"，于是两种腐烂都可能发生——
//   ① 有人给某轴加了 renderer 控件却忘了门控（控件对缺能力的内核照样长出来 → 点了才报错）；
//   ② 有人以为"投影了就有人用"，据此推理 UI 行为（r25 就差点据此误判 `modelCycle`）。
// §6.1.3 对 boot 操作的 `phases` 字段立过同款纪律（"声明了没人读"要被抓出来），这里照搬到能力轴。
//
// ## 判据
//
// 轴清单**从圆心源码解析**（`BackendCapabilities` 接口的成员名），不硬编码——
// 加第 12 轴时这条守卫会因为"未分类"而变红，逼作者当场表态它属于哪一类。
// 两份清单必须**恰好划分**全部轴（不重不漏），且与实际扫描结果一致：
// 声明在 RENDERER_GATED 里的必须真有消费者，声明在 SERVER_ENFORCED 里的必须真没有。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BACKEND_CONTRACT = join(ROOT, "packages/shared/src/domain/backend.ts");

/** renderer 侧的扫描范围：插件 + 壳前端 + 发布面（服务端不在内——那是"服务端强制"的那一侧）。 */
const RENDERER_DIRS = ["src/plugins", "src/web", "packages/react/src"];

/** **有 renderer 门控**的轴：UI 上确实存在"按这一轴画/不画某个控件"的分支。 */
const RENDERER_GATED: Record<string, string> = {
  // timeline 的重试按钮/重试中态：`if (retrying && capabilities.faces.retry)`（两处）
  retry: "timeline 的重试动作与重试中态按本轴门控（index.tsx:733/1138）",
  // 思考档位下拉 + 「运行时切档不可用」提示：deriveThinkingLevels / shouldHintThinkingUnavailable
  thinking: "思考档位下拉是否渲染、以及切档开关是否置灰（thinking-levels.ts:31/44）",
  // r50 新增：插件管理页对「贡献了 systemPrompts 槽的插件」明示当前内核不承接
  //   （`caps.faces?.systemPrompt !== true` → `data-plugin-systemprompt-inert` 提示条）。
  //   归 renderer 门控而不是服务端强制的理由：注入发生在 spawn 期、**没有任何用户可见的反馈**，
  //   服务端"不产数据"在这里等于什么都不发生（那正是本轴要消灭的静默缺面），
  //   所以必须由 renderer 主动说出来。三态：未知（无会话）时不显示，避免误伤支持的内核。
  systemPrompt: "插件管理页对贡献 systemPrompts 的插件明示「当前内核不承接」（plugin-manager/renderer/index.tsx）",
};

/** **服务端强制**的轴：renderer 不画专门控件，缺面时后端不产数据或抛可行动错误，
 *  UI 靠可选链/空数据隐式降级。每条都要写清"缺面时用户看到什么"，否则就是静默缺面。 */
const SERVER_ENFORCED: Record<string, string> = {
  steering: "多路并发（steer/followUp）由后端排队语义决定；renderer 的队列篮不区分内核，缺面时后端不产 steering 帧",
  compaction: "无用户可点的「压缩」控件；压缩由内核自主触发，缺面时不产 compaction 事件，divider 图标自然不出现",
  snapshot: "renderer 一律 `useSessionStore(s => s.snapshot?.…)` 可选链读；缺面时后端不推 snapshot，相关展示自然为空",
  stats: "token-stats 读 store 里的 stats 投影；缺面时后端不产 stats，卡片显示占位而不是报错",
  modelCycle: "⚠ 快捷键 `timeline:cycleModel` 走的是**壳自行**在跨内核合流清单里轮转（内核做不到跨内核），"
    + "不调用内核的 cycleModel RPC；`IPC.session.cycleModel` → `faceOf(proc,'modelCycle')` 这条路径**当前生产零消费者**"
    + "（无插件调用），保留是给插件用的能力面。两者是不同操作，勿把快捷键改成走内核面（会失去跨内核轮转）",
  toolExec: "命令直投是插件权限面（`rpc:bash`）；无此面的内核由 `faceOf` 抛可行动错误，UI 侧没有常设控件",
  busFrames: "总线工人会话的上行帧由后端产生；缺面时不产帧，相关卡片自然不出现",
  questions: "提问卡由后端 `injectQuestion` 驱动；缺面时不产提问，卡片自然不出现（不是『隐藏一个按钮』）",
  fileBacked: "文件态与否决定 fork/物化路径，全在服务端；renderer 不按本轴画控件",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "out" || name.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** 从圆心源码解析 `BackendCapabilities` 的成员名（= 全部能力轴）。 */
function axesFromContract(): string[] {
  const src = readFileSync(BACKEND_CONTRACT, "utf-8");
  const start = src.indexOf("export interface BackendCapabilities {");
  expect(start, "找不到 BackendCapabilities 接口——契约改名了？").toBeGreaterThan(-1);
  const body = src.slice(start);
  const end = body.indexOf("\n}");
  const members = body.slice(0, end);
  const out: string[] = [];
  for (const line of members.split("\n")) {
    const m = /^\s{2}([a-zA-Z][a-zA-Z0-9]*)\?\s*:/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** 扫 renderer 侧对某一轴的真实消费（`faces.<axis>` 或 `faces["<axis>"]`）。 */
/** 消费点判据要认得**全部三种**访问形态（r50 补第三种）：
 *  ① `faces.retry`（点访问）  ② `faces["retry"]`（下标访问）  ③ `faces?.retry`（**可选链**）。
 *  首版只认 ①②，于是我按 ③ 写的消费者（`caps.faces?.systemPrompt`）被判成"空头声明"——
 *  与 r47 那次同一类错误：判据漏一种表达形态，就会把活代码指认为死代码。
 *  可选链在这里不是风格问题而是**必需**：`faces` 在能力面尚未就绪时可能是空对象，
 *  而三态语义（未知 / 支持 / 不支持）要求区分"没取到"与"取到了且为假"。 */
/** 消费点判据的正则（单独抽出来，好让自检直接测**真判据**，而不是另抄一份正则）。
 *  要认得三种访问形态：① `faces.retry`（点） ② `faces["retry"]`（下标） ③ `faces?.retry`（**可选链**）。
 *  首版只认 ①②，于是按 ③ 写的消费者（`caps.faces?.systemPrompt`）被判成"空头声明"——
 *  与 r47 同一类错误：判据漏一种表达形态，就会把活代码指认为死代码。
 *  可选链在这里不是风格而是**必需**：能力面尚未就绪时 `faces` 是空对象，
 *  而三态语义（未知 / 支持 / 不支持）要求区分"没取到"与"取到了且为假"。 */
function consumerRx(axis: string): RegExp {
  // ⚠ 两侧都要有边界：右侧 `\\b` 挡住 `faces.retryExtra`，左侧 `(?<![\\w$])` 挡住
  //   `myfaces?.retry` 这类同后缀标识符。首版没有左边界，是自检的反向用例把它抓出来的
  //   （判据过宽 ⇒ "有消费者"更容易恒真 ⇒ 守卫变松）。
  return new RegExp(`(?<![\\w$])faces\\s*\\??\\.\\s*${axis}\\b|(?<![\\w$])faces\\s*\\[\\s*["']${axis}["']\\s*\\]`);
}

function rendererConsumers(axis: string): string[] {
  const rx = consumerRx(axis);
  const hits: string[] = [];
  for (const dir of RENDERER_DIRS) {
    for (const f of walk(join(ROOT, dir))) {
      const src = readFileSync(f, "utf-8");
      if (rx.test(src)) hits.push(relative(ROOT, f));
    }
  }
  return hits;
}

describe("能力面：每一轴的强制方（renderer 门控 / 服务端强制）都被显式声明且与实际一致", () => {
  const axes = axesFromContract();

  it("判据不空转：确实从圆心解析出了轴，且 renderer 侧确实扫到了文件", () => {
    expect(axes.length, "一个轴都没解析到 = 正则或路径错了（假绿）").toBeGreaterThanOrEqual(10);
    const files = RENDERER_DIRS.flatMap((d) => walk(join(ROOT, d)));
    expect(files.length, "renderer 侧一个文件都没扫到 = walk 坏了").toBeGreaterThan(100);
    // 自检：已知的两个消费点必须被扫出来（否则判据本身失效）
    expect(rendererConsumers("thinking").length, "自检失败：thinking 明明有消费者却扫不到").toBeGreaterThan(0);
  });

  it("两份清单**恰好划分**全部轴（不重不漏；加新轴必须当场表态归哪一类）", () => {
    const gated = Object.keys(RENDERER_GATED);
    const enforced = Object.keys(SERVER_ENFORCED);
    const overlap = gated.filter((a) => enforced.includes(a));
    expect(overlap, `同一轴不能既算 renderer 门控又算服务端强制：${overlap.join(", ")}`).toEqual([]);
    const unclassified = axes.filter((a) => !gated.includes(a) && !enforced.includes(a));
    expect(unclassified, `新增的能力轴未分类——请判断它靠谁强制并写进对应清单：${unclassified.join(", ")}`).toEqual([]);
    const unknown = [...gated, ...enforced].filter((a) => !axes.includes(a));
    expect(unknown, `清单里有圆心已不存在的轴（契约删了轴，清单要跟着删）：${unknown.join(", ")}`).toEqual([]);
  });

  it("自检：消费点判据认得全部三种访问形态（点 / 下标 / 可选链）", () => {
    // 判据漏一种形态就会把活代码指认为死代码（r47 的 modelCycle/toolExec、r50 的 systemPrompt
    // 都是这么被误判的）。三种形态各钉一条，且要钉在**真实的轴名**上（用合成轴名测不出
    // 正则里 `${axis}` 插值那一段是否写对）。
    const probe = "retry";
    for (const sample of [`faces.${probe}`, `faces["${probe}"]`, `faces?.${probe}`, `caps.faces?.${probe} !== true`]) {
      expect(consumerRx(probe).test(sample),
        `判据认不出 ${sample}`).toBe(true);
    }
    // 反向：这些**不该**被当成消费点（否则判据过宽，"有消费者"就恒真）
    for (const bad of [`facesX.${probe}`, `faces.${probe}Extra`, `myfaces?.${probe}`, `${probe}: true`]) {
      expect(consumerRx(probe).test(bad), `${bad} 不该被判成消费点`).toBe(false);
    }
  });

  it("声明为「renderer 门控」的轴必须真有消费者（否则是空头声明）", () => {
    const problems: string[] = [];
    for (const axis of Object.keys(RENDERER_GATED)) {
      const hits = rendererConsumers(axis);
      if (hits.length === 0) problems.push(`${axis}（清单说它有 renderer 门控，但扫不到 faces.${axis} 的消费点）`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("声明为「服务端强制」的轴必须**真没有** renderer 消费者（有人加了门控就要改分类）", () => {
    const problems: string[] = [];
    for (const axis of Object.keys(SERVER_ENFORCED)) {
      const hits = rendererConsumers(axis);
      if (hits.length > 0) {
        problems.push(`${axis} 已被 renderer 消费（${hits.join(", ")}）——它不再是纯服务端强制，请移到 RENDERER_GATED 并写清门控点`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("每条声明都带**理由**（不能只列轴名；理由要能说清缺面时用户看到什么）", () => {
    for (const [list, name] of [[RENDERER_GATED, "RENDERER_GATED"], [SERVER_ENFORCED, "SERVER_ENFORCED"]] as const) {
      for (const [axis, why] of Object.entries(list)) {
        expect(typeof why === "string" && why.length >= 12, `${name}.${axis} 的理由太短或不是字符串（当前：${JSON.stringify(why)}）`).toBe(true);
      }
    }
  });
});

// ── 全仓能力契约普查：**每一个字段都必须有消费者**（r47）────────────────────────
//
// 为什么单立这一条：r46 在 `KernelExtensionCapabilities` 里查出 `update` / `reorder` 两轴
// ——三个内核都老实声明了 `false`，但全仓**零消费者**（UI 与 controller 都不读）。
// 死轴不是"无害的冗余"，它**有害**：读到 `{update:false, reorder:false}` 的人会以为
// UI 据此做了降级，实际什么也没发生。而 `minimal-extension.ts` 的文件头正写着
// 「壳据此置灰入口」——注释、契约、UI 三者互相不一致。
//
// 这条守卫就是 r46 定下的纪律的棘轮：**能力轴与它的消费者必须同一批落地**，
// 不加"为将来准备"的轴。
//
// ⚠ 判据的关键（r47 实踩）：**消费有两种语法形态**，只认一种会把活轴误判成死轴。
//   ① 点访问 `capabilities.<轴>` / `caps?.<轴>` —— renderer 与投影层用；
//   ② **字符串字面量** `viaFace("<轴>", …)` / `faceOf(proc, "<轴>", …)` —— application 层用
//      （CLAUDE.md §1.5：按轴取面的助手，轴名是字符串参数）。
//   首版只认①，于是把 `BackendCapabilities.modelCycle` 与 `.toolExec` 报成死轴——
//   而它们分别撑着 `cycleModel()`（模型轮转，默认键位 mod+shift+…）与 `bash()/abortBash()`
//   （命令直投）。**信了就会删掉两条活轴、打断两个功能**。
//   自检里把这两条钉住：判据一旦退回"只认点访问"，自检立刻红。
//   而"声明"是冒号形态（`modelCycle: this`），既不是点也不是引号，天然不被计入消费。

const CAPABILITY_INTERFACES = [
  "BackendCapabilities", "SessionCapabilities", "KernelModelsCapabilities",
  "KernelExtensionCapabilities", "SkillCapabilities", "ThinkingCapabilities",
  "SteeringCapabilities", "RetryCapabilities", "CompactionCapabilities",
  "SnapshotCapabilities", "StatsCapabilities", "ModelCycleCapabilities",
  "ToolExecCapabilities", "BusFrameCapabilities", "QuestionChannelCapabilities",
] as const;

/** 从圆心/发布面解析出每个能力契约的**顶层字段**（嵌套对象里的成员不算独立轴）。 */
function capabilityFields(): { iface: string; field: string; declFile: string }[] {
  const out: { iface: string; field: string; declFile: string }[] = [];
  const roots = ["packages/shared/src", "packages/react/src", "src/server"].map((d) => join(ROOT, d));
  const srcs: { file: string; text: string }[] = [];
  for (const r of roots) for (const f of walk(r)) srcs.push({ file: f, text: readFileSync(f, "utf-8") });
  for (const iface of CAPABILITY_INTERFACES) {
    const hit = srcs.find((x) => new RegExp(`export interface ${iface}\\s*\\{`).test(x.text));
    if (!hit) continue;
    const m = new RegExp(`export interface ${iface}\\s*\\{`).exec(hit.text)!;
    let i = m.index + m[0].length;
    let depth = 1;
    const body: string[] = [];
    while (i < hit.text.length && depth > 0) {
      const c = hit.text[i];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      if (depth > 0) body.push(c);
      i += 1;
    }
    const txt = body.join("").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const raw of txt.split("\n")) {
      const st = raw.trim();
      if (!st || st.startsWith("//") || st.startsWith("*")) continue;
      // ⚠ 两种成员语法都要认：属性式 `fileBacked: boolean;`，以及**方法式**
      //   `steer(text: string): Promise<void>;`（Steering / Retry / Compaction / Snapshot 等都是这一形态）。
      //   首版只认属性式，15 个契约只解析到 7 个——漏掉的恰恰是方法式那批，
      //   而它们同样可能变成死轴（声明了却没人调）。
      const fm = /^(\w+)\??\s*[:(]/.exec(st);
      if (fm) out.push({ iface, field: fm[1], declFile: relative(ROOT, hit.file) });
    }
  }
  return out;
}

/** 生产代码语料（排除测试与 locale）。 */
function prodCorpus(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const base of ["src", "packages/shared/src", "packages/react/src"]) {
    const root = join(ROOT, base);
    if (!existsSync(root)) continue;
    for (const f of walk(root)) {
      const rel = relative(ROOT, f);
      if (/\.test\./.test(rel) || rel.includes("/locales/")) continue;
      out.push({ file: rel, text: readFileSync(f, "utf-8") });
    }
  }
  return out;
}

describe("全仓能力契约普查：每个字段都必须有消费者（不留死轴）", () => {
  const fields = capabilityFields();
  const corpus = prodCorpus();

  it("判据不空转：15 个契约都解析到了，且字段数与已知事实一致", () => {
    const ifaces = new Set(fields.map((f) => f.iface));
    expect(ifaces.size, `只解析到 ${ifaces.size} 个契约（应 ${CAPABILITY_INTERFACES.length} 个）——解析器坏了或契约改名了`).toBe(CAPABILITY_INTERFACES.length);
    // r47 实测：15 个契约共 44 个字段（含**方法签名**形态的成员）。
    // ⚠ 阈值要按真实规模卡死：首版写成 >=24 是因为解析器漏了方法签名那批（只数到 26），
    //   那样即使解析器再次退化也测不出来。
    expect(fields.length, `字段总数 ${fields.length}（r47 实测 44）——少了说明解析器漏了某种成员语法`).toBeGreaterThanOrEqual(44);
    expect(corpus.length, "语料文件数异常").toBeGreaterThan(200);
  });

  it("① 每个能力字段都至少有一个消费者（点访问 **或** 字符串字面量轴名）", () => {
    const dead: string[] = [];
    for (const { iface, field } of fields) {
      // 消费 = `.field` 或 `"field"`/`'field'`；声明 = `field:`（冒号），不计入
      const read = new RegExp(`(\\.\\s*|["\'])${field}(?![\\w$])`);
      if (!corpus.some((c) => read.test(c.text))) dead.push(`${iface}.${field}`);
    }
    expect(dead, `死轴 ${dead.length} 条（声明了但全仓无人读取）：\n      ${dead.join("\n      ")}\n      → 要么补上消费者，要么删掉这条轴（§1.5：轴与消费者同批落地）`).toEqual([]);
  });

  it("② 自检：判据必须认得**字符串字面量**这种消费形态（否则会误删活轴）", () => {
    // modelCycle 撑着 cycleModel()（模型轮转）、toolExec 撑着 bash()/abortBash()（命令直投），
    // 两者都只经 `viaFace("<轴>", …)` 消费，**点访问数为 0**。
    for (const axis of ["modelCycle", "toolExec"]) {
      const dotOnly = corpus.filter((c) => new RegExp(`\\.\\s*${axis}(?![\\w$])`).test(c.text)).length;
      const quoted = corpus.filter((c) => new RegExp(`["\']${axis}(?![\\w$])`).test(c.text)).length;
      expect(dotOnly, `${axis} 的点访问数应为 0（它是经字符串轴名消费的）——若不是 0，说明本自检的前提变了，要重新核实`).toBe(0);
      expect(quoted, `${axis} 必须有字符串字面量形态的消费者，否则它真的成了死轴`).toBeGreaterThan(0);
    }
  });

  it("③ 自检：判据不会把「声明」当成消费（否则死轴永远查不出来）", () => {
    // pi-backend.ts 里 `modelCycle: this, toolExec: this, …` 是**声明**（冒号形态）。
    // 若判据把冒号也算消费，①就恒真、守卫失效。
    const declOnly = "readonly capabilities = { modelCycle: this, toolExec: this };";
    for (const axis of ["modelCycle", "toolExec"]) {
      const read = new RegExp(`(\\.\\s*|["\'])${axis}(?![\\w$])`);
      expect(read.test(declOnly), `判据把纯声明当成了消费（${axis}）⇒ ① 会恒真`).toBe(false);
    }
  });
});
