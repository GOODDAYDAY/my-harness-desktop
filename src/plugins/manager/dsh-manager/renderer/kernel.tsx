// dsh-manager 插件 renderer ——「DSH 入口 · DSH 内核版本管理」TAB（薄 wrapper）。
//
// 内核版本管理走共享 base KernelVersionPage（kernel-design-spec.md §12.4）。dsh 多一个
// 「打开原始文件」（cordis.yml）；配置编辑不在此页（dsh 配置是 YAML，降级为打开原始文件）。
import { KernelVersionPage, type SettingsComponentProps, usePluginContext } from "@my-harness-desktop/react";

export function DshKernelPage(_props: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return <KernelVersionPage api={ctx.dshKernel} i18nPrefix="dsh" openConfigPath="~/.dsh/cordis.yml" />;
}
