// im-graph/renderer/GraphCanvas —— SVG 左右两段图渲染:会话树在左(spawn 树连接线),
// 房间在右列(y 取成员均值),脉冲粒子沿边流动(CSS 变量传起止点,keyframes 驱动 cx/cy)。
// 聚焦交互:点会话节点 → focusedKey,其余节点/边 dim 沉入背景,选中节点发光,
// 与其直接相连的边(spawn 直系 + 所在房间)转蚂蚁线持续流动;再点一次取消。
// 纯展示组件:模型/布局/linked 集全在 core/graph-model,本文件只管坐标 → SVG 元素。
import { useMemo, type CSSProperties, type ReactNode } from "react";
import { Hash } from "lucide-react";
import {
  edgesOf, layout, linkedRefs, sessionRef,
  type FlowPulse, type GraphModel, type PlacedNode,
} from "../core/graph-model";

const SETTLED_FLASH_MS = 2000;
const THROTTLE_FLASH_MS = 2000;

export function GraphCanvas({ model, pulses, channelsLabel, focusedKey, onFocus }: {
  model: GraphModel;
  pulses: FlowPulse[];
  channelsLabel: string;
  focusedKey: string | null;
  onFocus(key: string | null): void;
}): ReactNode {
  const view = useMemo(() => layout(model), [model]);
  const edges = useMemo(() => edgesOf(model), [model]);
  const posOf = useMemo(() => new Map(view.nodes.map((n) => [n.ref, n])), [view]);
  const linked = useMemo(() => (focusedKey ? linkedRefs(model, focusedKey) : null), [model, focusedKey]);
  const activeEdges = useMemo(() => {
    const set = new Set<string>();
    for (const p of pulses) set.add(`${p.path[0]}→${p.path[1]}`);
    return set;
  }, [pulses]);
  const now = Date.now();

  const center = (n: PlacedNode): { cx: number; cy: number } => ({ cx: n.x + n.w / 2, cy: n.y + n.h / 2 });
  const dim = (ref: string): boolean => linked != null && !linked.has(ref);
  const edgeClass = (from: string, to: string, base: string): string => {
    const focusedRef = focusedKey ? sessionRef(focusedKey) : null;
    const isLinked = focusedRef != null && (from === focusedRef || to === focusedRef)
      && linked != null && linked.has(from) && linked.has(to);
    const isActive = activeEdges.has(`${from}→${to}`) || activeEdges.has(`${to}→${from}`);
    return `${base}${dim(from) && dim(to) ? " dim" : ""}${isLinked ? " im-edge-linked" : isActive ? " im-edge-active" : ""}`;
  };

  return (
    <svg viewBox={`0 0 ${view.width} ${view.height}`} className="im-canvas">
      {/* spawn 树连接线:父底中点 → 折线 → 子左中点 */}
      {edges.spawn.map(({ from, to }) => {
        const parent = posOf.get(from);
        const child = posOf.get(to);
        if (!parent || !child) return null;
        const d = `M ${parent.x + parent.w / 2} ${parent.y + parent.h} V ${child.y + child.h / 2} H ${child.x}`;
        return <path key={`${from}→${to}`} d={d} className={edgeClass(from, to, "im-edge im-edge-spawn")} />;
      })}

      {/* 房间成员连线:会话右中点 → 房间 chip 左中点(横向微弯) */}
      {edges.member.map(({ from, to }) => {
        const session = posOf.get(from);
        const channel = posOf.get(to);
        if (!session || !channel) return null;
        const ay = session.y + session.h / 2;
        const by = channel.y + channel.h / 2;
        const d = `M ${session.x + session.w} ${ay} C ${session.x + session.w + 24} ${ay}, ${channel.x - 24} ${by}, ${channel.x} ${by}`;
        return <path key={`${from}→${to}`} d={d} className={edgeClass(from, to, "im-edge im-edge-member")} />;
      })}

      {/* 房间列分段标题 */}
      {view.channelsHeader != null && (
        <text
          x={view.channelsHeader.x} y={view.channelsHeader.y}
          className={`im-section-label${linked ? " dim" : ""}`}
        >
          {channelsLabel}
        </text>
      )}

      {/* 节点 */}
      {view.nodes.map((n) => {
        if (n.kind === "session") {
          const key = n.ref.slice(2);
          const node = model.sessions.get(key);
          if (!node) return null;
          const settled = node.settledAt != null && now - node.settledAt < SETTLED_FLASH_MS;
          return (
            <g
              key={n.ref}
              className={`im-node${node.busy ? " im-node-busy" : ""}${dim(n.ref) ? " dim" : ""}${focusedKey === key ? " im-node-focused" : ""}`}
              onClick={() => onFocus(focusedKey === key ? null : key)}
            >
              <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={4} className="im-node-rect">
                <title>{node.title}</title>
              </rect>
              <text x={n.x + 6} y={n.y + n.h / 2} className="im-node-label" dominantBaseline="central">
                {node.label}
              </text>
              {settled && <circle cx={n.x + n.w - 8} cy={n.y + n.h / 2} r={3} className="im-settled-dot" />}
            </g>
          );
        }
        const channel = model.channels.get(n.ref.slice(2));
        const throttled = channel?.throttledAt != null && now - channel.throttledAt < THROTTLE_FLASH_MS;
        return (
          <g key={n.ref} className={`im-channel${throttled ? " im-channel-throttled" : ""}${dim(n.ref) ? " dim" : ""}`}>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={9} className="im-channel-rect" />
            <Hash size={9} className="im-channel-icon" x={n.x + 6} y={n.y + n.h / 2 - 4.5} />
            <text x={n.x + 18} y={n.y + n.h / 2} className="im-channel-label" dominantBaseline="central">
              {n.ref.slice(2)}
            </text>
          </g>
        );
      })}

      {/* 流动脉冲粒子:起止点经 CSS 变量传给 keyframes */}
      {pulses.map((p) => {
        const a = posOf.get(p.path[0]);
        const b = posOf.get(p.path[1]);
        if (!a || !b) return null;
        const from = center(a);
        const to = center(b);
        return (
          <circle
            key={p.id}
            r={3}
            className={`im-pulse im-pulse-${p.kind}${p.status && p.status !== "done" ? " im-pulse-error" : ""}`}
            style={{
              "--fx": `${from.cx}px`, "--fy": `${from.cy}px`,
              "--tx": `${to.cx}px`, "--ty": `${to.cy}px`,
            } as CSSProperties}
          />
        );
      })}
    </svg>
  );
}
