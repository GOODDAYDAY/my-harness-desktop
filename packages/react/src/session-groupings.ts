import { useEffect, useState } from "react";
import type { SessionGroupingContribution } from "@my-harness-desktop/shared";
import { useUiStore } from "../../../src/web/stores/ui-store";

export type SessionGroupingItem = SessionGroupingContribution & { pluginId: string };

let cache: { nonce: number; data: SessionGroupingItem[] } | null = null;

export function useSessionGroupings(): SessionGroupingItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<SessionGroupingItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.kernel.slots.sessionGroupings().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}
