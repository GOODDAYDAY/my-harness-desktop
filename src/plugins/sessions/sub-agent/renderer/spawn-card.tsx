import { useEffect, useState, type ReactNode } from "react";
import { messageContentText } from "@pi-desktop/contract";
import { usePluginContext, useUiStore, type MessageRendererProps } from "@pi-desktop/react";
import { useTranslation } from "react-i18next";
import type { SubStatus } from "../core/orchestrator";
import { peekOrchestrator } from "./orchestrator-singleton";

interface SpawnedPayload {
  subagent: string;
  subagent_session: string;
  task: string;
  name?: string;
  tool_config?: unknown;
}

interface DonePayload {
  subagent: string;
  name?: string;
  status: SubStatus;
  output_preview?: string;
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
  padding: "8px 12px",
  margin: "4px 0",
  maxWidth: "480px",
} as const;

export function SpawnCard({ message }: MessageRendererProps): ReactNode {
  const ctx = usePluginContext();
  const cwd = useUiStore((s) => s.currentCwd);
  const { t } = useTranslation();
  const payload = parsePayload<SpawnedPayload>(message.content);
  const status = useSubStatus(payload?.subagent);
  if (!payload) return null;

  const open = (): void => {
    if (cwd && payload.subagent_session) {
      void ctx.sessions.setContext(cwd, payload.subagent_session);
    }
  };

  return (
    <div style={cardStyle}>
      <div className="flex items-center gap-2">
        <span>{statusIcon(status)}</span>
        <span className="text-[length:var(--font-size-sm)] font-medium">{payload.name ?? payload.task}</span>
        <button
          className="ml-auto text-[length:var(--font-size-xs)] text-[var(--color-primary)] hover:underline"
          onClick={open}
        >
          {t("sub-agent.card.open")}
        </button>
      </div>
      <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] mt-1">{payload.task}</div>
    </div>
  );
}

export function SpawnDoneCard({ message }: MessageRendererProps): ReactNode {
  const { t } = useTranslation();
  const payload = parsePayload<DonePayload>(message.content);
  if (!payload) return null;
  return (
    <div style={cardStyle}>
      <div className="flex items-center gap-2">
        <span>{statusIcon(payload.status)}</span>
        <span className="text-[length:var(--font-size-sm)] font-medium">{payload.name ?? payload.subagent}</span>
        <span className="ml-auto text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
          {t(`sub-agent.status.${payload.status}`)}
        </span>
      </div>
      {payload.output_preview && (
        <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] mt-1 whitespace-pre-wrap">
          {payload.output_preview}
        </div>
      )}
    </div>
  );
}
