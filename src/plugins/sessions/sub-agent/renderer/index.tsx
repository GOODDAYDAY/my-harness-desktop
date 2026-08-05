/**
 * sub-agent 插件 renderer 入口 —— manifest component 名与 export 一一对应(框架自动匹配)。
 * SubAgentSection 是编排宿主:sidebar 常驻,useEffect 里挂 bus.onMessage 驱动 orchestrator
 * (三槽组件查表渲染不常驻,设计 §7.2 风险一的解法);无活跃子时 return null,不占左栏。
 */
import { useEffect, useState, type ReactNode } from "react";
import { ListItem, Section, usePluginContext, usePluginId, useUiStore } from "@pi-desktop/react";
import { useTranslation } from "react-i18next";
import { ensureOrchestrator } from "./orchestrator-singleton";

export { SpawnCard, SpawnDoneCard } from "./spawn-card";
export { SubAgentPanel } from "./panel";
export { SubAgentSettings } from "./settings";

export function SubAgentSection(): ReactNode {
  const ctx = usePluginContext();
  const pluginId = usePluginId();
  const { t } = useTranslation();
  const cwd = useUiStore((s) => s.currentCwd);
  const orch = ensureOrchestrator(ctx, pluginId);
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!orch || !ctx.bus) return;
    const offBus = ctx.bus.onMessage((msg) => void orch.handleFrame(msg));
    const offChange = orch.onChange(() => setVersion((v) => v + 1));
    return () => {
      offBus();
      offChange();
    };
  }, [ctx, orch]);

  if (!orch) return null;
  const active = orch.getSubs().filter((s) => s.status === "running");
  if (active.length === 0) return null;

  return (
    <Section title={t("sub-agent.sectionTitle")}>
      {active.slice(0, 3).map((s) => (
        <ListItem key={s.addr} onClick={() => { if (cwd) void ctx.sessions.setContext(cwd, s.sessionPath); }}>
          <span className="text-[length:var(--font-size-sm)]">● {s.name}</span>
        </ListItem>
      ))}
      {active.length > 3 && (
        <div className="px-2 text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
          +{active.length - 3} {t("sub-agent.sectionMore")}
        </div>
      )}
    </Section>
  );
}
