// blocks.ts —— timeline 的块分解器(纯函数,无 React/无 IO,可裸单测)。
//
// 职责:把 NeutralMessage 拆成有序块序列(docs/design/timeline-block-renderers.md §2)。
// 分解读的是中性消息的数据形状(content 数组的 thinking/toolCall/text 块组织方式),
// 是机制不是内容——"怎么画"全在 blockRenderers 槽,本文件不知道任何渲染组件的存在。
// 分组装(content 内 thinking → toolCall → text)保持现行视觉行为,搬家不改形状。
import {
  messageContentText, thinkingBlocksOf, toolCallsOf, parseUserBlocks,
  type NeutralMessage, type ThinkingContent, type ToolCallBlock, type AuxBlock, type AuxBlockParser,
} from "@pi-desktop/contract";
import { stripToolLimitNote } from "@pi-desktop/react";

/** 块:一条消息分解后的最小渲染单元。五种内置词汇 + auxBlock(结构化块,与 blockRenderers 槽的 block 字段同词)。 */
export type TimelineBlock =
  | { type: "thinking"; content: ThinkingContent }
  | { type: "toolCall"; toolCall: ToolCallBlock }
  | { type: "text"; text: string }
  | { type: "userText"; text: string }
  | { type: "userIntent" }
  | { type: "divider"; kind: string; i18nKey: string; i18nArgs?: Record<string, unknown>; detail?: string; tone?: string }
  | { type: "auxBlock"; aux: AuxBlock };

/** 消息 → 块序列。返回 null = 不渲染(未知 role 且 display===false 的显式隐藏语义)。
 *  bashExecution 与未知 role 不是特殊分支,是归一:合成 toolCall 块,
 *  渲染侧完全不感知它们和普通工具调用的差别(设计 §2.1)。
 *  auxParsers 由调用方注入(注册表在模块加载期填充,保持本函数纯)。 */
export function decomposeMessage(message: NeutralMessage, auxParsers: AuxBlockParser[] = []): TimelineBlock[] | null {
  if (message.role === "user") {
    // send() 注入的工具限制前缀是给模型的指令,剥掉不给用户看(现状行为保持)。
    const text = stripToolLimitNote(messageContentText(message.content));
    // 结构化块(skill 展开块 / review 评论块)识别:正文照常,块渲染引用条。
    const { main, blocks } = parseUserBlocks(text, auxParsers);
    const out: TimelineBlock[] = [];
    if (main) out.push({ type: "userText", text: main });
    // 纯评论消息(正文留空):给一个真实用户气泡占位(userIntent,渲染层/贡献方填轻量内容),
    // 引用条在其下方——消息行不悬空,用户确认"发出去了"(设计 §8 关联)。
    else if (blocks.length > 0) out.push({ type: "userIntent" });
    for (const b of blocks) out.push({ type: "auxBlock", aux: b });
    return out;
  }

  if (message.role === "assistant") {
    const blocks: TimelineBlock[] = [];
    for (const content of thinkingBlocksOf(message.content)) blocks.push({ type: "thinking", content });
    for (const toolCall of toolCallsOf(message.content)) blocks.push({ type: "toolCall", toolCall });
    const text = messageContentText(message.content);
    if (text) blocks.push({ type: "text", text });
    return blocks;
  }

  if (message.role === "divider") {
    return [{
      type: "divider",
      kind: String(message.kind ?? "info"),
      i18nKey: String(message.i18nKey ?? "timeline.divider"),
      i18nArgs: message.i18nArgs as Record<string, unknown> | undefined,
      detail: message.detail as string | undefined,
      tone: message.tone as string | undefined,
    }];
  }

  if (message.role === "bashExecution") {
    const exitCode = typeof message.exitCode === "number" ? message.exitCode : null;
    return [{
      type: "toolCall",
      toolCall: {
        name: "bash",
        args: { command: String(message.command ?? ""), cwd: message.cwd },
        result: typeof message.output === "string" ? message.output : messageContentText(message.content),
        isError: exitCode !== null && exitCode !== 0,
      },
    }];
  }

  if (message.display === false) return null;

  return [{
    type: "toolCall",
    toolCall: {
      // 包括 toolResult 孤儿:toolCallId→id 保留,折叠函数若找到对应调用块仍可后补上折。
      id: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
      name: String(message.toolName ?? message.name ?? message.role),
      args: undefined,
      result: message.content,
      isError: message.isError === true,
    },
  }];
}
