// im-graph/renderer/EventFlow —— 聚焦会话的事件流面板:tag 三色(消息/工具/边界),
// 流式条目挂光标,新事件自动滚底。纯展示组件:条目模型与聚合在 core/flow-events。
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { FlowEvent } from "../core/flow-events";

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function EventFlow({ title, events, onClose }: {
  title: string;
  events: FlowEvent[];
  onClose(): void;
}): ReactNode {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <div className="flow">
      <div className="flow-head">
        <span className="flow-title">
          <span className="live" />
          {title}
        </span>
        <button type="button" className="flow-close" onClick={onClose} title={t("im-graph.close")}>
          <X size={12} />
        </button>
      </div>
      <div className="flow-list" ref={listRef}>
        {events.map((e) => (
          <div key={e.id} className="flow-item">
            <span className="ts">{fmtTime(e.ts)}</span>
            <span className={`tag tag-${e.kind}`}>{t(`im-graph.tag.${e.kind}`)}</span>
            <span className={`txt${e.streaming ? " streaming" : ""}`}>{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
