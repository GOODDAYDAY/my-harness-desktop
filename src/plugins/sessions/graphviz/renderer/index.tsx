// graphviz 插件 renderer 入口——dot/graphviz 围栏块渲染件(codeBlockRenderers 槽)。
// 框架按 manifest 的 component 名在本 module exports 自动匹配(§7.4),零注册调用。
import { useEffect, useState, type ReactNode } from "react";
import type { Viz } from "@viz-js/viz";

function SourceFallback({ code }: { code: string }): ReactNode {
  return (
    <pre className="p-3 overflow-x-auto text-[length:var(--font-size-base)] leading-6 font-[var(--font-family-mono)] !bg-transparent">
      {code}
    </pre>
  );
}

// Viz 实例单例:WASM 只实例化一次,后续渲染复用同一实例。
let vizPromise: Promise<Viz> | null = null;
function getViz(): Promise<Viz> {
  vizPromise ??= import("@viz-js/viz").then((m) => m.instance());
  return vizPromise;
}

/** graphviz 围栏块渲染器(契约 props:{code, streaming})。
 *  动态 import:~1.1MB 的 viz.js(WASM 内联单文件)不进首屏,真遇到图才加载;
 *  流式期间(围栏未闭合必失败)与解析失败都自降级为源码呈现,消费方不感知。
 *  graphviz 输出透明底黑线,容器给白底,保证暗色主题下可读。 */
export function GraphvizCodeBlock({ code, streaming = false }: { code: string; streaming?: boolean }): ReactNode {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (streaming) return;
    let alive = true;
    setSvg(null);
    setFailed(false);
    void (async () => {
      try {
        const viz = await getViz();
        const rendered = viz.renderString(code, { format: "svg" });
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
      className="overflow-x-auto p-3 flex justify-center bg-white"
      // viz.js 输出是 graphviz 引擎生成的纯图形 SVG(不含 script),innerHTML 注入的 script 按浏览器规范不执行
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
