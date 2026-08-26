import { useEffect, useState } from "react";
import type { ComposerPolicyContribution } from "@my-harness-desktop/contract";
import { useUiStore } from "../../../src/web/stores/ui-store";

export type ComposerPolicyItem = ComposerPolicyContribution & { pluginId: string };

let cache: { nonce: number; data: ComposerPolicyItem[] } | null = null;

export function useComposerPolicies(): ComposerPolicyItem[] {
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const [data, setData] = useState<ComposerPolicyItem[]>(
    () => (cache && cache.nonce === pluginsNonce ? cache.data : []),
  );
  useEffect(() => {
    let alive = true;
    void window.kernel.slots.composerPolicies().then((d) => {
      cache = { nonce: pluginsNonce, data: d };
      if (alive) setData(d);
    });
    return () => { alive = false; };
  }, [pluginsNonce]);
  return data;
}
