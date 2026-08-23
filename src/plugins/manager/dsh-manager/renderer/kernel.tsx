// dsh-manager 插件 renderer ——「DSH 入口 · DSH 内核版本管理」TAB（薄 wrapper）。
//
// 内核版本管理走共享 base KernelVersionPage（kernel-design-spec.md §12.4）。dsh 配置是 YAML、
// 降级为「打开原始文件」——由 manifest 的 configFile(cordis.yml) 走框架右上角「打开配置」按钮。
import { KernelVersionPage, usePluginContext } from "@my-harness-desktop/react";

export function DshKernelPage(): React.ReactNode {
  const ctx = usePluginContext();
  return <KernelVersionPage api={ctx.dshKernel} i18nPrefix="dsh" />;
}
