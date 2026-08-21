// dsh-manager 插件 renderer ——「DSH 入口 · DSH 拓展」TAB（薄 wrapper）。
//
// 拓展走共享 base ExtensionPage（kernel-design-spec.md §12.6）。dsh 的能力旗标：
// pendingRestart=false（dsh 未按内核追踪待重启会话 → 显式降级，不显示待重启重载区）。
import { ExtensionPage, type SettingsComponentProps, usePluginContext } from "@my-harness-desktop/react";

export function DshExtensionsPage(_props: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return <ExtensionPage api={ctx.kernelPlugins.dsh} i18nPrefix="dshExt" capabilities={{ pendingRestart: false }} />;
}
