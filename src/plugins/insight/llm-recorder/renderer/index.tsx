// llm-recorder 插件 renderer —— sidePanel「请求记录」+ settings「请求记录」。
// 数据来自 pi-extension 落盘的 <cwd>/.pi-desktop/llm-logs/(设计 llm-recorder-design.md):
// 面板按当前会话文件名读全部分片、按 seq 配对渲染;设置页读 index.json 出统计、
// removePath 整目录清理、ctx.config 写记录开关(saveMode manual,即时生效不走 save 浮层)。
// 展开详情走结构化视图(payload-views):原始 JSON 墙拆成 System/工具/消息逐块折叠,
// 行内补用量摘要(↑↓⇄Σ);payload 尺寸按 seq 缓存——日志只追加,同 seq 尺寸永不变。
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Maximize2, ScrollText, Trash2 } from "lucide-react";
import {
  usePluginContext, useUiStore, useSessionStore,
  EmptyState, SettingsSection, Button,
} from "@pi-desktop/react";
import {
  pairRecords, parseIndex, parseLogText, shardNumber,
  type RecordPair,
} from "../core/log-model";
import { byteSize, peekUsage } from "../core/payload-model";
import { fmtBytes, fmtCount } from "./payload-views";
import { RecordDetail, RecordModal } from "./record-modal";

/* ============ 工具 ============ */

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function logDirOf(cwd: string): string {
  return `${cwd}/.pi-desktop/llm-logs`;
}

/* ============ sidePanel:当前会话的请求记录 ============ */

export function RecordsTab({ isActive }: { isActive: boolean }): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const cwd = useUiStore((s) => s.currentCwd);
  const sessionPath = useUiStore((s) => s.currentSessionPath);
  const messages = useSessionStore((s) => s.messages);

  const [pairs, setPairs] = useState<RecordPair[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);
  const [modalSeq, setModalSeq] = useState<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sizeCacheRef = useRef<Map<number, number>>(new Map());

  const base = sessionPath ? (sessionPath.split(/[\\/]/).pop() ?? null) : null;

  useEffect(() => {
    sizeCacheRef.current = new Map();
    setExpandedSeq(null);
    setModalSeq(null);
  }, [base, cwd]);

  const payloadSizeOf = (pair: RecordPair): number => {
    const cache = sizeCacheRef.current;
    let sz = cache.get(pair.seq);
    if (sz === undefined) {
      sz = byteSize(pair.request.payload);
      cache.set(pair.seq, sz);
    }
    return sz;
  };

  const load = useCallback(async (): Promise<void> => {
    if (!ctx.fs || !cwd || !base) {
      setPairs([]);
      setLoaded(true);
      return;
    }
    try {
      const dir = logDirOf(cwd);
      const entries = await ctx.fs.listDir(dir);
      const shards = entries
        .filter((e) => !e.isDir)
        .map((e) => ({ name: e.name, n: shardNumber(e.name, base) }))
        .filter((e): e is { name: string; n: number } => e.n !== null)
        .sort((a, b) => a.n - b.n);
      const lines = [];
      for (const s of shards) {
        lines.push(...parseLogText(await ctx.fs.readFile(`${dir}/${s.name}`)));
      }
      setPairs(pairRecords(lines));
    } catch {
      // 目录不存在(从未记录)或读失败 → 空列表
      setPairs([]);
    }
    setLoaded(true);
  }, [ctx.fs, cwd, base]);

  // 全量加载:切会话/切项目/面板激活
  useEffect(() => {
    setLoaded(false);
    void load();
  }, [load]);

  // 流式增量触发:messages 变化 → 400ms 尾沿防抖重读(事件驱动,不轮询)
  useEffect(() => {
    if (!isActive) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(), 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [messages, isActive, load]);

  if (!sessionPath) {
    return <EmptyState icon={<ScrollText size={28} />} title={t("panel.noSession")} />;
  }
  if (loaded && pairs.length === 0) {
    return <EmptyState icon={<ScrollText size={28} />} title={t("panel.empty")} description={t("panel.emptyHint")} />;
  }

  const modalPair = modalSeq !== null ? (pairs.find((x) => x.seq === modalSeq) ?? null) : null;

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "var(--spacing-sm)" }}>
      {pairs.map((p) => {
        const expanded = expandedSeq === p.seq;
        const status = p.response?.status;
        const failed = p.response === null || (status !== undefined && (status < 200 || status >= 300));
        const usage = p.response ? peekUsage(p.response.message) : undefined;
        return (
          <div key={p.seq} style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
            <div
              onClick={() => setExpandedSeq(expanded ? null : p.seq)}
              style={{
                display: "flex", alignItems: "center", flexWrap: "wrap",
                columnGap: "var(--spacing-sm)", rowGap: 2,
                padding: "var(--spacing-xs) var(--spacing-sm)", cursor: "pointer",
                fontSize: "var(--font-size-sm)", color: "var(--color-fg)",
              }}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span style={{ color: "var(--color-muted)", flexShrink: 0 }}>#{p.seq}</span>
              <span style={{ flexShrink: 0 }}>{fmtTime(p.request.ts)}</span>
              <span style={{ color: "var(--color-muted)", flexShrink: 0 }}>
                {p.request.turnIndex !== undefined ? t("panel.turn", { n: p.request.turnIndex }) : t("panel.internal")}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  color: p.response === null ? "var(--color-muted)" : failed ? "var(--color-danger, #f38ba8)" : "var(--color-accent-success)",
                }}
              >
                {p.response === null ? t("panel.notReturned") : status !== undefined ? String(status) : "—"}
              </span>
              {p.response?.durationMs !== undefined && (
                <span style={{ color: "var(--color-muted)", flexShrink: 0 }}>{(p.response.durationMs / 1000).toFixed(1)}s</span>
              )}
              {usage !== undefined && (
                <span style={{ color: "var(--color-muted)", flexShrink: 0, fontSize: "var(--font-size-xs)" }}>
                  {usage.input !== undefined && `↑${fmtCount(usage.input)}`}
                  {usage.output !== undefined && ` ↓${fmtCount(usage.output)}`}
                  {usage.cacheRead !== undefined && usage.cacheRead > 0 && ` ⇄${fmtCount(usage.cacheRead)}`}
                </span>
              )}
              <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", columnGap: "var(--spacing-sm)", flexShrink: 0 }}>
                <span
                  title={t("panel.expand")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setModalSeq(p.seq);
                  }}
                  style={{ color: "var(--color-muted)", cursor: "pointer", display: "inline-flex", alignItems: "center" }}
                >
                  <Maximize2 size={13} />
                </span>
                <span style={{ color: "var(--color-muted)" }}>{fmtBytes(payloadSizeOf(p))}</span>
              </span>
            </div>
            {expanded && (
              <div style={{ borderTop: "1px solid var(--color-border)", padding: "var(--spacing-sm)" }}>
                <RecordDetail pair={p} />
              </div>
            )}
          </div>
        );
      })}
      </div>
      {modalPair !== null && <RecordModal pair={modalPair} onClose={() => setModalSeq(null)} />}
    </>
  );
}

/* ============ settings:统计 + 清理 + 记录开关 ============ */

export function RecorderSettings(): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const cwd = useUiStore((s) => s.currentCwd);

  const [enabled, setEnabled] = useState(true);
  const [sessions, setSessions] = useState(0);
  const [requests, setRequests] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [cleanArmed, setCleanArmed] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    const v = await ctx.config.get<boolean>("recordEnabled");
    setEnabled(v ?? true);
    if (!ctx.fs || !cwd) {
      setSessions(0);
      setRequests(0);
      setBytes(0);
      return;
    }
    try {
      const text = await ctx.fs.readFile(`${logDirOf(cwd)}/index.json`);
      const idx = parseIndex(text);
      const all = idx ? Object.values(idx) : [];
      setSessions(all.length);
      setRequests(all.reduce((s, x) => s + (x.requests || 0), 0));
      setBytes(all.reduce((s, x) => s + (x.bytes || 0), 0));
    } catch {
      // index.json 不存在(从未记录/刚清理)→ 全零
      setSessions(0);
      setRequests(0);
      setBytes(0);
    }
  }, [ctx.config, ctx.fs, cwd]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = async (): Promise<void> => {
    const next = !enabled;
    setEnabled(next);
    await ctx.config.set("recordEnabled", next);
  };

  const cleanup = async (): Promise<void> => {
    if (!cleanArmed) {
      setCleanArmed(true);
      return;
    }
    if (ctx.fs && cwd) {
      try {
        await ctx.fs.removePath(logDirOf(cwd));
      } catch { /* 目录已不存在也算清净 */ }
    }
    setCleanArmed(false);
    await reload();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      <SettingsSection title={t("settings.recordSection")} description={t("settings.timingNote")}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
          <div
            onClick={() => void toggle()}
            title={t("settings.recordEnabled")}
            style={{
              width: 28, height: 16, borderRadius: 8, position: "relative", flexShrink: 0,
              background: enabled ? "var(--color-accent-success)" : "var(--color-border)",
              transition: "background 0.15s", cursor: "pointer",
            }}
          >
            <div style={{
              width: 12, height: 12, borderRadius: "50%", background: "var(--color-fg)",
              position: "absolute", top: 2, left: enabled ? 14 : 2, transition: "left 0.15s",
            }} />
          </div>
          <span style={{ fontSize: "var(--font-size-sm)" }}>{t("settings.recordEnabled")}</span>
        </div>
      </SettingsSection>

      <SettingsSection title={t("settings.statsSection")} description={t("settings.sensitiveNote")}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)", fontSize: "var(--font-size-sm)" }}>
          <div>{t("settings.sessionCount")}: {sessions}</div>
          <div>{t("settings.requestCount")}: {requests}</div>
          <div>{t("settings.totalBytes")}: {fmtBytes(bytes)}</div>
        </div>
        <div style={{ marginTop: "var(--spacing-md)", display: "flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
          <Button variant={cleanArmed ? "danger" : "secondary"} onClick={() => void cleanup()} disabled={!cwd || !ctx.fs}>
            <Trash2 size={14} style={{ marginRight: 4, verticalAlign: "-2px" }} />
            {cleanArmed ? t("settings.cleanupConfirm") : t("settings.cleanup")}
          </Button>
          {cleanArmed && (
            <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }} onClick={() => setCleanArmed(false)}>
              {t("settings.cleanupCancel")}
            </span>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
