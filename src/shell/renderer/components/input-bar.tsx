// 输入栏 —— ChatGPT 式:模型切换行 + 统计行 + composer,常驻不收起。
//
// 主体功能(非插件):模型/思考强度切换 + token 用量统计(上下文占用/已用/上限/
// 上传/下载/cache/TPS/effort/总消耗)。模型行对称原 ModelPill;统计行读 getStats
// (底座 get_session_stats)+ 事件流刷新(messageEnd/agentSettled 后重拉)。
import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useTranslation } from "react-i18next";
import { ChevronDown, Check } from "lucide-react";
import { usePiApi, useUiStore, useSessionStore, type ModelInfo, type SessionStats } from "@pi-desktop/react";
import { Composer } from "../ui/composer";

/** 思考强度 level 值 → i18n key 后缀(off/minimal/low/medium/high/xhigh)。 */
const LEVEL_KEY: Record<string, string> = {
  off: "shell.levelOff", minimal: "shell.levelMinimal", low: "shell.levelLow",
  medium: "shell.levelMedium", high: "shell.levelHigh", xhigh: "shell.levelXhigh",
};

export interface InputBarProps {
  value: string;
  onValueChange: (v: string) => void;
  onSubmit: () => void | Promise<void>;
  sending?: boolean;
  streaming?: boolean;
  onStop?: () => void;
}

export function InputBar(props: InputBarProps): React.ReactNode {
  const pi = usePiApi();
  const { t } = useTranslation();
  const { currentCwd } = useUiStore();
  const { snapshot } = useSessionStore();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [levels, setLevels] = useState<string[]>([]);
  const [stats, setStats] = useState<SessionStats | null>(null);

  const levelLabel = (l: string): string => (LEVEL_KEY[l] ? t(LEVEL_KEY[l]) : l);
  const refreshStats = (): void => { void pi.sessions.getStats().then((s) => setStats(s as SessionStats)).catch(() => {}); };

  // pi 就绪后拉模型/级别清单 + 统计
  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    (async () => {
      try {
        const [ms, ls] = await Promise.all([pi.sessions.getModels(), pi.sessions.getThinkingLevels()]);
        if (cancelled) return;
        setModels(ms as ModelInfo[]);
        setLevels(ls);
        refreshStats();
      } catch { /* pi 未就绪:清单留空 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pi, snapshot]);

  // 事件流刷新统计:messageEnd(一轮完)/agentSettled(整轮完)后重拉 getStats
  useEffect(() => {
    const off = pi.sessions.onEvent((event) => {
      if (event.type === "messageEnd" || event.type === "agentSettled" || event.type === "agentEnd") refreshStats();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pi]);

  const current = snapshot?.state.model ?? null;
  const level = snapshot?.state.thinkingLevel ?? "";
  const effort = level || "off";

  const pickModel = async (m: ModelInfo): Promise<void> => { await pi.sessions.setModel(m.provider, m.id).catch(() => {}); };
  const pickLevel = async (l: string): Promise<void> => { await pi.sessions.setThinkingLevel(l).catch(() => {}); };

  // 模型按供应商分组
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of models) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider)!.push(m);
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/* 模型切换行 */}
      <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)] cursor-pointer">
              <span className="truncate max-w-[180px]">{current ? (current.name || current.id) : t("shell.noModels")}</span>
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" sideOffset={4} style={menuStyle} className="max-h-80 overflow-y-auto">
              {[...byProvider.entries()].map(([provider, ms]) => (
                <div key={provider}>
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{provider}</div>
                  {ms.map((m) => (
                    <DropdownMenu.Item key={`${m.provider}/${m.id}`} onSelect={() => void pickModel(m)} style={itemStyle}>
                      <span className="flex-1 truncate">{m.name || m.id}</span>
                      {current?.provider === m.provider && current?.id === m.id && <Check className="size-3.5" />}
                    </DropdownMenu.Item>
                  ))}
                </div>
              ))}
              {models.length === 0 && <div className="px-3 py-2 text-[13px] text-[var(--color-muted)]">{t("shell.noModels")}</div>}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] cursor-pointer">
              <span>{levelLabel(level)}</span>
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" sideOffset={4} style={menuStyle}>
              {levels.map((l) => (
                <DropdownMenu.Item key={l} onSelect={() => void pickLevel(l)} style={itemStyle}>
                  <span className="flex-1">{levelLabel(l)}</span>
                  {level === l && <Check className="size-3.5" />}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {/* 统计行:上下文比例条 + 已用/上限 + 上传/下载/cache/TPS/effort/总消耗 */}
      <StatsRow stats={stats} contextWindow={current?.contextWindow ?? 0} effort={effort} t={t} />

      <Composer {...props} />
    </div>
  );
}

function StatsRow({ stats, contextWindow, effort, t }: {
  stats: SessionStats | null;
  contextWindow: number;
  effort: string;
  t: (k: string, vars?: Record<string, unknown>) => string;
}): React.ReactNode {
  const ctx = stats?.contextUsage;
  const used = ctx?.tokens ?? 0;
  const limit = ctx?.contextWindow ?? contextWindow;
  const pct = ctx?.percent ?? (limit > 0 ? Math.min(100, (used / limit) * 100) : 0);
  const tok = stats?.tokens;
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return (
    <div className="flex items-center gap-2.5 text-[11px] text-[var(--color-muted)] font-[var(--font-family-mono)]">
      {/* 上下文占用比例条 */}
      <div className="flex items-center gap-1.5" title={t("shell.contextUsed", { used: fmt(used), limit: fmt(limit) })}>
        <span className="font-[var(--font-family-sans)]">{t("shell.context")}</span>
        <div className="w-16 h-1 rounded-full bg-[var(--color-border)] overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 80 ? "var(--color-accent-warning)" : "var(--color-primary)" }} />
        </div>
        <span>{Math.round(pct)}%</span>
      </div>
      <span>·</span>
      {/* 上传/下载 */}
      <span title={t("shell.tokensUp")}><span className="font-[var(--font-family-sans)]">↑</span> {fmt(tok?.input ?? 0)}</span>
      <span title={t("shell.tokensDown")}><span className="font-[var(--font-family-sans)]">↓</span> {fmt(tok?.output ?? 0)}</span>
      {/* cache */}
      <span title={t("shell.cache")}><span className="font-[var(--font-family-sans)]">⇄</span> {fmt((tok?.cacheRead ?? 0) + (tok?.cacheWrite ?? 0))}</span>
      {/* TPS */}
      {stats?.tps != null && <><span>·</span><span title={t("shell.tpsTitle")}><span className="font-[var(--font-family-sans)]">⚡</span> {stats.tps.toFixed(1)}/s</span></>}
      {/* effort/thinking */}
      <span>·</span>
      <span title={t("shell.effortTitle")}><span className="font-[var(--font-family-sans)]">{t("shell.effort")}</span> {effort}</span>
      {/* 总消耗 */}
      <span>·</span>
      <span title={t("shell.totalTitle")}><span className="font-[var(--font-family-sans)]">{t("shell.total")}</span> {fmt(tok?.total ?? 0)}</span>
    </div>
  );
}

const menuStyle: React.CSSProperties = {
  minWidth: "200px",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-lg)",
  padding: "4px",
  zIndex: 99999,
};
const itemStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "6px",
  padding: "5px 10px", borderRadius: "var(--radius-sm)",
  fontSize: "13px", color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)",
  cursor: "pointer", outline: "none",
};
