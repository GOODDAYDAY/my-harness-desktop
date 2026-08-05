// 用户消息气泡:超长内容收起为 N 行摘要(默认 10,通用配置 userBubbleMaxLines 可调),
// 点气泡展开、点气泡外任意处收回。
//
// - 收起用 CSS line-clamp(Chromium 原生,软换行/断词/全角都算行)——
//   手数 \n 会在"一行很长但没换行符"时漏判,不造轮子。
// - 是否可展开靠实测溢出(scrollHeight > clientHeight),不超行的气泡无点击行为。
// - 点外收回:document mousedown 监听仅展开期间挂载,收起/卸载即清。
import { useEffect, useLayoutEffect, useState, useRef, type ReactNode, type CSSProperties } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";

const DEFAULT_MAX_LINES = 10;

export function UserBubble({ text, maxLines = DEFAULT_MAX_LINES }: {
  text: string;
  /** 收起态最大行数(line-clamp)。 */
  maxLines?: number;
}): ReactNode {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  /** 实测"被裁了没":false=内容不超行,气泡不挂展开交互。 */
  const [clamped, setClamped] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const clampStyle: CSSProperties = {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: maxLines,
    overflow: "hidden",
  };

  // 量溢出:仅在收起态量(展开态无 clamp,量不到真实裁切);内容/行数上限变了重量。
  // 能量出真实裁切的前提是收起态默认挂着 clamp(见下方 style)——
  // 若反过来"先证明溢出才挂 clamp",无高度约束时 scrollHeight 恒等于
  // clientHeight,永远量不出溢出,收起从不生效(鸡生蛋,本次修复的根因)。
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded, maxLines]);

  // 点气泡外任意处收回(AP 式交互:tab 切走/点别条消息/点输入框都算)。
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: globalThis.MouseEvent): void => {
      if (bodyRef.current && !bodyRef.current.contains(e.target as Node)) setExpanded(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("mousedown", onDown); };
  }, [expanded]);

  const toggle = (): void => {
    // 不超行且无展开态:纯文本气泡,不响应点击(保持选择文本的手感)
    if (!clamped && !expanded) return;
    setExpanded((v) => !v);
  };

  const interactive = clamped || expanded;
  return (
    <div className="flex justify-end">
      <div
        ref={bodyRef}
        onClick={toggle}
        title={interactive ? t(expanded ? "timeline.collapse" : "timeline.expand") : undefined}
        className="max-w-[65%] rounded-[var(--radius-md)] px-4 py-2.5 text-[length:var(--font-size-base)] leading-7 whitespace-pre-wrap break-words relative"
        style={{
          background: "var(--color-surface)",
          color: "var(--color-fg)",
          boxShadow: "0 1px 3px rgba(0,0,0,.12)",
          // 收起态无条件挂 clamp:短消息不足 10 行时 clamp 无视觉效果;
          // 点击/渐隐/箭头仍由 clamped 实测门控,不超行的气泡不挂交互。
          ...(!expanded ? clampStyle : {}),
          cursor: interactive ? "pointer" : undefined,
        }}
      >
        {text || t("shell.emptyMessage")}
        {clamped && !expanded && (
          <>
            {/* 底部渐隐:提示下面还有内容(颜色与气泡底色一致,token 化) */}
            <div
              aria-hidden
              className="absolute bottom-0 left-0 right-0 pointer-events-none rounded-b-[var(--radius-md)]"
              style={{ height: "2.5em", background: "linear-gradient(to bottom, transparent, var(--color-surface) 75%)" }}
            />
            <span
              aria-hidden
              className="absolute bottom-0.5 left-1/2 -translate-x-1/2 pointer-events-none text-[var(--color-muted)]"
            >
              <ChevronDown className="size-3.5" />
            </span>
          </>
        )}
        {expanded && clamped && (
          <span aria-hidden className="absolute bottom-0.5 left-1/2 -translate-x-1/2 pointer-events-none text-[var(--color-muted)]">
            <ChevronUp className="size-3.5" />
          </span>
        )}
      </div>
    </div>
  );
}
