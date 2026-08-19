// notifier 插件 renderer —— 零可见槽后台常驻(Overlay)。
//
// 订阅全量流 ctx.sessions.onKernelEvent,在 agentSettled(回合收敛)且窗口不在前台时发系统通知。
// 判定链四道闸:enabled → isFocused → 冷却(节流)→ notify.show。
//
// 内核无关:agentSettled 是跨内核中性契约——pi 由 agent_settled 翻译,dsh 由 turn/end 翻译,
// 两边产出同一事件,壳插件不感知 pi/dsh(设计 docs/design/notifier-plugin.md §2)。
// 配置:settingsGroups 声明(值落 general.json),经 useUiStore.generalConfig 读分层合并视图。
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { usePluginContext, useUiStore } from "@my-harness-desktop/react";

/** general.json 数字档位读取:非数/非正回退默认。 */
function numberOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 零可见常驻组件:框架 PluginOverlays 挂进主树 + 注入 pluginId。 */
export function Overlay(): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const lastNotifyAtRef = useRef<number>(0);

  useEffect(() => {
    return ctx.sessions.onKernelEvent((ev) => {
      if (ev.kind !== "session") return;
      if (ev.event.type !== "agentSettled") return;
      void maybeNotify();
    });

    async function maybeNotify(): Promise<void> {
      // 配置读 ui-store 最新态(非渲染闭包旧值):settingsGroups 值落 general.json。
      const cfg = useUiStore.getState().generalConfig;
      if (cfg["notifier.enabled"] === false) return;

      const focused = await ctx.window.isFocused();
      if (focused) return; // 窗口前台:用户正看着,通知是打扰

      // 节流(固定窗口),不是去抖:只在真正弹时更新时间戳,判定被拦不更新。
      const cooldownMs = numberOr(cfg["notifier.cooldownSec"], 3) * 1000;
      const now = Date.now();
      if (now - lastNotifyAtRef.current < cooldownMs) return;
      lastNotifyAtRef.current = now;

      try {
        await ctx.notify.show({ title: t("notify.title"), body: t("notify.body") });
      } catch {
        // 通知失败(如环境不支持)不致命:静默
      }
    }
  }, [ctx, t]);

  return null;
}
