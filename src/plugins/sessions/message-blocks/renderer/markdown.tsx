import { memo, type ReactNode } from "react";
import { MarkdownBody } from "@pi-desktop/react";
import { StreamingCaret, useDebouncedValue } from "./stream-text-reveal";

/** 会话流 Markdown:渲染配置已收敛到共享 MarkdownBody(packages/react),
 *  本壳只留流式特化——50ms 防抖攒批 + 末尾静态光标。 */
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

