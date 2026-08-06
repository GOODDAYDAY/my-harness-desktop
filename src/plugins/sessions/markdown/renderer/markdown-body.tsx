import { useState, isValidElement, type ReactNode, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import "highlight.js/styles/github-dark.css";
import {
  useCodeBlockRenderers,
  resolveCodeBlockRenderer,
  resolveCodeBlockRendererComponent,
  type CodeBlockRendererItem,
} from "@pi-desktop/react";

function rawText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(rawText).join("");
  if (isValidElement(node)) return rawText((node.props as { children?: ReactNode }).children);
  return "";
}

function CodeBlock({ children, streaming, codeBlockItems }: {
  children?: ReactNode;
  streaming?: boolean;
  codeBlockItems: CodeBlockRendererItem[];
}): ReactNode {
  const { t } = useTranslation();
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

  // 围栏语言分发(codeBlockRenderers 槽):mermaid/puml 等由插件成图,
  // 插件内部自降级源码;槽中无渲染器落普通高亮代码体——markdown 不认识任何具体语言。
  const cbrItem = lang ? resolveCodeBlockRenderer(codeBlockItems, lang) : undefined;
  const CbrComp = cbrItem ? resolveCodeBlockRendererComponent(cbrItem) : undefined;

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
          {copied ? t("shell.copied") : t("shell.copy")}
        </button>
      </div>
      {CbrComp ? (
        <CbrComp code={text} streaming={streaming} />
      ) : (
        <pre className="p-3 overflow-x-auto text-[length:var(--font-size-base)] leading-6 font-[var(--font-family-mono)] !bg-transparent">
          {children}
        </pre>
      )}
    </div>
  );
}

export interface MarkdownBodyProps {
  text: string;
  /** 流式标记传给图块(流式期间不渲染,结束后成图);文本本身的防抖由 Markdown 壳负责。 */
  streaming?: boolean;
}

export function MarkdownBody({ text, streaming = false }: MarkdownBodyProps): ReactNode {
  const codeBlockItems = useCodeBlockRenderers();
  return (
    <div className="markdown-body text-[length:var(--font-size-base)] leading-7 text-[var(--color-fg)]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <CodeBlock streaming={streaming} codeBlockItems={codeBlockItems}>{children}</CodeBlock>,
          code: ({ className, children }) =>
            className ? (
              <code className={className}>{children}</code>
            ) : (
              <code
                className="px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[0.875em] font-[var(--font-family-mono)] break-all"
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
