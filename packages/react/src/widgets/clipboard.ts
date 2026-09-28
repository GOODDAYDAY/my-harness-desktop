// 复制到剪贴板的**统一原语**（r134，§3.3「框架管通用，特化归外层」）。
//
// ## 为什么要有它
//
// 实测渲染侧有 **9 处**各自调用 `navigator.clipboard.writeText(...)`，失败处理**三种形态**、
// 且多处静默：
//   · `void navigator.clipboard.writeText(text)`（stickers/sticker-card、react/file-tree）
//     ⇒ 失败时既无反馈、又产生 unhandled rejection；
//   · `.then(setCopied).catch(() => { /* 剪贴板不可用时静默 */ })`（llm-recorder/payload-views）
//     ⇒ 注释里明写"静默"，但用户点了"复制"却什么都没发生，正是 §7.6 禁止的静默失败；
//   · `await navigator.clipboard.writeText(text); setCopied(true)`（markdown/markdown-body、
//     timeline/message-actions）⇒ 抛错时 `setCopied` 走不到，且异常从 onClick 冒出去成 unhandled rejection；
//   · `navigator.clipboard?.writeText(...)`（remote-access 两处）⇒ 只有这两处记得 API 可能不存在。
//
// 三个真实风险，都不是假想：
//   ① **非安全上下文里 API 不存在**：`navigator.clipboard` 只在 secure context（https / localhost）
//      下可用。本产品的远程访问（remote-access 插件）恰恰可能是 http ⇒ `navigator.clipboard`
//      是 `undefined`，不带 `?.` 的那 7 处会直接 TypeError。
//   ② **权限被拒**：即使 API 存在，`writeText` 也可能 reject（用户拒绝、页面未聚焦）。
//   ③ **静默失败**：上述两种情况下，用户看到的是"点了复制、界面显示已复制（或毫无反应）"。
//
// ## 契约
//
// 返回 `boolean`（成功与否），**不抛**。理由：调用方要的是"能不能驱动自己的『已复制』状态"，
// 而不是"处理一个异常"；把异常吞在这里、把结果用返回值给出，调用方就不会再写出
// "await 之后无条件 setCopied(true)"那种形态。失败时**本函数自己播报**（announceTransient，
// r82 的命令式原语 ⇒ 进常驻 live region、role=alert 可打断），所以调用方不必再管提示。
// i18next 单例的取法与 plugin-context.ts 一致（发布面内的既有约定）
import { i18next } from "../../../../src/web/app/i18n-init";
import { announceTransient } from "./live-region";

/** 把文本写进系统剪贴板。成功返回 true；失败**播报原因**并返回 false（不抛）。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    // ⚠ API 可能整体不存在（非安全上下文）——这是 9 个调用点里只有 2 处记得的情况
    if (!clip?.writeText) throw new Error("clipboard-unavailable");
    await clip.writeText(text);
    return true;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // 两种失败对用户意味着不同的动作，所以文案要区分（§7.6：降级要"解释"）：
    //   · API 不存在 ⇒ 通常是 http 远程访问，用户能做的是改用 https/本机；
    //   · 其它（权限被拒/页面未聚焦）⇒ 用户能做的是重试或手动复制。
    const detail = raw === "clipboard-unavailable"
      ? i18next.t("shell.clipboardUnavailable")
      : raw;
    announceTransient(i18next.t("shell.clipboardFailed", { detail }), "error");
    return false;
  }
}
