// attach-images —— timeline 插件纯逻辑层(无 React/无 IO,可裸单测)。
//
// 职责:把 role:image 消息(custom_message/customType:image 条目)吸附到最近的 user 消息,
// IM 配图风格——图随用户消息一起显示,不占独立行。为什么需要:图片条目在回复落盘后才
// 补写进会话文件(见 sendMessage 的 pending 队列,等底座 flush 用户消息),文件顺序是
// [user, assistant, image];吸附后视觉上图跟用户消息绑定,和乐观期(user 消息直接带
// __image 字段)显示一致。
//
// 口径:
// - role:image 消息的 content 是 JSON 字符串 {src, title?};解析失败/缺 src = 丢弃(不渲染)。
// - 吸附目标是"向前最近的 user 消息"(跳过 assistant/divider 等)。
// - 无可吸附 user(孤立图条目,罕见)保留独立行,不丢消息。
import type { NeutralMessage } from "@pi-desktop/contract";
import { messageContentText } from "@pi-desktop/contract";

export interface AttachedImage {
  src: string;
  title?: string;
}

/** 带吸附图的 user 消息(渲染层据此在正文上方渲染图片块)。 */
export type UserMessageWithImage = NeutralMessage & { __image?: AttachedImage };

/** 解析 role:image 消息的 content → {src, title};损坏返回 null。 */
export function parseImageContent(content: unknown): AttachedImage | null {
  try {
    const parsed = JSON.parse(messageContentText(content)) as { src?: unknown; title?: unknown };
    if (typeof parsed?.src === "string" && parsed.src.length > 0) {
      return { src: parsed.src, title: typeof parsed.title === "string" ? parsed.title : undefined };
    }
  } catch { /* 内容损坏 */ }
  return null;
}

/** 把 role:image 消息吸附到最近的 user 消息;其余消息原引用透传(不可变输出)。 */
export function attachImagesToUsers(messages: NeutralMessage[]): NeutralMessage[] {
  const out: NeutralMessage[] = [];
  for (const m of messages) {
    if (m.role !== "image") {
      out.push(m);
      continue;
    }
    const img = parseImageContent(m.content);
    if (!img) continue;
    let found = false;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === "user") {
        const prev = out[i] as UserMessageWithImage;
        out[i] = { ...prev, __image: img };
        found = true;
        break;
      }
    }
    if (!found) out.push(m);
  }
  return out;
}
