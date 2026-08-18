/**
 * spawn/done 卡片(messageRenderers 槽,渲染父会话时间线里的 subagent 事件)。
 *
 * 展示约定(需求拍板:卡片收起,能看、当个 session):
 * - 默认折叠成一行摘要(icon + name + 状态/任务首行)——批量派活不再刷屏。
 * - 点击展开详情:spawn 卡看 task 全文,done 卡看输出预览;「打开」直接切入子会话,
 *   「对话」打开与子会话的对话面板(renderer/dialog.tsx)。
 * - 全量输出不进父会话文件(避免撑爆时间线),内容在子会话文件里,经「打开/对话」进入。
 */
import { useEffect, useState, type ReactNode } from "react";
import { messageContentText } from "@my-harness-desktop/contract";
import { usePluginContext, useUiStore, type MessageRendererProps } from "@my-harness-desktop/react";
import { useTranslation } from "react-i18next";
import type { SubStatus } from "../core/orchestrator";
import { peekOrchestrator } from "./orchestrator-singleton";
import { openDialogFor } from "./dialog-state";

interface SpawnedPayload {
  subagent: string;
  subagent_session: string;
  task: string;
  name?: string;
  tool_config?: unknown;
  cwd?: string;
}

interface DonePayload {
  subagent: string;
  subagent_session?: string;
  name?: string;
  status: SubStatus;
  output_preview?: string;
  cwd?: string;
}

function parsePayload<T>(content: unknown): T | null {
  try {
    return JSON.parse(messageContentText(content)) as T;
  } catch {
    return null;
  }
}

function statusIcon(status: SubStatus | undefined): string {
  switch (status) {
    case "done": return "✅";
    case "running": return "●";
    case "timeout": return "⏳";
    case "error":
    case "aborted":
    case "interrupted":
    case "spawn_failed": return "❌";
    default: return "●";
  }
}

function useSubStatus(addr: string | undefined): SubStatus | undefined {
  const orch = peekOrchestrator();
  const [, setVersion] = useState(0);
  useEffect(() => orch?.onChange(() => setVersion((v) => v + 1)), [orch]);
  return addr ? orch?.getSub(addr)?.status : undefined;
}

const cardStyle = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  padding: "4px 12px",
  margin: "2px 0",
  maxWidth: "480px",
} as const;

/** 折叠行摘要:任务取首行,超出省略;点击整行展开/收起。 */
function summaryOf(text: string | undefined, limit = 40): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

export function SpawnCard({ message }: MessageRendererProps): ReactNode {
  const ctx = usePluginContext();
  const cwd = useUiStore((s) => s.currentCwd);
  const { t } = useTranslation();
  const payload = parsePayload<SpawnedPayload>(message.content);
  const status = useSubStatus(payload?.subagent);
  const [expanded, setExpanded] = useState(false);
  if (!payload) return null;

  const open = (): void => {
    if (cwd && payload.subagent_session) {
      void ctx.sessions.setContext(cwd, payload.subagent_session);
    }
  };

  const dialogCwd = payload.cwd ?? cwd;
  const dialogTarget = {
    addr: payload.subagent,
    sessionPath: payload.subagent_session,
    name: payload.name ?? payload.task,
    cwd: dialogCwd,
  };

  return (
    <div style={cardStyle}>
      <button
        className="flex items-center gap-2 w-full text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span>{statusIcon(status)}</span>
        <span className="text-[length:var(--font-size-sm)] font-medium">{payload.name ?? payload.task}</span>
        <span className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] flex-1 truncate">
          {expanded ? "" : summaryOf(payload.task)}
        </span>
        <span className="text-[length:var(--font-size-xs)] text-[var(--color-muted)]">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="mt-1">
          <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] whitespace-pre-wrap">{payload.task}</div>
          <div className="flex items-center gap-2 mt-1">
            <button
              className="text-[length:var(--font-size-xs)] text-[var(--color-primary)] hover:underline"
              onClick={open}
            >
              {t("sub-agent.card.open")}
            </button>
            <button
              className="text-[length:var(--font-size-xs)] text-[var(--color-primary)] hover:underline"
              onClick={() => void openDialogFor(ctx, dialogTarget)}
            >
              {t("sub-agent.card.dialog")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SpawnDoneCard({ message }: MessageRendererProps): ReactNode {
  const ctx = usePluginContext();
  const cwd = useUiStore((s) => s.currentCwd);
  const { t } = useTranslation();
  const payload = parsePayload<DonePayload>(message.content);
  const [expanded, setExpanded] = useState(false);
  if (!payload) return null;

  const open = (): void => {
    if (cwd && (payload.subagent_session ?? recSessionPathOf(payload.subagent))) {
      void ctx.sessions.setContext(cwd, payload.subagent_session ?? recSessionPathOf(payload.subagent)!);
    }
  };

  const dialogCwd = payload.cwd ?? cwd;
  const dialogTarget = {
    addr: payload.subagent,
    // 优先卡片自带路径(重启后 orchestrator 账本清空,持久化卡片仍可 reopen)。
    sessionPath: payload.subagent_session ?? recSessionPathOf(payload.subagent),
    name: payload.name ?? payload.subagent,
    cwd: dialogCwd,
  };

  return (
    <div style={cardStyle}>
      <button
        className="flex items-center gap-2 w-full text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span>{statusIcon(payload.status)}</span>
        <span className="text-[length:var(--font-size-sm)] font-medium">{payload.name ?? payload.subagent}</span>
        <span className="text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
          {t(`sub-agent.status.${payload.status}`)}
        </span>
        <span className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] ml-auto">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="mt-1">
          {payload.output_preview && (
            <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] whitespace-pre-wrap">
              {payload.output_preview}
            </div>
          )}
          <div className="flex items-center gap-2 mt-1">
            <button
              className="text-[length:var(--font-size-xs)] text-[var(--color-primary)] hover:underline"
              onClick={open}
            >
              {t("sub-agent.card.open")}
            </button>
            <button
              className="text-[length:var(--font-size-xs)] text-[var(--color-primary)] hover:underline"
              onClick={() => void openDialogFor(ctx, dialogTarget)}
            >
              {t("sub-agent.card.dialog")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function recSessionPathOf(addr: string): string | undefined {
  return peekOrchestrator()?.getSub(addr)?.sessionPath;
}
