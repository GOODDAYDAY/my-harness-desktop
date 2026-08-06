import { useEffect, useState, type ReactNode } from "react";

let mermaidCounter = 0;

/** 读 body 计算背景亮度判明暗:mermaid 主题是渲染期全局配置,跟 app 主题 token 走。 */
function isDarkMode(): boolean {
  const bg = getComputedStyle(document.body).backgroundColor;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
  if (!m) return true;
  const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
  return lum < 0.5;
}

export interface MermaidDiagramProps {
  code: string;
  /** 流式期间不渲染(围栏未闭合必失败),由调用方传;结束后自动成图。 */
  streaming?: boolean;
  /** 解析失败的降级呈现:调用方一般传源码 <pre>。缺省渲染 null。 */
  fallback?: ReactNode;
}

export function MermaidDiagram({ code, streaming = false, fallback = null }: MermaidDiagramProps): ReactNode {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (streaming) return;
    let alive = true;
    setSvg(null);
    setFailed(false);
    void (async () => {
      try {
        // 动态 import:500KB+ 的 mermaid 不进首屏,真遇到图才加载
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          theme: isDarkMode() ? "dark" : "default",
          securityLevel: "strict",
        });
        const { svg: rendered } = await mermaid.render(`mermaid-diagram-${++mermaidCounter}`, code);
        if (alive) setSvg(rendered);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [code, streaming]);

  if (streaming || failed) return fallback;
  if (!svg) {
    return (
      <div className="my-3 flex items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] p-6">
        <span className="size-4 rounded-full border-2 border-[var(--color-muted)] border-t-transparent animate-spin" />
      </div>
    );
  }
  return (
    <div
      className="my-3 overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3 flex justify-center"
      // eslint-disable-next-line react/no-danger -- mermaid strict 模式输出已消毒
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
