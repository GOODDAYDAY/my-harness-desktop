// im-graph renderer —— 右面板"IM"页签:Session Bus 会话关系图 + 聚焦事件流。
// 数据口径:core/graph-model(图模型) + core/flow-events(事件流条目) + client/bus-observer(出站封装)。
// 面板激活才挂观察(status 基线 + tap 订阅),非激活全拆——tap 是路由器运行时
// 状态,插件不常驻白吃 IPC 流量;重新激活时 refresh 一轮基线自愈。
// 聚焦:点会话节点 → 该会话 tap 升级 stream(同时至多一个),事件流经
// onSessionEvent 灌入事件流面板;退出(再点/✕/面板失活)即降级拆流。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Network, RefreshCw } from "lucide-react";
import { EmptyState, usePluginContext, usePluginId } from "@pi-desktop/react";
import { BusObserver } from "../client/bus-observer";
import { emptyModel, type FlowPulse, type GraphModel } from "../core/graph-model";
import { appendFlowEvent, type FlowEvent } from "../core/flow-events";
import { GraphCanvas } from "./GraphCanvas";
import { EventFlow } from "./EventFlow";
import "./im-graph.css";

/** 脉冲粒子存活时长:与 CSS 动画时长一致,播完即移除。 */
const PULSE_TTL_MS = 900;

export function ImGraphPanel({ isActive }: { isActive: boolean }): ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const pluginId = usePluginId();
  const [model, setModel] = useState<GraphModel>(emptyModel);
  const [pulses, setPulses] = useState<FlowPulse[]>([]);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [flowEvents, setFlowEvents] = useState<FlowEvent[]>([]);
  const observerRef = useRef<BusObserver | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!isActive || !ctx.bus) return;
    const observer = new BusObserver(ctx.bus, `plugin:${pluginId}`, {
      onModel: (m, p) => {
        setModel(m);
        if (p.length > 0) {
          setPulses((prev) => [...prev, ...p]);
          for (const pulse of p) {
            setTimeout(() => setPulses((prev) => prev.filter((x) => x.id !== pulse.id)), PULSE_TTL_MS);
          }
        }
      },
      onSessionEvent: (_key, eventType, event) => {
        setFlowEvents((prev) => appendFlowEvent(prev, eventType, event, Date.now(), seqRef.current++));
      },
    });
    observerRef.current = observer;
    void observer.start().catch(() => {});
    return () => {
      observerRef.current = null;
      void observer.stop();
      setPulses([]);
      setFocusedKey(null);
      setFlowEvents([]);
    };
  }, [isActive, ctx.bus, pluginId]);

  const onFocus = (key: string | null): void => {
    setFocusedKey(key);
    setFlowEvents([]);
    const observer = observerRef.current;
    if (!observer) return;
    if (key) void observer.focus(key).catch(() => {});
    else void observer.unfocus().catch(() => {});
  };

  const focusedLabel = focusedKey ? (model.sessions.get(focusedKey)?.label ?? focusedKey) : "";

  return (
    <div className="im-panel">
      <div className="im-toolbar">
        <span className="im-toolbar-title">{t("im-graph.title")}</span>
        <button
          type="button"
          className="im-refresh-btn"
          title={t("im-graph.refresh")}
          onClick={() => void observerRef.current?.refresh().catch(() => {})}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {model.sessions.size === 0 ? (
        <EmptyState
          icon={<Network size={28} />}
          title={t("im-graph.empty")}
          description={t("im-graph.emptyHint")}
        />
      ) : (
        <div className="im-body">
          <GraphCanvas
            model={model}
            pulses={pulses}
            channelsLabel={t("im-graph.channels")}
            focusedKey={focusedKey}
            onFocus={onFocus}
          />
          {focusedKey != null && (
            <EventFlow
              title={`${focusedLabel} · ${t("im-graph.flow.title")}`}
              events={flowEvents}
              onClose={() => onFocus(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
