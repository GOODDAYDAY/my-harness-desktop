// 组合键规范化的纯函数 —— 不 import react、不碰 ctx,可裸单测。
//
// 规范串格式:修饰键按固定顺序 ctrl → alt → shift → meta 前缀 + 主键小写,
// 用 "+" 连接,如 "meta+shift+f"、"ctrl+k"、"alt+up"。
// "mod" 是跨平台抽象:mac 展开为 meta,win/linux 展开为 ctrl(见 comboMatches)。
// 纯修饰键(只按 ctrl/alt/shift/meta)不构成绑定,返回 null。

/** keydown 事件中参与组合键判定的字段子集(便于纯函数单测,不依赖 DOM 事件类型)。 */
export interface ComboEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}

/** 解析后的绑定组合键(修饰键开关 + 主键)。 */
export interface ParsedCombo {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

const KEY_ALIASES: Record<string, string> = {
  " ": "space",
  Escape: "esc",
  Enter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "del",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Insert: "insert",
  CapsLock: "capslock",
  ContextMenu: "menu",
  PrintScreen: "printscreen",
  ScrollLock: "scrolllock",
  Pause: "pause",
  NumLock: "numlock",
  // shift 形态映射到无 shift 的主键:shift+] 的 e.key 是 "}",用户心智是 ]
  // (Vim ] / [ 方向语义的绑定写 mod+shift+] 即命中);shift+' 的 e.key 是 ",
  // 绑定写 mod+shift+' 即命中。
  "}": "]",
  "{": "[",
  '"': "'",
};

/** 纯修饰键:单独按下不构成绑定(它们是组合键的一部分,不是主键)。 */
const MODIFIER_KEYS = new Set(["meta", "ctrl", "alt", "shift", "control", "option"]);

/** 主键规范化:别名映射 / 单字符小写 / 其余(F1 等)小写。纯修饰键返回 null。 */
export function normalizeKey(key: string): string | null {
  if (MODIFIER_KEYS.has(key.toLowerCase())) return null;
  const alias = KEY_ALIASES[key];
  if (alias) return alias;
  if (key.length === 1) return key.toLowerCase();
  return key.toLowerCase();
}

/** 键盘事件 → 规范串;纯修饰键按下返回 null(不构成绑定)。 */
export function comboFromEvent(e: ComboEvent): string | null {
  const main = normalizeKey(e.key);
  if (!main) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (e.metaKey) parts.push("meta");
  parts.push(main);
  return parts.join("+");
}

/** 绑定串 → 解析结果;格式非法(未知修饰键/空主键/主键是修饰键)返回 null。 */
export function parseCombo(combo: string): ParsedCombo | null {
  const parts = combo
    .split("+")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const rawKey = parts[parts.length - 1];
  const key = normalizeKey(rawKey);
  if (!key) return null;

  let mod = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  for (const m of parts.slice(0, -1)) {
    if (m === "mod") mod = true;
    else if (m === "ctrl") ctrl = true;
    else if (m === "alt") alt = true;
    else if (m === "shift") shift = true;
    else if (m === "meta") meta = true;
    else return null; // 未知修饰键
  }
  return { mod, ctrl, alt, shift, meta, key };
}

/**
 * 绑定串是否命中事件串。
 * "mod" 是跨平台主修饰键:要求事件恰好按了 meta 或 ctrl 之一(mac 的 ⌘ = meta,win/linux 的 Ctrl = ctrl,
 * 同时按 ⌘+Ctrl 不命中)。写死 ctrl+k 就真的只认 Ctrl 不认 ⌘,写死 meta+k 只认 ⌘。主键与其余修饰键精确比较。
 */
export function comboMatches(binding: string, eventCombo: string): boolean {
  const p = parseCombo(binding);
  const e = parseCombo(eventCombo);
  if (!p || !e) return false;
  if (p.key !== e.key) return false;
  if (p.mod) {
    // mod:恰好一个平台主修饰键(meta xor ctrl)
    if (e.meta === e.ctrl) return false;
  } else {
    if (p.meta !== e.meta) return false;
    if (p.ctrl !== e.ctrl) return false;
  }
  if (e.alt !== p.alt) return false;
  if (e.shift !== p.shift) return false;
  return true;
}
