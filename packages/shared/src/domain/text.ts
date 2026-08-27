// 圆心文本工具:消息内容提取 / 截断 / 预览。
//
// 从 sessions.ts 抽出的零依赖叶子模块——sessions.ts 与 session-neutral.ts 都从这里取
// 文本 helper,避免两者之间的运行时 import 环(rollup 对 export * 链 + 环会解析失败)。
// 纯函数、零 import,是圆心最内层。
// 消费方经 @my-harness-desktop/shared barrel 或 sessions.ts re-export 引用,无需感知本文件。

/** 会话显示名的自动截断长度(按 code point 计)。 */
export const SESSION_NAME_DISPLAY_MAX = 20;

/** 会话名文本规范化:折叠连续空白→trim→按 code point 截断,超长补 "…"。
 *  "从文本派生会话名"的唯一截断实现:自动命名(session-store.prompt)与派生显示名共用,
 *  杜绝两处各写一份 slice(0, N) 漂移。 */
export function truncateSessionName(text: string, max: number = SESSION_NAME_DISPLAY_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max).join("").trimEnd()}…`;
}

/** 会话副标题预览截断上限(按 code point 计,超长补 …)。与 SESSION_NAME_DISPLAY_MAX 分工:
 *  名字短(20)、预览长(30)——名字是"这个会话是什么",预览是"最后说了什么"。 */
export const SESSION_PREVIEW_MAX = 30;

/** 从纯文本派生副标题预览(折叠连续空白→trim→按 code point 截断,超长补 …;空文本返回 undefined)。
 *  lastMessage 唯一生成源:neutral header 回填与内核目录扫描共用。 */
export function sessionMessagePreview(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return truncateSessionName(flat, SESSION_PREVIEW_MAX);
}

/** 提取中性消息 content 的纯文本:string 原样;内容块数组拼接所有 text 块;其余返回 ""。
 *  唯一实现——scanner 的 lastMessagePreview、session-store 的打开补命名、renderer 的
 *  消息去重此前各抄一份(textOfContent/textOf),收敛到圆心(契约单源 §1.3)。 */
export function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
      .map((c) => String((c as Record<string, unknown>).text ?? ""))
      .join("");
  }
  return "";
}
