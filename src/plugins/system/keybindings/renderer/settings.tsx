// 快捷键设置页 —— 动态事件列表 + 录制式绑定编辑。
//
// 核心:事件列表不写死,实时来自 eventBus.listChannels()(当前已加载插件的全部
// channel),插件装/卸后自动增删。绑定 = 组合键 + 目标事件(+可选 payload)。
// 配置经 settings 槽框架托管(configFile 统一通道),onChange 报告改动。
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsSection, eventBus, useUiStore, type SettingsComponentProps } from "@pi-desktop/react";
import type { ChannelInfo } from "@pi-desktop/contract";
import { comboFromEvent } from "../core/combo";
import { DEFAULT_BINDINGS, type Binding, type InputWhen } from "../core/bindings";

type AddingState =
  | { phase: "idle" }
  | { phase: "recording"; editingIndex?: number }
  | { phase: "configuring"; combo: string; channel: string; payloadText: string; when: InputWhen; editingIndex?: number };

/** 平台主修饰键的展示名(录制提示用):mac=⌘,其余=Ctrl。 */
function modLabel(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
}

export function KeybindingsSettings({ config, onChange }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const bindings = useMemo(
    () => (Array.isArray(config?.bindings) ? (config!.bindings as Binding[]) : DEFAULT_BINDINGS),
    [config],
  );

  // 动态事件列表:已加载插件的全部 channel;插件装/卸时框架 bump pluginsNonce,据此刷新。
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<AddingState>({ phase: "idle" });

  useEffect(() => {
    setChannels(eventBus.listChannels());
  }, [pluginsNonce]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter((c) =>
      c.channel.toLowerCase().includes(q)
      || c.meta?.label?.toLowerCase().includes(q)
      || c.meta?.description?.toLowerCase().includes(q),
    );
  }, [channels, query]);

  const byPlugin = useMemo(() => {
    const map = new Map<string, ChannelInfo[]>();
    for (const c of filtered) {
      const arr = map.get(c.pluginId) ?? [];
      arr.push(c);
      map.set(c.pluginId, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const commit = (bindings: Binding[]): void => {
    onChange({ ...(config ?? {}), bindings });
  };

  // 录制模式下监听器要读的绑定与提交函数:放 ref,避免 keydown 监听因依赖重绑。
  // 录制窗口(phase==="recording")内这些值不会变——按键期间无其他路径改绑定——
  // ref 语义足够,监听器生命周期严格等于录制窗口,不随无关 render 抖动。
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // 录制模式:window 级捕获 keydown,组合键即绑定串;Esc 取消。
  useEffect(() => {
    if (adding.phase !== "recording") return;
    const editingIndex = adding.editingIndex;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setAdding({ phase: "idle" }); return; }
      const combo = comboFromEvent(e);
      if (!combo) return;
      if (editingIndex !== undefined) {
        // 修改快捷键:录到新组合键即原位替换,不进入 configuring(用户要改的是键位本身,
        // 不是 channel/payload/when 等绑定内容)
        const cur = bindingsRef.current;
        const next = [...cur];
        next[editingIndex] = { ...cur[editingIndex], combo };
        commitRef.current(next);
        setAdding({ phase: "idle" });
        return;
      }
      setAdding({ phase: "configuring", combo, channel: "", payloadText: "", when: "smart" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [adding]);

  const removeBinding = (index: number): void => {
    const next = [...bindings];
    next.splice(index, 1);
    commit(next);
  };

  const saveNew = (): void => {
    if (adding.phase !== "configuring") return;
    const { combo, channel, payloadText, when, editingIndex } = adding;
    if (!combo || !channel) return;
    let payload: unknown;
    if (payloadText.trim().length > 0) {
      try {
        payload = JSON.parse(payloadText);
      } catch {
        return; // JSON 非法:留在编辑态让用户改
      }
    }
    const entry = { combo, channel, ...(payload !== undefined ? { payload } : {}), when };
    if (editingIndex !== undefined) {
      // 编辑:原位替换,不删了再加(保留顺序与其余绑定)
      const next = [...bindings];
      next[editingIndex] = entry;
      commit(next);
    } else {
      commit([...bindings, entry]);
    }
    setAdding({ phase: "idle" });
    setQuery("");
  };

  const selectChannel = (channel: string): void => {
    if (adding.phase !== "configuring") return;
    const meta = channels.find((c) => c.channel === channel)?.meta;
    setAdding({
      ...adding,
      channel,
      payloadText: meta?.payloadExample !== undefined ? JSON.stringify(meta.payloadExample, null, 2) : "",
    });
  };

  const hasRegistered = (channel: string): boolean => channels.some((c) => c.channel === channel);

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection title={t("keybindings.bindings")} description={t("keybindings.bindingsDesc")}>
        <div className="flex items-center justify-between gap-2 pb-2">
          <span className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">
            {t("keybindings.bindingCount", { count: bindings.length })}
          </span>
          <div className="flex gap-2">
            <button
              className="px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] text-[length:var(--font-size-sm)] text-[var(--color-fg)] bg-[var(--color-surface)] cursor-pointer hover:border-[var(--color-accent)]"
              onClick={() => commit([...DEFAULT_BINDINGS])}
            >
              {t("keybindings.resetDefaults")}
            </button>
            {adding.phase === "idle" && (
              <button
                className="px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--color-accent)] text-[length:var(--font-size-sm)] text-[var(--color-accent)] bg-transparent cursor-pointer hover:bg-[var(--color-accent)]/10"
                onClick={() => setAdding({ phase: "recording" })}
              >
                {t("keybindings.addBinding")}
              </button>
            )}
          </div>
        </div>

        {bindings.length === 0 && adding.phase === "idle" && (
          <div className="py-4 text-center text-[length:var(--font-size-sm)] text-[var(--color-muted)]">
            {t("keybindings.noBindings")}
          </div>
        )}

        <div className="grid grid-cols-2 gap-1.5">
          {bindings.map((b, i) => {
            const info = channels.find((c) => c.channel === b.channel);
            return (
              <div key={i} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 min-w-0">
                <kbd className="flex-none rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[length:var(--font-size-xs)] text-[var(--color-accent)]">
                  {b.combo.replace("mod", modLabel())}
                </kbd>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-[length:var(--font-size-sm)] text-[var(--color-fg)]">
                    {info?.meta?.label ?? b.channel}
                  </div>
                  <div className="truncate font-mono text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
                    {b.channel}
                    {!hasRegistered(b.channel) && ` · ${t("keybindings.channelMissing")}`}
                  </div>
                </div>
                {b.payload !== undefined && (
                  <span className="flex-none font-mono text-[length:var(--font-size-xs)] text-[var(--color-muted)] truncate max-w-[90px]">
                    {JSON.stringify(b.payload)}
                  </span>
                )}
                <button
                  className="flex-none size-6 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-bg)] cursor-pointer"
                  onClick={() => setAdding({ phase: "recording", editingIndex: i })}
                  title={t("keybindings.editBinding")}
                >
                  ✎
                </button>
                <button
                  className="flex-none size-6 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-accent-error)] hover:bg-[var(--color-bg)] cursor-pointer"
                  onClick={() => removeBinding(i)}
                  title={t("keybindings.remove")}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>

        {adding.phase === "recording" && (
          <div className="mt-3 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-accent)] px-3 py-4 text-center">
            <div className="text-[length:var(--font-size-sm)] text-[var(--color-fg)]">
              {adding.editingIndex !== undefined ? t("keybindings.recordingEdit") : t("keybindings.recording")}
            </div>
            <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] mt-1">{t("keybindings.recordingHint", { mod: modLabel() })}</div>
          </div>
        )}

        {adding.phase === "configuring" && (
          <div className="mt-3 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <kbd className="rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[length:var(--font-size-sm)] text-[var(--color-accent)]">
                {adding.combo.replace("mod", modLabel())}
              </kbd>
              <span className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{t("keybindings.chooseEvent")}</span>
              <span className="ml-auto flex gap-2">
                <button
                  className="px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] text-[length:var(--font-size-sm)] text-[var(--color-muted)] cursor-pointer hover:text-[var(--color-fg)]"
                  onClick={() => setAdding({ phase: "recording", editingIndex: adding.editingIndex })}
                >
                  {t("keybindings.reRecord")}
                </button>
                <button
                  className="px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] text-[length:var(--font-size-sm)] text-[var(--color-muted)] cursor-pointer hover:text-[var(--color-fg)]"
                  onClick={() => setAdding({ phase: "idle" })}
                >
                  {t("keybindings.cancel")}
                </button>
              </span>
            </div>

            <input
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[length:var(--font-size-sm)] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
              placeholder={t("keybindings.searchEvents")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className="max-h-56 overflow-y-auto flex flex-col gap-1 pr-1">
              {byPlugin.map(([pluginId, items]) => (
                <div key={pluginId}>
                  <div className="px-1 py-1 text-[length:var(--font-size-xs)] font-semibold text-[var(--color-muted)] uppercase">
                    {pluginId}
                  </div>
                  {items.map((c) => {
                    const selected = adding.channel === c.channel;
                    return (
                      <button
                        key={c.channel}
                        className={`w-full text-left flex flex-col gap-0.5 rounded-[var(--radius-sm)] px-2 py-1.5 cursor-pointer ${selected ? "bg-[var(--color-accent)]/10 border border-[var(--color-accent)]" : "border border-transparent hover:bg-[var(--color-bg)]"}`}
                        onClick={() => selectChannel(c.channel)}
                      >
                        <span className="font-mono text-[length:var(--font-size-xs)] text-[var(--color-accent)]">{c.channel}</span>
                        {c.meta?.label && <span className="text-[length:var(--font-size-sm)] text-[var(--color-fg)]">{c.meta.label}</span>}
                        {c.meta?.description && <span className="text-[length:var(--font-size-xs)] text-[var(--color-muted)]">{c.meta.description}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="py-3 text-center text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{t("keybindings.noEvents")}</div>
              )}
            </div>

            {adding.channel && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{t("keybindings.when")}</span>
                  <select
                    className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[length:var(--font-size-sm)] text-[var(--color-fg)] outline-none"
                    value={adding.when}
                    onChange={(e) => setAdding({ ...adding, when: e.target.value as InputWhen })}
                  >
                    <option value="smart">{t("keybindings.whenSmart")}</option>
                    <option value="always">{t("keybindings.whenAlways")}</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{t("keybindings.payload")}</span>
                  <textarea
                    className="w-full h-24 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-[length:var(--font-size-xs)] text-[var(--color-fg)] outline-none resize-y focus:border-[var(--color-accent)]"
                    placeholder={t("keybindings.payloadPlaceholder")}
                    value={adding.payloadText}
                    onChange={(e) => setAdding({ ...adding, payloadText: e.target.value })}
                  />
                  <span className="text-[length:var(--font-size-xs)] text-[var(--color-muted)]">{t("keybindings.payloadHint")}</span>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    className="px-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--color-accent)] text-[length:var(--font-size-sm)] text-[var(--color-accent)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={!adding.channel}
                    onClick={saveNew}
                  >
                    {t("keybindings.save")}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
