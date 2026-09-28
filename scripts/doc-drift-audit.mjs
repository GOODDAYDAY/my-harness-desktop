#!/usr/bin/env node
// 文档漂移审计(门:退役符号标注) + 报告段(「现状」列是否过期)
// 原题:已退役符号出现在 docs 里时,必须让读者看得出"这是旧的"。
// 用法:node scripts/doc-drift-audit.mjs
//
// 定位:**阻断门**(违规则 exit 1)。
// 演进:它一开始是**报告**——因为首跑 31 处红,让一个开场就红的检查进 CI 只有两个结局:
// 被关掉,或逼出一轮潦草的批量替换(会污染本来正确的历史叙述)。清单消化到 0 之后才升级为门。
// 判据两层(都客观,不做语义判断):① 命中行 ±10 行内有标记;② 文件头 15 行内有标记(=全文横幅)。
// **不用"任意位置出现标记即过"**:那样文件里有个"迁移"就满足,会从第一天恒绿——假守卫比没有更坏
// (skills §10.3 第 5 条:弱断言最坏的不是漏报,是让人以为有守卫)。
//
// 为什么需要它:插件化/中性化改掉了一批符号(KERNEL_IDS、capabilities.pi/dsh、字面量联合…),
// 代码侧有编译器和 audit:deps 兜着,**文档侧没有任何东西兜** —— 结果就是参考手册(glossary)在
// 教读者用一个已经不存在的字段。这类漂移靠人肉发现不可持续(实测全仓 97 处命中)。
//
// 判据(**段落级**,不是行级也不是 40 行窗口):命中行的**所在段落**(空行分隔)里必须出现
// "历史标记词"之一。理由:对照式表述("此前是 X,现改为 Y")通常同段就带标记;而把它当现状
// 陈述的段落(如"壳经 backend.capabilities.pi 探测")通段没有 —— 后者正是要抓的漂移。
// 行级判据太松(会放过跨句的漂移),固定窗口太严(会把相邻段的标记借来,产生假绿)。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 已退役符号 → 现行替代(仅用于报错信息里给出路,不参与判定)。 */
const RETIRED = [
  ["KERNEL_IDS", "内核清单改由 KernelRegistry 运行时驱动(registry.ids())"],
  ["createMinimalBackend", "内核经 plugin.json + factory 注册(KernelPlugin)"],
  ["createMinimalCatalog", "同上:工厂由 plugin 暴露"],
  ["capabilities.pi", "逐轴中性能力面 capabilities.<轴>（BackendCapabilities）"],
  ["capabilities.dsh", "中性能力名 capabilities.thinking / .fileBacked"],
  ['KernelId = "pi" | "dsh"', "KernelId = string(不透明 id)"],
  // ↓ 这两条是**由 scripts/doc-symbol-audit.mjs 发现的**:它们在中性化里退役,
  //   但手写表当初没收——"清单靠人记得更新"的失效形态就此现形。机制:符号审计**发现**退役名,
  //   本表**强制**它们被标注。新退役一个符号时,先跑 `npm run audit:symbols` 看候选。
  ["DshCapabilities", "中性能力类型 ThinkingCapabilities"],
  ["PiBackendExtensions", "圆心逐轴能力面 BackendCapabilities（steering/snapshot/stats/… ）"],
  // ↓ 同样由 audit:symbols 的**优先层**发现(名字带内核 token + 0 命中):
  ["PiLogo", "KernelPlugin.logo 经 buildKernelSurfaces 投影（KernelSurfaces.logos）"],
  ["DshLogo", "同上：logo 由各内核插件自报，壳不再有静态表"],
  // ↓ 本轮退役（内核目录自包含 + 能力面分轴）：
  ["BackendExtensions", "圆心逐轴能力面 BackendCapabilities；pi-backend-extensions.ts 已删除"],
  ["capabilities.extensions", "逐轴探测 capabilities.<轴>（steering/retry/compaction/snapshot/stats/modelCycle/toolExec/busFrames/questions/thinking）"],
  ["pi-backend-extensions", "文件已删：形状上移为圆心 BackendCapabilities 的各轴接口"],
  ["SessionCapabilities.extension", "逐轴旗标 SessionCapabilities.faces + 成员级 thinkingCycle / levelsSemantics"],
  ["KERNEL_LOGOS", "KernelSurfaces.logos（由 KernelPlugin.logo 经 buildKernelSurfaces 投影）"],
  ["getKernelLogo", "同上；该函数零消费者，已随 kernel-logos.ts 删除"],
  ["kernel-factories", "各内核自己的 <id>/backend/<id>-backend-factory.ts（共享装配点已删，检验⑪ 守住）"],
  ["kernel-managers", "各内核自己的 <id>/manager/（createDshKernelManager 归 dsh；createPiKernelManager 是死代码已删）"],
  ["createPiKernelManager", "零消费者的死代码，已删（pi 插件工厂直接 new PiKernelManager(PI_SPEC, installDir)）"],
  ["asPi(", "SessionStore.faceOf(proc, 轴, 标签)：按语义轴取能力面，错误消息点名轴不点名内核"],
  ["piSend(", "SessionStore.viaFace(轴, 标签, fn)：同上，并保留 rpcError 上报"],
  // ↓ 发布面命名迁移（Phase B）退役的符号：
  ["PiExtensions", "12 个方法按语义域归位到 MessagingApi / ModelApi / SessionsApi（getModels 那份重复定义已删）"],
  ["ctx.pi", "按域归位：ctx.messaging（steer/followUp/两个 mode/abortRetry/setAutoRetry）、ctx.models（cycleModel/getThinkingLevels/cycleThinkingLevel）、ctx.sessions（compact/setAutoCompaction/getLastAssistantText）"],
  ["sessions.pi", "原始 IPC 面已平铺为 window.kernel.sessions.<method>（每个方法本就有自己的 channel，分组不提供信息）"],
  ["DshConfigApi", "下移到 kernel/dsh/backend/dsh-config-contract.ts（dsh 内部契约）；壳只认中性 KernelConfigApi"],
  ["DshProvider", "同上（dsh 内部契约）；壳侧的 import 经核实是死 import，已删"],
  ["DshModelSpec", "同上"],
  ["DshDefaultModel", "同上"],
  ["PiSettingsApi", "下移到 kernel/pi/manager/pi-settings-contract.ts（pi 内部契约）；壳只认中性 KernelConfigApi"],
  ["fitPiExtensionAvailable", "toolFilterEnforced（换轴 + 中性名）——问「该内核能否强制执行工具白名单」，每个内核按自己的机制回答"],
  ["fitExtensionAvailable", "toolFilterEnforced——中间态：改了名但仍问错问题（「桌面适配扩展装没装」只是某一个内核的手段，不是能力本身）"],
];

/** 段落里出现任一即视为已标注(读者能看出这是旧的/这是改动对照)。 */
const MARKERS = [
  "历史", "已删", "已退役", "退役", "替代", "改为", "改掉", "迁移", "推翻",
  "曾经", "此前", "旧格式", "旧版", "报废", "kernel-plugin", "插件化", "不再",
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

const violations = [];
let hits = 0;
for (const file of walk(join(ROOT, "docs"))) {
  // **排除 docs/legacy/**:那是冻结的历史归档(旧设计快照),退役符号天然住在里面——
  // 拿它当"未标注违规"会制造**没法修**的红(不能去改冻结归档)。下面报告段早就排了,
  // 门这边原来没排:现在 legacy 恰好 0 处命中所以看不出问题,再退役一个符号就会无故红。
  if (file.includes("/legacy/")) continue;
  const text = readFileSync(file, "utf-8");
  const lines = text.split("\n");
  const fileHits = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const [symbol, replacement] of RETIRED) {
      if (!lines[i].includes(symbol)) continue;
      hits += 1;
      // 判据 = **命中行 ±10 行窗口内**有标记。客观、可复算;不借整段的标记(会假绿),
      // 也不做语义判断(机器给不了,硬做只会假红)。
      // 判据(两层,都是客观的):
      //  ① 命中行 ±10 行窗口内有标记;或 ② 文件头 15 行内有标记(== 全文横幅)。
      // 为什么加 ②:文档级横幅("⚠️ 历史文档…")本来就是**覆盖全文**的宣告,读者也这么理解它;
      // 只认 ① 会把「整篇都是历史」的文档逐行报红(实测 add-new-kernel.md 的头部横幅够不到第 19 行)。
      // 而"任意位置出现标记"那种更松的判据会**从第一天就恒绿**(见文件头注释),不采用。
      const win = lines.slice(Math.max(0, i - 10), Math.min(lines.length, i + 11)).join("\n");
      const banner = lines.slice(0, 15).join("\n");
      if (!MARKERS.some((m) => win.includes(m)) && !MARKERS.some((m) => banner.includes(m))) {
        fileHits.push([i + 1, symbol, replacement]);
      }
    }
  }
  if (fileHits.length === 0) continue;
  // 文件级判据(而不是行/段级):**提到退役符号的文件,必须某处有标注**。
  // 为什么不用段落级:很多段落是"整段分析旧状态"(如 add-new-kernel.md 的「接缝是脏的」),
  // 通段没有标记词却并不误导——那是**语义判断**,机器给不了;硬做只会产生假红被人关掉。
  // 文件级判据客观、可执行:每份文件加一句头部说明即可,且足以拦住"参考手册教已退役 API"这类真伤害。
  for (const [ln, symbol, replacement] of fileHits) {
    violations.push(`${file.replace(ROOT + "/", "")}:${ln} \`${symbol}\` 附近 10 行内无标注 → ${replacement}`);
  }
}

console.log(`文档漂移审计(退役符号 ${hits} 处命中,均需标注): ${violations.length} 处未标注`);
for (const v of violations) console.log("  " + v);

// ── 报告段(不进 exit code):**「现状」列会随改动落地而过期**。
// 判据:文档里出现「现状/终态」「现状/新模型」这类对照,或 `### … 现状 …` 小节,却**全文没有任何**
// 过期标记 → 提示复核。为什么只报不拦:这是**语义判断**(该改动可能还没落地,那"现状"就是对的),
// 机器判不了;而且它一定会有假阳性。实测这一类确实存在(atomic-send.md / kernel-forkless-branch.md
// 都已过期且无标记,符号尺子扫不出——它们没有"找不到的符号",只有"不再成立的断言")。
// `已核` 是**出口**:人工核过、确认"现状"仍准确 → 在文档里加一句"（现状已核,无需标记）"即从报告消失。
// 没有出口的报告会每轮重列同样的清单,很快被当成噪声忽略——这正是守卫失效的另一种形态。
  const STALE_MARKERS = ["已过期", "已被取代", "已落地", "改动前", "写稿时", "历史文档", "勿当现状", "现状已核",
    // ↓ 这些是**作者已经写过的**历史标注的别的措辞(实测有文档用"…之前的历史格局…作为决策背景保留")
    "作为决策背景保留",
    // "旧方案" 是本文档体系里常用的**显式新旧对照**标签(实测 skills-layering.md 反复用)
    "旧方案"];
const staleSuspects = [];
for (const file of walk(join(ROOT, "docs"))) {
  if (file.includes("/legacy/")) continue;
  const text = readFileSync(file, "utf-8");
  const hasBaseline = /\|\s*现状\s*\|/.test(text) || /^#{2,4}[^\n]*现状[^\n]*$/m.test(text);
  if (!hasBaseline) continue;
  if (STALE_MARKERS.some((m) => text.includes(m))) continue;
  staleSuspects.push(file.replace(ROOT + "/", ""));
}
if (staleSuspects.length > 0) {
  console.log(`\n[报告] 含「现状」对照但无过期标记的文档 ${staleSuspects.length} 份(需人工判:改动是否已落地?):`);
  for (const f of staleSuspects) console.log("  · " + f);
}
process.exit(violations.length > 0 ? 1 : 0);

