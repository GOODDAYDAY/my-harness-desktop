// pi.ui Markdown —— 助手消息的 Markdown 渲染(react-markdown + GFM + highlight.js)。
//
// 样式全走主题 token:代码块底色用 color-mix 从 bg 派生(比对话区更深,ChatGPT 形态),
// 代码块头部 = 语言标签 + 复制按钮。highlight.js 负责 token 着色(github-dark),
// 容器/文字/表格/引用消费 CSS 变量,不硬编码颜色。
import { useState, isValidElement, type ReactNode, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import "highlight.js/styles/github-dark.css";

/** 递归提取 React children 的纯文本(复制用)。 */
function rawText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(rawText).join("");
  if (isValidElement(node)) return rawText((node.props as { children?: ReactNode }).children);
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }): ReactNode {
  const [copied, setCopied] = useState(false);
  const codeEl = children as ReactElement<{ className?: string; children?: ReactNode }>;
  const className = codeEl?.props?.className ?? "";
  const lang = /language-(\w+)/.exec(className)?.[1] ?? "";
  const text = rawText(codeEl?.props?.children);

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="my-3 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)]"
      style={{ background: "color-mix(in srgb, var(--color-bg) 55%, black)" }}
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)]">
        <span className="text-xs text-[var(--color-muted)] font-[var(--font-family-mono)]">{lang || "text"}</span>
        <button
          onClick={() => void copy()}
          className="flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-[13px] leading-6 font-[var(--font-family-mono)] !bg-transparent">
        {children}
      </pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }): ReactNode {
  return (
    <div className="markdown-body text-[length:var(--font-size-base)] leading-7 text-[var(--color-fg)]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className, children }) =>
            className ? (
              // 块内代码(在 CodeBlock 的 pre 里,hljs 已着色,只透传)
              <code className={className}>{children}</code>
            ) : (
              // 行内代码
              <code
                className="px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[0.875em] font-[var(--font-family-mono)]"
                style={{ background: "var(--color-surface)" }}
              >
                {children}
              </code>
            ),
          p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="text-[1.4em] font-semibold mt-6 mb-3 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="text-[1.25em] font-semibold mt-6 mb-3 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="text-[1.1em] font-semibold mt-5 mb-2 first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 className="text-[1em] font-semibold mt-4 mb-2 first:mt-0">{children}</h4>,
          ul: ({ children }) => <ul className="my-3 pl-6 flex flex-col gap-1 list-disc">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 pl-6 flex flex-col gap-1 list-decimal">{children}</ol>,
          li: ({ children }) => <li className="leading-7">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 pl-4 border-l-2 border-[var(--color-border)] text-[var(--color-muted)]">
              {children}
            </blockquote>
          ),
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2 text-[var(--color-fg)]">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-[0.9em]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[var(--color-border)] px-3 py-1.5 text-left font-semibold bg-[var(--color-surface)]">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-[var(--color-border)] px-3 py-1.5">{children}</td>,
          hr: () => <hr className="my-5 border-[var(--color-border)]" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
