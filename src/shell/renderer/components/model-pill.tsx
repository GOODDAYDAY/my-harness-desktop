// 模型 pill —— 标题栏居中的主交互:当前模型 + 思考强度,下拉即切。
//
// 当前值读 session-store 投影(不拉取);清单(models/levels)按 cwd 拉一次缓存
// (几乎不变);切换走 setModel/setThinkingLevel,modelSelect 事件回流进投影。
import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Check } from "lucide-react";
import { usePiApi, useUiStore, useSessionStore, type ModelInfo } from "@pi-desktop/react";

const LEVEL_ZH: Record<string, string> = {
  off: "关", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "极高",
};

export function ModelPill(): React.ReactNode {
  const pi = usePiApi();
  const { currentCwd } = useUiStore();
  const { snapshot } = useSessionStore();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [levels, setLevels] = useState<string[]>([]);

  // 清单在 pi 活着(有投影基线)时拉一次;低频不变,失败留空
  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    (async () => {
      try {
        const [ms, ls] = await Promise.all([pi.sessions.getModels(), pi.sessions.getThinkingLevels()]);
        if (cancelled) return;
        setModels(ms as ModelInfo[]);
        setLevels(ls);
      } catch {
        // pi 未就绪:清单留空,pill 显示当前值但下拉为空
      }
    })();
    return () => { cancelled = true; };
  }, [pi, snapshot]);

  const current = snapshot?.state.model ?? null;
  const level = snapshot?.state.thinkingLevel ?? "";
  if (!currentCwd || !current) return null;

  const pick = async (m: ModelInfo): Promise<void> => {
    await pi.sessions.setModel(m.provider, m.id).catch(() => {});
  };
  const pickLevel = async (l: string): Promise<void> => {
    await pi.sessions.setThinkingLevel(l).catch(() => {});
  };

  return (
    <div
      className="flex items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]"
      // @ts-expect-error Electron 拖拽区:标题栏里按钮要可点
      style={{ WebkitAppRegion: "no-drag" }}
    >
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="flex items-center gap-1 pl-3 pr-2 py-1 text-[13px] text-[var(--color-fg)] bg-transparent border-none cursor-pointer font-[var(--font-family-sans)]">
            {current.name || current.id}
            <ChevronDown className="size-3.5 text-[var(--color-muted)]" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="center" sideOffset={6} style={menuStyle} className="max-h-80 overflow-y-auto">
            {models.map((m) => (
              <DropdownMenu.Item key={`${m.provider}/${m.id}`} onSelect={() => void pick(m)} style={itemStyle}>
                <span className="flex-1 truncate">{m.name || m.id}</span>
                {current.provider === m.provider && current.id === m.id && <Check className="size-3.5" />}
              </DropdownMenu.Item>
            ))}
            {models.length === 0 && <div className="px-3 py-2 text-[13px] text-[var(--color-muted)]">无可用模型</div>}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <span className="w-px h-4 bg-[var(--color-border)]" />

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="flex items-center gap-1 pl-2 pr-3 py-1 text-[13px] text-[var(--color-muted)] bg-transparent border-none cursor-pointer font-[var(--font-family-sans)]">
            {LEVEL_ZH[level] ?? level}
            <ChevronDown className="size-3.5" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="center" sideOffset={6} style={menuStyle}>
            {levels.map((l) => (
              <DropdownMenu.Item key={l} onSelect={() => void pickLevel(l)} style={itemStyle}>
                <span className="flex-1">{LEVEL_ZH[l] ?? l}</span>
                {level === l && <Check className="size-3.5" />}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

const menuStyle: React.CSSProperties = {
  minWidth: "180px",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-lg)",
  padding: "4px",
  zIndex: 99999,
};

const itemStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "6px",
  padding: "6px 10px", borderRadius: "var(--radius-sm)",
  fontSize: "13px", color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)",
  cursor: "pointer", outline: "none",
};
