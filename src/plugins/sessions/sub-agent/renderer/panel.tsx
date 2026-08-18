import { useEffect, useState, type ReactNode } from "react";
import { ListItem, usePluginContext, usePluginId } from "@my-harness-desktop/react";
import { useTranslation } from "react-i18next";
import type { SubRecord } from "../core/orchestrator";
import { ensureOrchestrator } from "./orchestrator-singleton";
import { openDialogFor } from "./dialog-state";

function elapsed(rec: SubRecord, now: number): string {
  const end = rec.finishedAt ?? now;
  const sec = Math.max(0, Math.round((end - rec.spawnedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

export function SubAgentPanel(): ReactNode {
  const ctx = usePluginContext();
  const pluginId = usePluginId();
  const { t } = useTranslation();
  const orch = ensureOrchestrator(ctx, pluginId);
  const [version, setVersion] = useState(0);
  useEffect(() => orch?.onChange(() => setVersion((v) => v + 1)), [orch]);

  if (!orch) return null;
  const subs = orch.getSubs();
  if (subs.length === 0) {
    return <div className="p-3 text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{t("sub-agent.panel.empty")}</div>;
  }
  const now = Date.now();
  void version;
  return (
    <div className="flex flex-col gap-1 p-2">
      {subs.map((s) => (
        <ListItem key={s.addr}>
          <div className="flex items-center gap-2 w-full">
            <span className="text-[length:var(--font-size-sm)]">{s.name}</span>
            <span className="text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
              {t(`sub-agent.status.${s.status}`)} · {elapsed(s, now)}
            </span>
            <button
              className="ml-auto text-[length:var(--font-size-xs)] text-[var(--color-primary)] hover:underline"
              onClick={() => void openDialogFor(ctx, { addr: s.addr, sessionPath: s.sessionPath, name: s.name, cwd: s.cwd })}
            >
              {t("sub-agent.dialog.open")}
            </button>
            {s.status === "running" && (
              <button
                className="text-[length:var(--font-size-xs)] text-[var(--color-primary)] hover:underline"
                onClick={() => void ctx.bus?.sessionAbort(s.addr)}
              >
                {t("sub-agent.panel.abort")}
              </button>
            )}
          </div>
        </ListItem>
      ))}
    </div>
  );
}
