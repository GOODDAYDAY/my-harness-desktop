// mermaid 插件 renderer 入口——mermaid 围栏块渲染件(codeBlockRenderers 槽)。
// 框架按 manifest 的 component 名在本 module exports 自动匹配(§7.4),零注册调用。
import { useEffect, useState, type ReactNode } from "react";

let mermaidCounter = 0;

/** 读 body 计算背景亮度判明暗:mermaid 主题是渲染期全局配置,跟 app 主题明暗走。 */
function isDarkMode(): boolean {
  const bg = getComputedStyle(document.body).backgroundColor;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
  if (!m) return true;
  const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
  return lum < 0.5;
}

function SourceFallback({ code }: { code: string }): ReactNode {
  return (
    <pre className="p-3 overflow-x-auto text-[length:var(--font-size-base)] leading-6 font-[var(--font-family-mono)] !bg-transparent">
      {code}
    </pre>
  );
}

/** mermaid 围栏块渲染器(契约 props:{code, streaming})。
 *  动态 import:500KB+ 的 mermaid 不进首屏,真遇到图才加载;
 *  流式期间(围栏未闭合必失败)与解析失败都自降级为源码呈现,消费方不感知。 */
export function MermaidCodeBlock({ code, streaming = false }: { code: string; streaming?: boolean }): ReactNode {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (streaming) return;
    let alive = true;
    setSvg(null);
    setFailed(false);
    void (async () => {
      try {
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

  if (streaming || failed) return <SourceFallback code={code} />;
  if (!svg) {
    return (
      <div className="flex items-center justify-center p-6">
        <span className="size-4 rounded-full border-2 border-[var(--color-muted)] border-t-transparent animate-spin" />
      </div>
    );
  }
  return (
    <div
      className="overflow-x-auto p-3 flex justify-center"
      // mermaid strict 模式输出已消毒
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
