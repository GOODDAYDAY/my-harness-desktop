// keybindings 插件 renderer 入口。
//
// - Overlay:零可见常驻组件(框架 PluginOverlays 全局挂载,PluginIdContext 已注入),
//   挂 window keydown 监听:组合键命中绑定 → ctx.events.invoke(channel, payload)。
//   配置变化走事件驱动:设置页保存后框架广播 system:configFileSaved,订阅重读,保存即生效。
// - KeybindingsSettings:设置页(动态事件列表 + 录制绑定,见 settings.tsx)。
import { useEffect, useRef } from "react";
import { usePluginContext } from "@my-harness-desktop/react";
import { comboFromEvent, comboMatches } from "../core/combo";
import { DEFAULT_BINDINGS, parseBindings, type Binding } from "../core/bindings";

export { KeybindingsSettings } from "./settings";

/** 焦点是否在输入控件:input/textarea/select/contentEditable。 */
function isInputTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/** smart 守卫:带 ctrl/meta/alt(含 mod 抽象)的组合键在输入态也触发,纯键在输入态不触发;always 无条件。 */
function shouldFire(binding: Binding): boolean {
  if (binding.when === "always") return true;
  const hasStrongModifier = /\b(ctrl|meta|alt|mod)\b/.test(binding.combo);
  if (hasStrongModifier) return true;
  return !isInputTarget(document.activeElement);
}

/** 全局常驻的快捷键分发宿主。 */
export function Overlay(): React.ReactNode {
  const ctx = usePluginContext();
  const bindingsRef = useRef<Binding[]>(DEFAULT_BINDINGS);

  // 读绑定 + 订阅保存事件重读(保存即生效;任何 configFile 保存都重读,重读一次便宜,不挑路径)。
  useEffect(() => {
    let alive = true;
    const reload = async (): Promise<void> => {
      try {
        const raw = await ctx.config.get<unknown>("bindings");
        if (!alive) return;
        const parsed = parseBindings(raw);
        if (parsed) bindingsRef.current = parsed;
      } catch {
        // 读失败保持现状,不打断监听
      }
    };
    void reload();
    const off = ctx.events.on("system:configFileSaved", () => { void reload(); });
    return () => {
      alive = false;
      off();
    };
  }, [ctx]);

  // keydown 分发:命中绑定 → invoke 目标 channel(目标插件未加载时静默)。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const combo = comboFromEvent(e);
      if (!combo) return;
      const binding = bindingsRef.current.find((b) => comboMatches(b.combo, combo));
      if (!binding) return;
      if (!shouldFire(binding)) return;
      e.preventDefault();
      try {
        ctx.events.invoke(binding.channel, binding.payload);
      } catch {
        // 目标 channel 未注册(插件卸载/未加载):静默,设置页以动态列表为准可改绑
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ctx]);

  return null;
}
