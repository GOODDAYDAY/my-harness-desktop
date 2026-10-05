// 服务端中文错误消息的**分类账本**（r79）。
//
// ## 判据（r56 立、r78 接线后可执行）
//
// **这段文本会不会作为用户可见内容出现？**
//   · 会（经 IPC 浮到 toast/对话框，或被插件 catch 后插进用户可见文案）⇒ 必须走 `t()`；
//   · 不会（进日志/开发控制台、是给插件作者或壳开发者看的不变量）⇒ 留中文，但要登记理由。
//
// r78 已把服务端 i18n 单例接线（`initTranslator` 此前零调用点），所以"走 t()"从"做不到"变成了"能做"。
// r79 据此把 controllers 层（IPC handler 所在层，最可能直接浮到 UI）逐条分类：
// 实测 9 处含中文的 throw，其中 **1 处面向用户已迁移**（`kernel.ts` 的 oneshot 缺面错误——
// 它会被 git-review 的 `setActionError(t("review.generateFailed", { error: err.message }))`
// **插进用户可见文案**，于是英文界面里出现中文句子），其余 **8 处是开发者可见的不变量**。
//
// ## 为什么用账本 + 棘轮，而不是"一次全迁"
//
// 全仓 `src/server` 里含中文的 throw 有 **153 处 / 21 个目录**，绝大多数是启动顺序、
// 插件注册、路径越界这类不变量——把它们全迁成 i18n 键既无收益（用户永远看不到），
// 又会把 153 条开发信息塞进语言包（污染翻译面、增加四语言维护成本）。
// 所以本轮只对**最可能面向用户的一层**（controllers）做完分类，其余层留待按同一判据逐层推进；
// 账本 + 棘轮保证：① 分类结论可复核（每条有理由）；② 数量只减不增（新增面向用户的中文消息会红）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CONTROLLERS = "src/server/controllers";
const HAN = /[\u4e00-\u9fff]/;

/** 已分类为「开发者可见的不变量」的条目：每条写清**谁会看到它**与**为什么不该 i18n**。 */
const DEV_FACING: { file: string; needle: string; who: string; why: string }[] = [
  { file: "bus.ts", needle: "未知插件", who: "插件作者（renderer 侧调用 bus 时 pluginId 未注册）",
    why: "这是插件注册不变量被破坏的信号，正常用户操作走不到；消息要带 pluginId 供作者定位，进的是开发控制台" },
  { file: "bus.ts", needle: "未声明权限", who: "插件作者（manifest 少声明 sessions:bus 权限）",
    why: "权限声明错误属作者面向的装配问题，修法是改 manifest，不是给用户看的操作指引" },
  { file: "config.ts", needle: "configFile 路径越界", who: "插件作者（manifest 的 settings[].configFile 写了越界路径）",
    why: "安全边界校验 + 作者面向的装配错误；消息里要带收到的路径与前缀白名单，属诊断信息" },
  { file: "config.ts", needle: "relPath 不能是绝对路径", who: "调用方开发者（API 误用）",
    why: "API 契约违反（传了绝对路径/~），属编程错误，不是用户可修正的情形" },
  { file: "config.ts", needle: "relPath 不能含", who: "调用方开发者（API 误用）",
    why: "路径穿越防护（`..`）：属 API 契约违反的编程错误，用户无从修正；消息进开发控制台供作者定位" },
  { file: "fs-git.ts", needle: "fs:project 拒绝", who: "插件作者 / 开发者",
    why: "无激活项目目录时插件就不该发起项目内文件操作（UI 侧已有 openFolderFirst 的用户提示）；这条是服务端兜底，正常路径走不到" },
  { file: "fs-git.ts", needle: "fs:project 越界", who: "安全审计 / 开发者",
    why: "路径逃逸防护，消息要带绝对路径与项目根供审计；不是用户可操作的场景" },
  { file: "sessions.ts", needle: "session 文件路径越界", who: "安全审计 / 开发者",
    why: "会话文件路径越界防护：属安全不变量，消息要带收到的路径供审计；不是用户可操作的场景，故不 i18n" },
  { file: "sessions.ts", needle: "未声明权限 rpc:bash", who: "插件作者（manifest 少声明 rpc:bash 权限）",
    why: "BashApi 声明能力门控：与 bus.ts 的 sessions:bus 门完全同族——权限声明错误是作者面向的装配问题，修法是改 manifest permissions" },
  { file: "sessions.ts", needle: "未知插件", who: "插件作者（renderer 侧调 bash 时 pluginId 未注册）",
    why: "同 bus.ts 未知插件：注册不变量被破坏的信号，消息带 pluginId 供作者定位；rpc:bash 门与 sessions:bus 门同族同判" },
];

function controllerFiles(): string[] {
  const dir = join(ROOT, CONTROLLERS);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts")).map((n) => join(dir, n));
}

/** 收集 controllers 层含中文的 throw 消息（剥离注释后逐行判）。 */
function chineseThrows(): { file: string; line: number; msg: string }[] {
  const out: { file: string; line: number; msg: string }[] = [];
  for (const f of controllerFiles()) {
    const src = readFileSync(f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    src.split("\n").forEach((raw, i) => {
      const ln = raw.trim();
      if (ln.startsWith("//") || ln.startsWith("*")) return;
      for (const m of ln.matchAll(/throw new Error\(\s*[`"']([^\n]*?)[`"']\s*\)/g)) {
        if (HAN.test(m[1])) out.push({ file: relative(ROOT, f), line: i + 1, msg: m[1] });
      }
    });
  }
  return out;
}

describe("服务端 controllers 层的中文错误消息：要么已迁 i18n，要么在账本里登记为开发者可见", () => {
  const found = chineseThrows();

  it("判据不空转：确实扫到了 controllers 文件与中文 throw", () => {
    expect(controllerFiles().length, "一个 controller 文件都没扫到 ⇒ 路径判据坏了").toBeGreaterThan(5);
    // r79 实测：迁移 1 处后剩 8 处
    expect(found.length, `扫到 ${found.length} 处中文 throw（r79 实测 8）⇒ 判据可能坏了`).toBeGreaterThan(0);
  });

  it("① 每一处中文 throw 都已在账本里登记（未登记 = 没人判断过它是否面向用户）", () => {
    const unregistered = found.filter((t) => {
      const base = t.file.split("/").pop()!;
      return !DEV_FACING.some((d) => d.file === base && t.msg.includes(d.needle));
    });
    expect(unregistered.map((t) => `${t.file}:${t.line} ${t.msg.slice(0, 60)}`), [
      `${unregistered.length} 处中文 throw 未分类：`,
      "      判据：**这段文本会不会作为用户可见内容出现？**",
      "        · 会（经 IPC 浮到 toast/对话框，或被插件 catch 后插进用户可见文案）",
      "          ⇒ 改走 t(\"shell.…\")，并在 system/i18n 的 shell.json 补四语言；",
      "        · 不会（进日志/开发控制台，是给插件作者或壳开发者的不变量）",
      "          ⇒ 登记进 DEV_FACING 并写清「谁会看到它 + 为什么不该 i18n」。",
      "      ⚠ 判断『会不会浮到 UI』要查**调用方的 catch**：例如 git-review 把 err.message",
      "        插进 t(\"review.generateFailed\", { error }) —— 那就是面向用户的。",
    ].join("\n")).toEqual([]);
  });

  it("② 棘轮：controllers 层的中文 throw 只许减少（r79 基线 8 处）", () => {
    const CEILING = 10; // r79 为 8；rpc:bash 门新增两条登记于 DEV_FACING（bus.ts 同族），故 8 → 10
    expect(found.length, [
      `controllers 层的中文 throw 从 ${CEILING} 涨到了 ${found.length}。`,
      "      新增的大概率是面向用户的消息（这一层是 IPC handler，错误直接回给 renderer）。",
      "      若确实面向用户 ⇒ 改走 t()；若确实是开发者不变量 ⇒ 登记进 DEV_FACING 并**下调本上限**。",
    ].join("\n")).toBeLessThanOrEqual(CEILING);
  });

  it("③ 账本不得腐烂：每条登记都还能在源码里找到，且理由非空", () => {
    const stale: string[] = [];
    for (const d of DEV_FACING) {
      const p = join(ROOT, CONTROLLERS, d.file);
      if (!existsSync(p)) { stale.push(`${d.file} 已不存在`); continue; }
      const src = readFileSync(p, "utf-8");
      if (!src.includes(d.needle)) stale.push(`${d.file} 里已找不到 "${d.needle}"（消息改了或已迁移 ⇒ 更新/删除这条登记）`);
      if (d.why.trim().length < 20) stale.push(`${d.file}/${d.needle} 的理由太短（要写清为什么不该 i18n）`);
      if (d.who.trim().length < 4) stale.push(`${d.file}/${d.needle} 没写清谁会看到它`);
    }
    expect(stale, `账本失效 ${stale.length} 条：\n      ${stale.join("\n      ")}`).toEqual([]);
  });

  it("④ 已迁移的那条不得写回中文字面量（r79：oneshot 缺面错误）", () => {
    // ⚠ 必须**剥离注释**再判：迁移时写的说明里会引用旧字面量
    //   （"于是英文界面里会出现 Generation failed: 无内核提供 llm:oneshot 能力"），
    //   那是合法的退役说明；不剥注释就会把它当成"写回了硬编码中文"（r74 同款陷阱）。
    const src = readFileSync(join(ROOT, CONTROLLERS, "kernel.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(src.includes('t("shell.noOneshotCapability")'), "kernel.ts 的 oneshot 缺面错误不再走 t()（r79 的迁移被回退）").toBe(true);
    expect(src.includes("无内核提供 llm:oneshot 能力"), "kernel.ts 又写回了硬编码中文的 oneshot 错误").toBe(false);
  });
});
