// llm-recorder 记录详情 —— RecordDetail 是行内展开与弹窗共用的唯一渲染体:
// 两处只是容器不同,内容组件同一份,改一处两处同步。弹窗形态与 session-tree
// fullscreen-map 同款:fixed backdrop + stopPropagation 面板 + Esc/背景/× 关闭。
import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { type RecordPair } from "../core/log-model";
import { byteSize, errorSummary } from "../core/payload-model";
import { RequestPayloadView, ResponseMessageView, fmtBytes, fmtTime } from "./payload-views";

const labelStyle: React.CSSProperties = {
  fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: 4,
};

export function RecordDetail({ pair }: { pair: RecordPair }): ReactNode {
  const { t } = useTranslation();
  const summary = errorSummary(pair.response?.error);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
      <div>
        <div style={labelStyle}>{t("panel.request")}</div>
        <RequestPayloadView payload={pair.request.payload} />
      </div>
      <div>
        <div style={labelStyle}>{t("panel.response")}</div>
        {/* 失败事实必须在内容之上先看到——dsh 的失败行没有 status，只有 error。 */}
        {summary !== undefined && (
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-danger, #f38ba8)", marginBottom: 4, wordBreak: "break-all" }}>
            {summary}
          </div>
        )}
        {pair.response
          ? <ResponseMessageView message={pair.response.message} />
          : <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>{t("panel.notReturned")}</div>}
      </div>
    </div>
  );
}

export function RecordModal({ pair, onClose }: { pair: RecordPair; onClose: () => void }): ReactNode {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const status = pair.response?.status;

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{
          display: "flex", alignItems: "center", gap: "var(--spacing-sm)",
          padding: "var(--spacing-sm) var(--spacing-md)",
          borderBottom: "1px solid var(--color-border)", flexShrink: 0,
          fontSize: "var(--font-size-sm)",
        }}>
          <span style={{ color: "var(--color-muted)" }}>#{pair.seq}</span>
          <span>{fmtTime(pair.request.ts)}</span>
          <span style={{ color: "var(--color-muted)" }}>
            {pair.request.turnIndex !== undefined ? t("panel.turn", { n: pair.request.turnIndex }) : t("panel.internal")}
          </span>
          {status !== undefined && <span style={{ color: "var(--color-muted)" }}>{status}</span>}
          {pair.response?.durationMs !== undefined && (
            <span style={{ color: "var(--color-muted)" }}>{(pair.response.durationMs / 1000).toFixed(1)}s</span>
          )}
          <span style={{ marginLeft: "auto", color: "var(--color-muted)", fontSize: "var(--font-size-xs)" }}>
            {/* 与行内列表同一个尺子（core 的 byteSize）——旧版这里自己 encode 一遍，
                对不可序列化的 payload 会得到与列表不同的数。 */}
            {fmtBytes(byteSize(pair.request.payload))}
          </span>
          <button onClick={onClose} title={t("panel.close")} style={closeBtnStyle}>
            <X size={16} />
          </button>
        </div>
        <div style={{ padding: "var(--spacing-md)", overflow: "auto", minHeight: 0 }}>
          <RecordDetail pair={pair} />
        </div>
      </div>
    </div>
  );
}

const backdropStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.5)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
};

const panelStyle: React.CSSProperties = {
  width: "min(960px, 94vw)", height: "min(720px, 88vh)",
  display: "flex", flexDirection: "column",
  background: "var(--color-bg)", border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-lg, 0 8px 32px rgba(0,0,0,0.4))",
};

const closeBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 24, height: 24, border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer", flexShrink: 0,
};
