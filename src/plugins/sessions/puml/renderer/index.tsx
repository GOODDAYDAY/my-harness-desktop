// puml 插件 renderer 入口——puml/plantuml 围栏块渲染件(codeBlockRenderers 槽)。
// 框架按 manifest 的 component 名在本 module exports 自动匹配(§7.4),零注册调用。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import plantumlEncoder from "plantuml-encoder";

const DEFAULT_SERVER = "https://www.plantuml.com/plantuml";

function SourceFallback({ code }: { code: string }): ReactNode {
  return (
    <pre className="p-3 overflow-x-auto text-[length:var(--font-size-base)] leading-6 font-[var(--font-family-mono)] !bg-transparent">
      {code}
    </pre>
  );
}

/** puml 围栏块渲染器(契约 props:{code, streaming}):plantuml-encoder 编码源码 →
 *  server /svg/ 端点 → <img>。不引本地渲染器(JAR/WASM 过重);编码/加载失败
 *  与流式期间都自降级为源码呈现,消费方不感知。 */
export function PumlCodeBlock({ code, streaming = false }: { code: string; streaming?: boolean }): ReactNode {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  const url = useMemo(() => {
    try {
      return `${DEFAULT_SERVER}/svg/${plantumlEncoder.encode(code)}`;
    } catch {
      return null;
    }
  }, [code]);

  useEffect(() => { setStatus("loading"); }, [url]);

  if (streaming || !url || status === "error") return <SourceFallback code={code} />;

  return (
    <div className="overflow-x-auto p-3 flex justify-center bg-[var(--color-surface)]">
      {status === "loading" && (
        <span className="size-4 rounded-full border-2 border-[var(--color-muted)] border-t-transparent animate-spin" />
      )}
      <img
        src={url}
        alt=""
        onLoad={() => setStatus("ok")}
        onError={() => setStatus("error")}
        style={{ display: status === "ok" ? "block" : "none", maxWidth: "100%" }}
      />
    </div>
  );
}
