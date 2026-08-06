import { useEffect, useMemo, useState, type ReactNode } from "react";
import plantumlEncoder from "plantuml-encoder";

const DEFAULT_SERVER = "https://www.plantuml.com/plantuml";

export interface PumlDiagramProps {
  code: string;
  /** 流式期间不渲染(图源码未写完必然出残图),由调用方传;结束后自动成图。 */
  streaming?: boolean;
  /** 编码/加载失败的降级呈现:调用方一般传源码 <pre>。缺省渲染 null。 */
  fallback?: ReactNode;
  /** PlantUML server 地址(不带尾斜杠);缺省公共服务,内网场景传自建地址。 */
  server?: string;
}

/** PlantUML 图源:plantuml-encoder 编码源码 → server /svg/ 端点 → <img> 直挂。
 *  不引本地渲染器(JAR/WASM 均过重);失败一律回退 fallback 源码,不炸调用方。 */
export function PumlDiagram({ code, streaming = false, fallback = null, server = DEFAULT_SERVER }: PumlDiagramProps): ReactNode {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  const url = useMemo(() => {
    try {
      return `${server}/svg/${plantumlEncoder.encode(code)}`;
    } catch {
      return null;
    }
  }, [code, server]);

  useEffect(() => { setStatus("loading"); }, [url]);

  if (streaming || !url || status === "error") return fallback;

  return (
    <div
      className="my-3 overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3 flex justify-center bg-[var(--color-surface)]"
    >
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
