// pi-manager 插件 renderer ——「PI 入口 · PI 拓展」TAB（薄 wrapper）。
//
// 拓展走共享 base ExtensionPage（kernel-design-spec.md §12.6）。pi 的能力旗标：
// pendingRestart=true（restartCoordinator 已追踪待重启会话）。
import { ExtensionPage, type SettingsComponentProps, usePluginContext } from "@my-harness-desktop/react";

export function ExtensionManagerPage(_props: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return <ExtensionPage api={ctx.kernelPlugins.pi} i18nPrefix="ext" capabilities={{ pendingRestart: true }} />;
}
