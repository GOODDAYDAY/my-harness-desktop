// dsh-manager 插件 renderer ——「DSH 入口 · DSH 内核版本 + 配置」TAB（薄 wrapper）。
//
// 内核版本管理走共享 base KernelVersionPage（kernel-design-spec.md §12.4）。配置表单走共享 base
// KernelConfigForm(schema 驱动):dsh 的非模型命名空间 schema 由适配器(client/dsh/dsh-kernel-config.ts)
// 翻译,数据/保存走框架(manifest kernelConfig="dsh" 声明走 kernelConfig.dsh 的 get/set)。
// 与 pi 配置 TAB 同构——不再「dsh 只打开 cordis.yml」降级,settings.yaml 的非模型段可表单编辑。
import type { SettingsComponentProps } from "@my-harness-desktop/react";
import { KernelConfigForm, KernelVersionPage, usePluginContext } from "@my-harness-desktop/react";

export function DshKernelPage({ refreshSignal, config, onChange }: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return (
    <>
      <KernelVersionPage api={ctx.kernels.dsh} i18nPrefix="dsh" />
      <div style={{ borderTop: "2px solid var(--color-border)" }} />
      <KernelConfigForm api={ctx.kernelConfig.dsh} i18nPrefix="dsh" config={config} onChange={onChange} refreshSignal={refreshSignal} />
    </>
  );
}
