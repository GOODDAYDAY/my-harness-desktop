// im-graph/renderer/GraphCanvas —— SVG 竖向图渲染:上段会话树(spawn 父子树连接线),
// 下段房间区(成员连线),脉冲粒子沿边流动(CSS 变量传起止点,keyframes 驱动 cx/cy)。
// 纯展示组件:模型/布局全在 core/graph-model,本文件只管坐标 → SVG 元素。
import { useMemo, type ReactNode } from "react";
import { Hash } from "lucide-react";
import {
  edgesOf, layout, type FlowPulse, type GraphModel, type PlacedNode,
} from "../core/graph-model";

const SETTLED_FLASH_MS = 2000;
const THROTTLE_FLASH_MS = 2000;

export function GraphCanvas({ model, pulses, channelsLabel }: {
  model: GraphModel;
  pulses: FlowPulse[];
  channelsLabel: string;
}): ReactNode {
  const view = useMemo(() => layout(model), [model]);
  const edges = useMemo(() => edgesOf(model), [model]);
  const posOf = useMemo(() => new Map(view.nodes.map((n) => [n.ref, n])), [view]);
  const activeEdges = useMemo(() => {
    const set = new Set<string>();
    for (const p of pulses) set.add(`${p.path[0]}→${p.path[1]}`);
    return set;
  }, [pulses]);
  const now = Date.now();

  const center = (n: PlacedNode): { cx: number; cy: number } => ({ cx: n.x + n.w / 2, cy: n.y + n.h / 2 });

  return (
    <svg viewBox={`0 0 ${view.width} ${view.height}`} className="im-canvas">
      {/* spawn 树连接线:父底中点 → 折线 → 子左中点 */}
      {edges.spawn.map(({ from, to }) => {
        const parent = posOf.get(from);
        const child = posOf.get(to);
        if (!parent || !child) return null;
        const active = activeEdges.has(`${from}→${to}`);
        const d = `M ${parent.x + parent.w / 2} ${parent.y + parent.h} V ${child.y + child.h / 2} H ${child.x}`;
        return <path key={`${from}→${to}`} d={d} className={`im-edge im-edge-spawn${active ? " im-edge-active" : ""}`} />;
      })}

      {/* 房间成员连线:会话右中点 → 房间 chip 中点 */}
      {edges.member.map(({ from, to }) => {
        const session = posOf.get(from);
        const channel = posOf.get(to);
        if (!session || !channel) return null;
        const active = activeEdges.has(`${from}→${to}`) || activeEdges.has(`${to}→${from}`);
        const a = { x: session.x + session.w, y: session.y + session.h / 2 };
        const b = center(channel);
        const d = `M ${a.x} ${a.y} C ${a.x + 40} ${a.y}, ${b.cx - 40} ${b.cy}, ${b.cx} ${b.cy}`;
        return <path key={`${from}→${to}`} d={d} className={`im-edge im-edge-member${active ? " im-edge-active" : ""}`} />;
      })}

      {/* 房间区分段标题 */}
      {view.channelsHeaderY != null && (
        <text x={8} y={view.channelsHeaderY + 8} className="im-section-label">{channelsLabel}</text>
      )}

      {/* 节点 */}
      {view.nodes.map((n) => {
        if (n.kind === "session") {
          const node = model.sessions.get(n.ref.slice(2));
          if (!node) return null;
          const settled = node.settledAt != null && now - node.settledAt < SETTLED_FLASH_MS;
          return (
            <g key={n.ref} className={`im-node${node.busy ? " im-node-busy" : ""}`}>
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
          <g key={n.ref} className={`im-channel${throttled ? " im-channel-throttled" : ""}`}>
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
            } as React.CSSProperties}
          />
        );
      })}
    </svg>
  );
}
