import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ensureToastHost } from "./toast";

/**
 * 应用启动时挂载一次的**常驻 live region 宿主**。
 *
 * 为什么要有这个组件（而不是等第一条 toast 自己建宿主）：
 * `aria-live` 的播报前提是**容器在内容变化之前就已经在 DOM 里**。若宿主由第一条 toast
 * 惰性创建，那么"创建容器"与"填入文本"发生在同一次挂载里，多数读屏不会播报——
 * 也就是**用户听到的第一条恰好是最该听到的那一条**（比如"附件类型不支持""保存失败"）丢失。
 * 在应用根挂载本组件，宿主从启动起就存在，之后每一次 toast 都是"已存在的 live region 内部
 * 内容变化"，播报才可靠。
 *
 * 它本身不渲染任何可见内容（宿主是 0×0 的容器，toast 的可视部分是 `position: fixed`），
 * 所以放在应用根的任意位置都可以。
 */
export function LiveRegionHost(): ReactNode {
  useEffect(() => {
    ensureToastHost();
  }, []);
  return null;
}

/**
 * 把一条**瞬时消息**播报给辅助技术，而不改变它原有的视觉呈现。
 *
 * 为什么需要它（`Toast` 部件之外还有一条路）：应用里并非所有瞬时提示都走共享 `Toast`——
 * timeline 的提示条锚在输入框附近（带图标、非 fixed 顶部）、retry/continue 的报错是行内
 * 一个 `<span>`。把它们都迁到 `Toast` 会改变视觉位置与既有交互，代价与收益不对等；
 * 而它们缺的只是"被读到"这一件事。本组件正好只补这一件：
 * 内容 portal 进**常驻宿主**（因此满足"容器先于内容存在"的播报前提），
 * 自身不产生任何可见像素（宿主是 0×0，且这里不再重复画视觉）。
 *
 * 用法：`{msg && <Announce message={msg} />}`，与原有的视觉元素**并存**（不是替换它）。
 */
/**
 * `Announce` 的**命令式孪生**（r82）：给非组件代码用（如 `plugin-context.ts` 的框架级兜底）。
 *
 * 为什么需要它：`Announce` 是组件、必须被渲染，而框架层的失败兜底发生在普通函数里。
 * 这里刻意渲染出与 `Announce` **完全相同的 DOM**（`<span role="alert"?>[data-announced]`，
 * 插进同一个 `ensureToastHost()` 宿主），不另造一套结构——否则读屏行为会与组件版漂移。
 *
 * @param ttl 播报后多久移除节点（宿主是常驻 live region，节点留着会让后续播报重复念旧内容）。
 */
export function announceTransient(message: string, variant: "info" | "error" = "info", ttl = 4000): void {
  if (typeof document === "undefined" || !message) return;
  const host = ensureToastHost();
  const el = document.createElement("span");
  el.setAttribute("data-announced", variant);
  if (variant === "error") el.setAttribute("role", "alert");
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.remove(); }, ttl);
}

export function Announce({ message, variant = "info" }: { message: string; variant?: "info" | "error" }): ReactNode {
  // 宿主在渲染期就要拿到（portal 的目标必须是已存在的节点）；ensureToastHost 是幂等的。
  const host = typeof document === "undefined" ? null : ensureToastHost();
  if (!host || !message) return null;
  return createPortal(
    // role=alert 用于错误（插入即播报、可打断）；其余交给宿主的 status + polite（不抢占）。
    <span {...(variant === "error" ? { role: "alert" } : {})} data-announced={variant}>
      {message}
    </span>,
    host,
  );
}
