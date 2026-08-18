// attach-images —— 图片内容解析纯函数(无 React/无 IO,可裸单测)。
//
// 图片展示独立于底座快照:custom_message(customType:image)条目是桌面 append 进会话
// 文件的,底座内存不知道它——sync 的 onSnapshot 用底座快照覆盖 messages 会冲掉
// role:image。因此图不走 messages 吸附,而是桌面自己维护 imageIndex(发送时记录 +
// openSession 从文件读回),timeline 按 user 内容 hash 查索引渲染(设计见
// docs/design/sticker-plugin.md §3 的"展示独立于底座快照"修正)。
// 本文件只保留解析 custom_message content → {src,title} 的纯函数。
import type { NeutralMessage } from "@my-harness-desktop/contract";
import { messageContentText } from "@my-harness-desktop/contract";

export interface AttachedImage {
  src: string;
  title?: string;
}

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

/** NeutralMessage 类型引用保留(避免纯类型 import 被 tree-shake 误解)。 */
export type { NeutralMessage };
