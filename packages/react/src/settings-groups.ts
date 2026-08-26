import { useEffect, useState } from "react";
import type { SettingsGroupContribution } from "@my-harness-desktop/shared";
import { useUiStore } from "../../../src/web/stores/ui-store";

export type SettingsGroupItem = SettingsGroupContribution & { pluginId: string };

let cache: { nonce: number; data: SettingsGroupItem[] } | null = null;

export function useSettingsGroups(): SettingsGroupItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<SettingsGroupItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.kernel.slots.settingsGroups().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}
