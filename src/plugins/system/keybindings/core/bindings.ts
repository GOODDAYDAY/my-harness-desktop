// 绑定模型与默认绑定的纯函数 —— 不 import react、不碰 ctx,可裸单测。
//
// 绑定 = 组合键 + 目标 channel(事件)。快捷键插件不实现任何动作,只做
// "组合键 → invoke channel" 的映射;动作执行仍是各插件自己的处理逻辑(单源)。

/** 输入态守卫:smart(默认)= 带 ctrl/meta/alt 的组合键在输入态也触发,纯键在输入态不触发;always = 无条件(拦截输入自担)。 */
export type InputWhen = "smart" | "always";

/** 一条绑定:按下 combo 时向 channel invoke payload。 */
export interface Binding {
  combo: string;
  channel: string;
  payload?: unknown;
  when?: InputWhen;
}

/** 默认绑定:零配置即可用的底线,全部指向 timeline 既有 channel,避开壳层 ⌘B/⌘J/⌘N/⌘,。 */
export const DEFAULT_BINDINGS: Binding[] = [
  { combo: "mod+k", channel: "timeline:focusComposer" },
  { combo: "mod+shift+up", channel: "timeline:scrollTo", payload: { position: "top" } },
  { combo: "mod+shift+down", channel: "timeline:scrollTo", payload: { position: "bottom" } },
  // Vim ] / [ 方向语义(参考 unimpaired 的 ]b/[b):shift 组管模型、alt 组管思考深度。
  { combo: "mod+shift+]", channel: "timeline:cycleModel" },
  { combo: "mod+shift+[", channel: "timeline:cycleModel", payload: { direction: -1 } },
  { combo: "mod+alt+]", channel: "timeline:cycleThinking" },
  { combo: "mod+alt+[", channel: "timeline:cycleThinking", payload: { direction: -1 } },
  // 按键导览(key-hints 插件):组合键触发导览模式;` 前缀键(单击进/双击输入 `)是插件内置的另一种触发。
  { combo: "mod+shift+'", channel: "keyhints:toggle" },
];

/** 单条绑定收紧:形状非法返回 null(调用方回退)。combo 格式经 parseCombo 校验。 */
export function parseBinding(raw: unknown): Binding | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.combo !== "string" || typeof b.channel !== "string") return null;
  if (b.combo.trim().length === 0 || b.channel.trim().length === 0) return null;
  const when = b.when === "always" ? "always" : b.when === "smart" ? "smart" : undefined;
  return {
    combo: b.combo.trim(),
    channel: b.channel.trim(),
    ...(b.payload !== undefined ? { payload: b.payload } : {}),
    ...(when ? { when } : {}),
  };
}

/**
 * 配置里的 bindings 收紧:数组且每项合法 → 返回收紧数组;否则 null。
 * 单条非法(用户手改坏 JSON 或 combo 格式错)整条丢弃,不阻塞其余绑定。
 */
export function parseBindings(raw: unknown): Binding[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Binding[] = [];
  for (const item of raw) {
    const b = parseBinding(item);
    if (b) out.push(b);
  }
  return out;
}
