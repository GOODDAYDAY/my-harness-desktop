import { memo, type ReactNode } from "react";
import { MarkdownBody } from "./markdown-body";
import { StreamingCaret, useDebouncedValue } from "./stream-utils";

/** 会话流 Markdown 文本块:渲染配置在 markdown-body(槽分发),
 *  本壳只做流式特化——50ms 防抖攒批 + 末尾静态光标。 */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }): ReactNode {
  const debouncedText = useDebouncedValue(text, 50);

  const content = streaming ? debouncedText : text;

  return (
    <div>
      <MarkdownBody text={content} streaming={streaming} />
      {streaming && <StreamingCaret />}
    </div>
  );
});
