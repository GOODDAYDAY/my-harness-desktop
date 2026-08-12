// 按键导览 hint 分配的纯函数 —— 不 import react、不碰 ctx,可裸单测。
//
// 模型:导览模式下,把视口内可见可点击元素收集起来,逐个分配字母 hint(a-z、A-Z
// 大小写共 52 个单字符,超出部分升级为双字符),按字母键即触发对应元素点击。
// 两条约束(用户可见契约,设计 DESIGN.md §4):
//   - 区分大小写:a 与 A 是两个不同的 hint。
//   - 前缀唯一:任意两个 hint 不互为前缀 —— 单字符池与双字符首字符池不相交,
//     按完整个 hint 序列必然唯一命中,不存在歧义。

/** hint 字符表:52 个,区分大小写(a-z 在前,A-Z 在后)。 */
export const HINT_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** 单字符 hint 上限(= 字符表长度)。 */
export const MAX_SINGLE = HINT_CHARS.length;

/** 导览模式单次最多标记的目标数:52 单字符 + 让位首字符开出的双字符组(容量 52 + 51h)。
 *  虚拟列表只渲染视口内元素,实际命中数远低于此;超出部分不分配。 */
export const MAX_HINTS = 154;

/**
 * 给 count 个目标分配前缀唯一的 hint 序列。
 *  count <= 52:全部单字符(a-z、A-Z)。
 *  超出:从字符表尾部让位 h 个字符作为双字符组的首字符 —— 让位出去的字符不再作为
 *  单字符,单字符池与双字符首字符池不相交,前缀唯一性由构造保证。
 *  容量公式:单字符 52-h 个 + 双字符 h×52 个 = 52 + 51h;取满足容量 >= count 的最小 h。
 */
export function assignHints(count: number): string[] {
  const n = Math.max(0, Math.min(count, MAX_HINTS));
  if (n <= MAX_SINGLE) return HINT_CHARS.slice(0, n).split("");
  let h = 1;
  while (MAX_SINGLE + (MAX_SINGLE - 1) * h < n) h++;
  const s = MAX_SINGLE - h; // 单字符个数
  const out = HINT_CHARS.slice(0, s).split("");
  for (let j = 0; j < n - s; j++) {
    out.push(HINT_CHARS[s + Math.floor(j / MAX_SINGLE)] + HINT_CHARS[j % MAX_SINGLE]);
  }
  return out;
}

/** 输入型控件:可聚焦但"点击"语义是聚焦输入,不是动作,不给 hint。 */
const INPUT_TYPES = new Set(["hidden", "text", "password", "search", "email", "number", "tel", "url"]);

/** 语义可点击的 role。 */
const CLICKABLE_ROLES = new Set([
  "button", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio",
  "switch", "tab", "option", "link",
]);

/**
 * 元素是否可点击。判定顺序:输入型控件排除 → input 按 type → 语义标签 →
 * role → onclick 属性 → 可聚焦(tabIndex >= 0,输入控件已在上方排除)。
 * 用属性 duck-typing 而非 instanceof 具体类,保证 node 测试环境 import 不炸。
 */
export function isClickable(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "input") {
    if (tag === "textarea") return false;
    return !INPUT_TYPES.has(el.getAttribute("type") ?? "text");
  }
  if ((el as { isContentEditable?: boolean }).isContentEditable) return false;
  if (tag === "button" || tag === "select" || tag === "summary" || tag === "option") return true;
  if (tag === "a") return el.hasAttribute("href");
  const role = el.getAttribute("role");
  if (role && CLICKABLE_ROLES.has(role)) return true;
  if (el.hasAttribute("onclick")) return true;
  // tabIndex >= 0 = 可聚焦(通常可交互);输入控件已在上方排除
  return el instanceof HTMLElement && el.tabIndex >= 0;
}

/** 元素是否禁用(disabled / aria-disabled="true")。禁用元素不可点击,不给 hint。 */
export function isDisabled(el: Element): boolean {
  if (["button", "input", "select", "textarea", "option"].includes(el.tagName.toLowerCase())) {
    return (el as { disabled?: boolean }).disabled === true;
  }
  return el.getAttribute("aria-disabled") === "true";
}

/**
 * 元素是否可见且在视口内。祖先链上任何 display:none / visibility:hidden 即不可见;
 * 包围盒零宽高不可见;完全在视口外不参与(用户只操作当前屏幕)。
 */
export function isVisible(el: Element, viewport?: { width: number; height: number }): boolean {
  let node: Element | null = el;
  while (node) {
    const style = node instanceof HTMLElement ? getComputedStyle(node) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    node = node.parentElement;
  }
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const vw = viewport?.width ?? window.innerWidth;
  const vh = viewport?.height ?? window.innerHeight;
  if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false;
  return true;
}
