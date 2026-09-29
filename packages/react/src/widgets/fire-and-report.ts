// fire-and-report.ts —— "发射后不管"的写入统一收口（r185，§3.3 收敛）。
//
// ## 为什么要有这个原语
//
// r180–r183 四轮里，四个插件各自写了一份**逻辑完全相同**的兜底助手：
//   · session-bookmarks 的 `persistOrder`（收藏顺序落盘）
//   · projects 的 `persistState`（recentCwds / sectionCollapsed）
//   · plugin-manager 的 `persist`（tagFilter / customOrder）
//   · file-preview 的 `handleOpenSystem`（打开文件）
// 四份都是 `void p.catch(err => { console.warn(...); announceTransient(t(...), "error") })`，
// 差别只在标签与文案键。按 §3.3（多个调用方逻辑大同小异、差别只在参数 ⇒ 收敛到框架一个实现），
// 收成这一个原语：**测一次，四个插件同时受益**；也堵住"下一个插件再抄第五份"的路。
//
// ## 框架零文案（§1.2 铁律一）
//
// 本原语**不含任何用户可见文案**——失败消息由调用方经 `message(detail)` 提供
// （调用方用自己的 i18n 键），框架只负责"什么时候播报、播报什么级别、留什么排查线索"。
// 与 `copyToClipboard`（r134）、`pickDirectory`（r137）同一手法：
// 机制在框架、内容（文案）在插件。
//
// ## 级别为什么固定 error
//
// 这些都是**用户刚做的动作**没有持久化/没有生效（§7.6 禁止静默失败）。
// 用 info 会让读屏用户以为只是提示、可能忽略；用 error 才符合"你的操作没成功"的语义。
import { announceTransient } from "./live-region";

export interface FireAndReportOptions {
  /** console.warn 的前缀标签（排查用），如 "projects"。 */
  tag: string;
  /** 生成用户可见的失败文案（框架零文案：由调用方经 i18n 供）。 */
  message: (detail: string) => string;
}

/**
 * 发射后不管地跑一个 promise，但**不丢掉错误**：
 * 失败时 console.warn（留排查线索）+ announceTransient(error)（让用户知道）。
 *
 * ⚠ 与裸 `void p` 的差别正是"有没有留下错误"：`void p` 把结果与错误一起丢掉，
 *   用户点了没反应、日志里也什么都没有（r180–r183 修的就是这一类）。
 */
export function fireAndReport(p: Promise<unknown>, opts: FireAndReportOptions): void {
  void p.catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[${opts.tag}] 动作失败:`, err);
    announceTransient(opts.message(detail), "error");
  });
}
