// zh-TW 语言包「**大陆术语**残留」守卫（术语层，与字形层互补）。
//
// ## 为什么已有的两个守卫抓不到这一类
//
// `locale-zhtw-simplified.test.ts` 的判据是「zh-TW 值与 zh-CN 值**完全相同** 且 含**简体专用字**」。
// 本轮修的那批文案两条都不满足：它们**已经是繁体字形**（`內核`/`插件`/`配置`/`默認`），
// 只是用的是**大陆的术语**。繁体用户看到的是"字形对、用词不对"的界面——
// 例如「內核」台湾说「核心」、「插件」说「外掛」、「默認」说「預設」、「加載」说「載入」。
// 功能不报错、页面不崩，字形守卫也全绿，是典型的**静默质量缺陷**。
//
// `locale-terminology.test.ts` 守的是另一件事（「底座」→「内核」这个**跨语言**的产品术语统一），
// 与这里的**两岸用语差异**不是一回事：那边要求四种语言都用同一个词，这边要求 zh-TW 用台湾的词。
//
// ## 最硬的修改依据不是"外部偏好"，而是**同一语言包内部的自相矛盾**
//
// 实测：修之前 zh-TW 里 `訊息` 出现 30 次、`消息` 4 次；`預設` 已在用、`默認` 还有 15 次；
// `核心` 与 `內核` 并存。也就是说译者大部分时候已经在用台湾术语，剩下的是**漂移**，
// 不是风格选择。修完 121 处后这些词在 zh-TW 里各自只剩一种写法。
//
// ## 判据分两类，因为有一类词**同形异义**
//
// HARD（大陆专用词，硬零）：这些词在界面语境里只有一种意思，出现即为漂移。
// LEDGER（同形异义词，账本制）：同一个词在别的语境里是**正确的台语用法**，不能一刀切——
//   · `項目`：作 "item" 解时台语也说「項目」（`拖曳列表項目時`）；只有作 "project" 解才该写「專案」。
//   · `用戶`：`用戶端` 是 client 的台语标准词，不能改成「使用者端」。
//   · `文件`：台语的「文件」= document（大陆的「文件」= file 才该写「檔案」）。
//   · `信息`：台语的「信息」= message/signal（information 才该写「資訊」）。
//   ⚠ 这四个词**不能**放进 HARD：盲目替换会改错意思（r10 批量替换把德语的性数一致弄坏过，
//   同一个教训）。账本按 (文件, key, 词) 精确登记，且**双向检查**：
//   账本里的条目必须仍然存在（修好了就要从账本删掉，否则账本腐烂），
//   账本外的出现一律违规（新增必须当场判断是哪种意思）。

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
// ⚠ 扫描范围**含 test-plugins**：minimal 内核插件住在那里，它的语言包同样会显示给用户
//   （测试剧本把它种进隔离 HOME 后，设置页就有 Minimal 页签）。首版只扫 src/plugins，
//   于是 minimal 的 zh-TW 里 16 处大陆术语从旁边溜了过去（r29 实踩）。
const SCAN_ROOTS = [join(ROOT, "src/plugins"), join(ROOT, "test-plugins")];

/** 大陆专用词 → 台语对应。每条都带理由（理由要能说清"为什么台语不这么说"）。 */
const HARD: Record<string, { tw: string; why: string }> = {
  插件: { tw: "外掛", why: "台湾说「外掛」/「外掛程式」；「插件」是大陆用法" },
  內核: { tw: "核心", why: "kernel 在台湾作「核心」（Linux 核心）；「內核」是大陆术语" },
  配置: { tw: "設定", why: "界面语境台湾一律「設定」；「配置」偏大陆工程口语" },
  默認: { tw: "預設", why: "「默認」在台湾极少用于界面，一律「預設」" },
  加載: { tw: "載入", why: "load 在台湾作「載入」；「加載」是大陆写法" },
  存儲: { tw: "儲存", why: "storage/store 在台湾作「儲存」" },
  數據: { tw: "資料", why: "data 在台湾界面作「資料」；「數據」偏数值统计义" },
  消息: { tw: "訊息", why: "message 在台湾作「訊息」（本语言包已 30 次用「訊息」，4 次用「消息」＝漂移）" },
  字符串: { tw: "字串", why: "string 在台湾作「字串」" },
  硬件: { tw: "硬體", why: "hardware 在台湾作「硬體」（字形也不同）" },
  軟件: { tw: "軟體", why: "software 在台湾作「軟體」" },
  文件夾: { tw: "資料夾", why: "folder 在台湾作「資料夾」" },
  視頻: { tw: "影片", why: "video 内容在台湾作「影片」；「視頻」指影像信号技术" },
  網絡: { tw: "網路", why: "network 在台湾作「網路」" },
  服務器: { tw: "伺服器", why: "server 在台湾作「伺服器」" },
  屏幕: { tw: "螢幕", why: "screen 在台湾作「螢幕」" },
  鼠標: { tw: "滑鼠", why: "mouse 在台湾作「滑鼠」" },
  變量: { tw: "變數", why: "variable 在台湾作「變數」" },
  激活: { tw: "啟用", why: "activate 在台湾界面作「啟用」" },
};

/** 同形异义词的账本：这些 (文件, key, 词) 是**正确的台语用法**，登记理由后豁免。 */
const LEDGER: { plugin: string; key: string; term: string; why: string }[] = [
  { plugin: "system/general-config", key: "settings.floatCardDesc", term: "項目",
    why: "此处「列表項目」「該項目」是 item 义，台语同样说「項目」（project 义才写「專案」，那 3 处已改）" },
  { plugin: "system/i18n", key: "settings.otherFields", term: "項目",
    why: "「沒有預設說明的項目」是 entry/item 义，非 project" },
  { plugin: "system/i18n", key: "settings.noSchemaFields", term: "項目",
    why: "「可編輯的設定項目」是 item 义，非 project" },
  { plugin: "system/remote-access", key: "remote.devicesDesc", term: "用戶",
    why: "「用戶端」是 client 的台语标准词，改成「使用者端」反而不对" },
];
const AMBIGUOUS = ["項目", "用戶", "文件", "信息"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".json")) out.push(full);
  }
  return out;
}

interface Entry { plugin: string; key: string; value: string }
function collect(): Entry[] {
  const out: Entry[] = [];
  const files = SCAN_ROOTS.flatMap((r) => (existsSync(r) ? walk(r) : []));
  for (const f of files) {
    if (!f.includes("/locales/zh-TW/")) continue;
    const root = SCAN_ROOTS.find((r) => f.startsWith(r + "/"))!;
    const plugin = relative(root, f).split("/locales/")[0];
    let d: Record<string, unknown>;
    try { d = JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown>; } catch { continue; }
    for (const [k, v] of Object.entries(d)) if (typeof v === "string") out.push({ plugin, key: k, value: v });
  }
  return out;
}

const entries = collect();
const inLedger = (e: Entry, term: string): boolean =>
  LEDGER.some((l) => l.plugin === e.plugin && l.key === e.key && l.term === term);

describe("zh-TW 语言包：大陆术语残留（术语层，字形守卫的盲区）", () => {
  it("判据不空转：确实扫到了 zh-TW 语言包，且每个 HARD 词都能在合成样本上被检出", () => {
    expect(entries.length, "一条都没扫到 = 路径或 walk 坏了（假绿）").toBeGreaterThan(400);
    const files = new Set(entries.map((e) => e.plugin));
    expect(files.size, "扫到的插件数太少，判据可能空转").toBeGreaterThanOrEqual(10);
    // 自检：每个 HARD 词都要能被检出（否则某条规则写错了也不会被发现）
    for (const term of Object.keys(HARD)) {
      const fake: Entry = { plugin: "x", key: "y", value: `前綴${term}後綴` };
      expect(fake.value.includes(term), `自检失败：${term} 的检出逻辑无效`).toBe(true);
    }
    // 自检：台语对应词**不该**被任何 HARD 规则命中（否则改对了反而变红）
    for (const { tw } of Object.values(HARD)) {
      for (const term of Object.keys(HARD)) {
        expect(tw.includes(term), `台语词「${tw}」竟含大陆词「${term}」，规则会自相矛盾`).toBe(false);
      }
    }
  });

  it("① 没有 HARD 类大陆术语残留（硬零；新增即为漂移）", () => {
    const bad: string[] = [];
    for (const e of entries) {
      for (const [term, { tw, why }] of Object.entries(HARD)) {
        if (e.value.includes(term)) {
          bad.push(`${e.plugin} ${e.key}: 含「${term}」（台语应作「${tw}」——${why}）\n        ${e.value.slice(0, 90)}`);
        }
      }
    }
    expect(bad, `zh-TW 里出现大陆术语 ${bad.length} 处：\n      ` + bad.join("\n      ")).toEqual([]);
  });

  it("② 同形异义词只出现在账本登记的位置（新增必须当场判断是哪种意思）", () => {
    const bad: string[] = [];
    for (const e of entries) {
      for (const term of AMBIGUOUS) {
        if (e.value.includes(term) && !inLedger(e, term)) {
          bad.push(`${e.plugin} ${e.key}: 含歧义词「${term}」但未登记\n        ${e.value.slice(0, 90)}\n        → 判断它在此处是大陆义还是台语义：大陆义就改成台语词，台语义就加进 LEDGER 并写明理由`);
        }
      }
    }
    expect(bad, `未登记的歧义词 ${bad.length} 处：\n      ` + bad.join("\n      ")).toEqual([]);
  });

  it("③ 账本没有腐烂：每条登记都必须仍然存在（修好了就要删掉，否则账本越长越假）", () => {
    const stale: string[] = [];
    for (const l of LEDGER) {
      const hit = entries.find((e) => e.plugin === l.plugin && e.key === l.key);
      if (!hit) { stale.push(`${l.plugin} ${l.key}（该 key 已不存在）`); continue; }
      if (!hit.value.includes(l.term)) stale.push(`${l.plugin} ${l.key}（已不含「${l.term}」，说明改好了 → 从账本删除）`);
    }
    expect(stale, `账本里有 ${stale.length} 条已失效：\n      ` + stale.join("\n      ")).toEqual([]);
  });

  it("④ 每条账本登记都带理由（不能只登记位置）", () => {
    for (const l of LEDGER) {
      expect(typeof l.why === "string" && l.why.length >= 10, `${l.plugin} ${l.key} 的理由太短`).toBe(true);
    }
  });

  it("⑤ 盲区自检：本守卫抓到的东西，字形守卫的判据**结构上抓不到**（两者互补，不是重复）", () => {
    // 字形守卫（locale-zhtw-simplified.test.ts）的判据是：
    //   zh-TW 值 === zh-CN 值  且  含简体专用字。
    // 构造一个本轮真实形态的样本：zh-TW 是**繁体字形**的大陆术语，zh-CN 是简体，
    // 于是「完全相同」不成立、「含简体专用字」也不成立 —— 字形守卫必然放行。
    // ⚠ 必须显式标注 string：否则 TS 把两个字面量收窄成各自类型，
    //   `zhTW === zhCN` 会被判为 TS2367「两类型无重叠的无意义比较」而编译不过。
    const zhCN: string = "加载失败";   // 简体
    const zhTW: string = "加載失敗";   // 繁体字形，但「加載」是大陆术语（台语作「載入」）
    expect(zhTW === zhCN, "前提：两者不同形，字形守卫的条件①不成立").toBe(false);
    // ⚠ 字集只放**真正的简体专用字**（繁体写法必然不同的字）：载→載、认→認、识→識、
    //   设→設、败→敗。首版误把「默」「加」也放了进去——这两个字**简繁同形**，
    //   于是 test("加載失敗") 命中「加」而返回 true，把"前提不成立"这条自检判反了。
    //   （字形守卫自己的注释里也记着同款教训：首版手抄字集混进了简繁同形的「形」。）
    const SIMPLIFIED_ONLY = /[载认识设败]/;
    expect(SIMPLIFIED_ONLY.test(zhTW), "前提：zh-TW 值不含简体专用字，字形守卫的条件②也不成立").toBe(false);
    // 而本守卫抓得到
    expect(zhTW.includes("加載"), "本守卫应能检出术语漂移").toBe(true);
    expect(HARD["加載"], "「加載」必须在 HARD 清单里").toBeTruthy();
  });
});
